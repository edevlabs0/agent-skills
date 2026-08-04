#!/usr/bin/env node

// Lean Codex review primitive: hand Codex a brief, it reviews the repository read-only and returns
// a light structured verdict. No git-tree restrictions, no gates, no baseline scoping, no handback
// contract — the caller decides when to run it, what scope the brief covers, and what to report.
// The one guarantee kept is integrity: every round is verified to have run read-only, at the pinned
// model, in the target repo. Reuse a --state-dir to resume the same Codex thread for rework rounds.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(SCRIPT_DIR, "../assets/reviewer-verdict.schema.json");
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const MODEL_PATTERN = /^[A-Za-z0-9._:-]+$/;
const EFFORTS = ["minimal", "low", "medium", "high"];

class RelayError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.exitCode = exitCode;
  }
}

function usage() {
  return `Usage:
  codex-review.mjs review --repo <absolute> --brief <absolute> --model <model> [--effort minimal|low|medium|high] [--state-dir <absolute>] [--schema <absolute>] [--timeout-ms <ms>]
  codex-review.mjs doctor [--schema <absolute>]

Resume a thread for a rework round by reusing the same --state-dir; omit it for a one-shot review.`;
}

function parseArguments(argumentsList) {
  const command = argumentsList.shift();
  if (!command) throw new RelayError(usage());
  const options = {};
  while (argumentsList.length) {
    const flag = argumentsList.shift();
    if (!flag?.startsWith("--") || !argumentsList.length) throw new RelayError(`Invalid argument: ${flag}\n${usage()}`);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (Object.hasOwn(options, key)) throw new RelayError(`Duplicate option: ${flag}`);
    options[key] = argumentsList.shift();
  }
  return { command, options };
}

function requiredOption(options, name) {
  const optionValue = options[name];
  if (!optionValue) throw new RelayError(`Missing --${name.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`);
  return optionValue;
}

function absolutePath(pathText, label) {
  if (!isAbsolute(pathText)) throw new RelayError(`${label} must be an absolute path: ${pathText}`);
  return resolve(pathText);
}

function normalizedPath(pathText) {
  const normalized = resolve(pathText).replace(/[\\/]+$/, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function executeSync(command, commandArguments, workingDirectory) {
  const execution = spawnSync(command, commandArguments, {
    cwd: workingDirectory, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (execution.error) throw new RelayError(`Cannot run ${command}: ${execution.error.message}`);
  if (execution.status !== 0) {
    const failureText = (execution.stderr || execution.stdout).trim();
    throw new RelayError(`${command} ${commandArguments.join(" ")} failed (${execution.status}): ${failureText}`);
  }
  return { stdout: execution.stdout || "", stderr: execution.stderr || "" };
}

function codexBinary() {
  if (process.env.CODEX_BIN) return process.env.CODEX_BIN;
  if (process.platform !== "win32" || !process.env.LOCALAPPDATA) return "codex";
  const desktopBinary = join(process.env.LOCALAPPDATA, "Programs", "OpenAI", "Codex", "bin", "codex.exe");
  return existsSync(desktopBinary) ? desktopBinary : "codex";
}

function repositoryRoot(repositoryInput) {
  if (!existsSync(repositoryInput) || !statSync(repositoryInput).isDirectory()) throw new RelayError(`Repository does not exist: ${repositoryInput}`);
  return realpathSync(executeSync("git", ["rev-parse", "--show-toplevel"], repositoryInput).stdout.trim());
}

// --- Thread + turn_context verification (the one integrity guarantee we keep) ---

function extractThreadId(eventsText) {
  for (const eventLine of eventsText.split(/\r?\n/)) {
    if (!eventLine.trim()) continue;
    try {
      const event = JSON.parse(eventLine);
      const threadId = event.thread_id ?? event.threadId ?? event.thread?.id ?? event.thread?.thread_id;
      if (threadId) return threadId;
    } catch { /* non-JSON progress line */ }
  }
  return null;
}

function codexSessionRoot() {
  const codexHome = process.env.CODEX_HOME ? resolve(process.env.CODEX_HOME) : join(homedir(), ".codex");
  return join(codexHome, "sessions");
}

function findSessionFiles(searchRoot, threadId, matchingFiles = []) {
  if (!existsSync(searchRoot)) return matchingFiles;
  for (const directoryEntry of readdirSync(searchRoot, { withFileTypes: true })) {
    const entryPath = join(searchRoot, directoryEntry.name);
    if (directoryEntry.isDirectory()) findSessionFiles(entryPath, threadId, matchingFiles);
    else if (directoryEntry.isFile() && directoryEntry.name.includes(threadId) && directoryEntry.name.endsWith(".jsonl")) matchingFiles.push(entryPath);
  }
  return matchingFiles;
}

function latestTurnContext(threadId, earliestTimestamp) {
  const matchingContexts = [];
  for (const sessionFile of findSessionFiles(codexSessionRoot(), threadId)) {
    for (const eventLine of readFileSync(sessionFile, "utf8").split(/\r?\n/)) {
      if (!eventLine.trim()) continue;
      try {
        const event = JSON.parse(eventLine);
        if (event.type === "turn_context" && Date.parse(event.timestamp) >= earliestTimestamp - 5000) {
          matchingContexts.push({ timestamp: event.timestamp, sessionFile, ...event.payload });
        }
      } catch { /* incomplete trailing line while flushing */ }
    }
  }
  matchingContexts.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return matchingContexts.at(-1) || null;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

async function waitForTurnContext(threadId, earliestTimestamp) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const turnContext = latestTurnContext(threadId, earliestTimestamp);
    if (turnContext) return turnContext;
    await delay(500);
  }
  return null;
}

// --- Review ---

function reviewerPrompt(brief) {
  return `<role>
You are an independent, read-only reviewer. You cannot modify, create, delete, stage, commit, or push
files, and must not run commands that write caches, logs, builds, or test artifacts. You may read any
file and run read-only commands (e.g. git diff, grep) to inspect the work. Report only.
</role>
<standing_rules>
- Read the relevant repository files before judging.
- Judge against the author's stated goal and the project's constraints, not your preferred style.
- Correctness > security > data integrity > compatibility > maintainability.
- Do not report naming, formatting, or style preferences.
- blocker = unsafe to ship; major = materially incomplete or unreliable; minor = non-blocking.
- Approve sound work. Do not manufacture findings.
</standing_rules>
<brief>
${brief}
</brief>
Return only the JSON object required by the supplied output schema.`;
}

function codexArguments({ model, effort, schemaPath, finalPath, repository, threadId }) {
  const fixedConfiguration = ["-c", 'sandbox_mode="read-only"', "-c", 'approval_policy="never"'];
  const effortConfiguration = effort ? ["-c", `model_reasoning_effort="${effort}"`] : [];
  if (threadId) {
    // `codex exec resume` rejects `--color` (verified on codex-cli 0.144.5); every safety-relevant
    // argument — sandbox_mode, approval_policy, -m, --output-schema — is accepted here.
    return ["exec", "resume", threadId, ...fixedConfiguration, ...effortConfiguration,
      "--json", "-m", model, "--output-schema", schemaPath, "-o", finalPath, "-"];
  }
  return ["exec", "--json", "--color", "never", "-s", "read-only", ...fixedConfiguration, ...effortConfiguration,
    "-m", model, "--output-schema", schemaPath, "-o", finalPath, "-C", repository, "-"];
}

function validateVerdict(verdictDocument) {
  if (!verdictDocument || typeof verdictDocument !== "object" || Array.isArray(verdictDocument)) throw new RelayError("Verdict must be a JSON object", 5);
  if (!["approve", "changes_required"].includes(verdictDocument.verdict)) throw new RelayError(`Invalid verdict: ${verdictDocument.verdict}`, 5);
  if (typeof verdictDocument.summary !== "string" || !verdictDocument.summary.trim()) throw new RelayError("summary is required", 5);
  if (!Array.isArray(verdictDocument.findings)) throw new RelayError("findings must be an array", 5);
  for (const finding of verdictDocument.findings) {
    for (const field of ["severity", "location", "problem", "required_change"]) {
      if (typeof finding[field] !== "string" || !finding[field].trim()) throw new RelayError(`Finding field ${field} is required`, 5);
    }
    if (!["blocker", "major", "minor"].includes(finding.severity)) throw new RelayError(`Invalid severity: ${finding.severity}`, 5);
  }
  if (verdictDocument.verdict === "changes_required" && !verdictDocument.findings.length) throw new RelayError("changes_required needs at least one finding", 5);
  if (verdictDocument.verdict === "approve" && verdictDocument.findings.some((finding) => finding.severity !== "minor")) throw new RelayError("approve cannot carry blocker or major findings", 5);
}

function invokeCodex(invocation) {
  return new Promise((resolveInvocation, rejectInvocation) => {
    const child = spawn(codexBinary(), invocation.arguments, {
      cwd: invocation.repository, windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutText = "";
    let stderrText = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, invocation.timeoutMilliseconds);
    child.stdout.on("data", (chunk) => { stdoutText += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderrText += chunk.toString("utf8"); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectInvocation(new RelayError(`Failed to launch Codex: ${error.message}`, 3));
    });
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      writeFileSync(invocation.eventsPath, stdoutText, "utf8");
      writeFileSync(invocation.stderrPath, stderrText, "utf8");
      resolveInvocation({ exitCode, signal, timedOut, stdoutText, stderrText });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(invocation.prompt, "utf8");
  });
}

function readThreadId(stateDirectory) {
  const threadFile = join(stateDirectory, "thread.json");
  if (!existsSync(threadFile)) return null;
  return JSON.parse(readFileSync(threadFile, "utf8")).threadId || null;
}

async function review(options) {
  const repository = repositoryRoot(absolutePath(requiredOption(options, "repo"), "--repo"));
  const briefPath = absolutePath(requiredOption(options, "brief"), "--brief");
  if (!existsSync(briefPath) || !statSync(briefPath).isFile()) throw new RelayError(`Brief not found: ${briefPath}`);
  const brief = readFileSync(briefPath, "utf8");
  if (!brief.trim()) throw new RelayError("Brief is empty");
  const model = requiredOption(options, "model");
  if (!MODEL_PATTERN.test(model)) throw new RelayError(`Unsafe or invalid model name: ${model}`);
  const effort = options.effort ? options.effort.toLowerCase() : null;
  if (effort && !EFFORTS.includes(effort)) throw new RelayError(`Invalid --effort: ${options.effort} (expected ${EFFORTS.join(", ")})`);
  const schemaPath = options.schema ? absolutePath(options.schema, "--schema") : SCHEMA_PATH;
  if (!existsSync(schemaPath)) throw new RelayError(`Schema not found: ${schemaPath}`);
  const timeoutMilliseconds = options.timeoutMs ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMilliseconds) || timeoutMilliseconds < 10000 || timeoutMilliseconds > 3600000) throw new RelayError("--timeout-ms must be an integer from 10000 to 3600000");

  const stateDirectory = options.stateDir
    ? absolutePath(options.stateDir, "--state-dir")
    : mkdtempSync(join(tmpdir(), "codex-review-"));
  mkdirSync(stateDirectory, { recursive: true });
  const priorThreadId = readThreadId(stateDirectory);

  const roundsDirectory = join(stateDirectory, "rounds");
  mkdirSync(roundsDirectory, { recursive: true });
  const roundNumber = readdirSync(roundsDirectory).length + 1;
  const roundDirectory = join(roundsDirectory, String(roundNumber).padStart(2, "0"));
  mkdirSync(roundDirectory, { recursive: true });
  const finalPath = join(roundDirectory, "verdict.json");
  const eventsPath = join(roundDirectory, "events.jsonl");
  const stderrPath = join(roundDirectory, "stderr.txt");
  const promptPath = join(roundDirectory, "prompt.txt");
  const prompt = reviewerPrompt(brief);
  writeFileSync(promptPath, prompt, "utf8");

  const startedAt = Date.now();
  const execution = await invokeCodex({
    arguments: codexArguments({ model, effort, schemaPath, finalPath, repository, threadId: priorThreadId }),
    repository, timeoutMilliseconds, prompt, eventsPath, stderrPath,
  });

  if (execution.timedOut) throw new RelayError(`Codex timed out after ${timeoutMilliseconds} ms; see ${stderrPath}`, 3);
  if (execution.exitCode !== 0) throw new RelayError(`Codex exited ${execution.exitCode}${execution.signal ? ` (${execution.signal})` : ""}; see ${stderrPath}`, 3);

  const observedThreadId = extractThreadId(execution.stdoutText) || priorThreadId;
  if (!observedThreadId) throw new RelayError("Codex output did not expose a thread id", 4);
  if (priorThreadId && observedThreadId !== priorThreadId) throw new RelayError(`Thread mismatch: expected ${priorThreadId}, observed ${observedThreadId}`, 4);
  if (!existsSync(finalPath)) throw new RelayError("Codex produced no verdict file", 5);

  const turnContext = await waitForTurnContext(observedThreadId, startedAt);
  if (!turnContext) throw new RelayError("Could not verify Codex turn_context", 4);
  if (turnContext.sandbox_policy?.type !== "read-only") throw new RelayError(`Observed sandbox is ${turnContext.sandbox_policy?.type}, not read-only`, 4);
  if (turnContext.model !== model) throw new RelayError(`Observed model ${turnContext.model} differs from required ${model}`, 4);
  if (normalizedPath(turnContext.cwd) !== normalizedPath(repository)) throw new RelayError(`Observed cwd ${turnContext.cwd} differs from ${repository}`, 4);

  const verdictDocument = JSON.parse(readFileSync(finalPath, "utf8"));
  validateVerdict(verdictDocument);

  writeFileSync(join(stateDirectory, "thread.json"), `${JSON.stringify({ threadId: observedThreadId, model }, null, 2)}\n`, "utf8");

  const result = {
    status: "reviewed", verdict: verdictDocument.verdict, summary: verdictDocument.summary,
    findings: verdictDocument.findings, round: roundNumber, threadId: observedThreadId,
    observedModel: turnContext.model, observedSandbox: turnContext.sandbox_policy.type,
    stateDir: stateDirectory, verdictPath: finalPath, promptPath, eventsPath,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function doctor(options) {
  const checks = [];
  let allPassed = true;
  const record = (name, ok, detail) => { checks.push({ name, status: ok ? "PASS" : "FAIL", detail }); if (!ok) allPassed = false; };

  const nodeMajor = Number(process.version.slice(1).split(".")[0]);
  record("Node.js version", nodeMajor >= 18, `${process.version} (requires >= 18)`);

  let gitOk = false;
  try { record("Git", true, executeSync("git", ["--version"], process.cwd()).stdout.trim()); gitOk = true; }
  catch { record("Git", false, "not found"); }

  let codexOk = false;
  try {
    const version = executeSync(codexBinary(), ["--version"], process.cwd()).stdout.trim();
    record("Codex CLI", true, version);
    codexOk = true;
  } catch { record("Codex CLI", false, "not found"); }

  if (codexOk) {
    try { executeSync(codexBinary(), ["login", "status"], process.cwd()); record("Codex auth", true, "authenticated"); }
    catch { record("Codex auth", false, "not authenticated (run: codex login)"); }
    try {
      // The harness sets the sandbox via `-c sandbox_mode=...` (a --config override) plus
      // `-s read-only`, pins output with --output-schema, and resumes threads with `exec resume`.
      // Check for those flags, not the literal "sandbox_mode" string (absent from newer help text).
      const helpText = executeSync(codexBinary(), ["exec", "--help"], process.cwd()).stdout;
      const has = (token) => helpText.includes(token);
      const ok = has("--output-schema") && has("--sandbox") && has("--config") && has("resume");
      record("Codex required flags", ok, `--output-schema=${has("--output-schema")}, --sandbox=${has("--sandbox")}, --config=${has("--config")}, resume=${has("resume")}`);
    } catch (error) { record("Codex required flags", false, error.message); }
  }

  const schemaToUse = options.schema ? absolutePath(options.schema, "--schema") : SCHEMA_PATH;
  try { JSON.parse(readFileSync(schemaToUse, "utf8")); record("Schema", true, schemaToUse); }
  catch (error) { record("Schema", false, `${schemaToUse}: ${error.message}`); }

  void gitOk;
  process.stdout.write(`${JSON.stringify({ status: allPassed ? "ready" : "not-ready", checks }, null, 2)}\n`);
  if (!allPassed) process.exit(1);
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "review") return review(options);
  if (command === "doctor") return doctor(options);
  throw new RelayError(`Unknown command: ${command}\n${usage()}`);
}

main().catch((error) => {
  process.stderr.write(`codex-review: ${error.message}\n`);
  process.exit(error instanceof RelayError ? error.exitCode : 1);
});
