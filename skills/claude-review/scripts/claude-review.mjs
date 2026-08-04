#!/usr/bin/env node
/**
 * claude-review · claude-review.mjs
 *
 * Run an INDEPENDENT, READ-ONLY code/plan review in a SEPARATE `claude` CLI
 * process pinned to a model you choose — the analog of codex-review.mjs, but the
 * reviewer is a fresh Claude process instead of Codex. This is what decouples the
 * reviewer's model from the orchestrator's: the orchestrator may be Opus while
 * the review runs on Fable, because the reviewer is its own OS process launched
 * with `claude --model <id>`, not an in-process Agent-tool subagent that inherits
 * the session model.
 *
 * The whole loop:
 *   capture the review target (git diff) → launch `claude -p` read-only, pinned
 *   model, brief on stdin → capture its final message → extract + validate the
 *   verdict JSON against reviewer-verdict.schema.json → persist the round →
 *   print a structured result. Resume the same thread for a rework round.
 *
 * Trust posture: no network of its own, no credentials, no telemetry, Node
 * built-ins only. It launches `claude` (which authenticates and calls the API
 * exactly as it does at the terminal) and runs read-only `git` inspection
 * commands. The child runs in Claude's `plan` permission mode with only Read,
 * Glob, and Grep — no Edit/Write/shell/MCP/skills/commands — so it cannot mutate
 * the repo; a git-porcelain tripwire (readOnlyViolation) is recorded as a
 * backstop. Independence is BY CONSTRUCTION (fresh non-session process, pinned
 * model, read-only tools), NOT cryptographically verified the way Codex verifies
 * its observed model + sandbox. Label the verdict accordingly.
 *
 * Usage:
 *   node claude-review.mjs review  --repo <dir> --brief <file> --model <id> [options]
 *   node claude-review.mjs doctor
 *   node claude-review.mjs --help
 *
 * review options:
 *   --repo <dir>          Git repository to review in (required).
 *   --brief <file>        Brief describing the work and what to scrutinize (required).
 *   --model <id>          Claude model alias or id to PIN for the reviewer, e.g.
 *                         `fable`, `claude-fable-5`, `sonnet` (required). Make it
 *                         DIFFER from the implementer's model.
 *   --mode code|plan      code (default): capture and review a git diff. plan:
 *                         no diff; review the plan carried in the brief.
 *   --target <spec>       code mode only. `working` (default) = `git diff HEAD`
 *                         plus untracked files. `A..B` = `git diff A..B`. Any
 *                         other value = a commit reviewed via `git show <value>`.
 *   --effort <level>      Reviewer reasoning effort: low|medium|high|xhigh|max.
 *                         Passed to `claude --effort`. Default: high.
 *   --state-dir <dir>     Persist rounds/agent.json here; reuse across rounds.
 *                         Default: a fresh temp dir (printed).
 *   --resume              Resume the thread recorded in <state-dir>/agent.json.
 *   --session <id>        Resume this explicit session id (overrides agent.json).
 *   --schema <file>       Verdict JSON Schema. Default: ../assets/reviewer-verdict.schema.json.
 *   --timeout-ms <ms>     Watchdog for the claude process. Default: 900000 (15m).
 *   -h, --help            Show this help.
 *
 * Exit codes (mirroring codex-review's contract):
 *   0  a valid verdict was produced (approve OR changes_required).
 *   2  usage error (bad flags) — nothing launched.
 *   3  transport: claude unavailable/unauthenticated/timeout/non-zero — retry once.
 *   5  contract: empty review target, or the final message was not one valid
 *      schema-conforming verdict — do NOT retry, the same call fails identically.
 *
 * Artifacts under <state-dir>/rounds/<NN>/:
 *   brief.txt      the brief sent for this round
 *   prompt.txt     the exact stdin prompt handed to claude
 *   target.diff    the captured review target (code mode)
 *   events.jsonl   raw claude stream
 *   report.md      the child's full final message
 *   verdict.json   the extracted, validated verdict
 * plus <state-dir>/agent.json { sessionId, model, effort } for resume.
 */

import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  accessSync,
  appendFileSync,
  constants as fsConstants,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = resolve(HERE, "..", "assets", "reviewer-verdict.schema.json");
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@\/\[\]-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const MAX_TIMER_MS = 2_147_483_647;

// Exit codes — kept parallel to codex-review so callers branch identically.
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_TRANSPORT = 3;
const EXIT_CONTRACT = 5;

function die(message, code = EXIT_USAGE) {
  process.stderr.write(`claude-review: ${message}\n`);
  process.exit(code);
}

/* ------------------------------- arg parsing ------------------------------ */

function parseArgs(argv) {
  const opts = {
    repo: null,
    brief: null,
    model: null,
    mode: "code",
    target: "working",
    effort: "high",
    stateDir: null,
    resume: false,
    session: null,
    schema: DEFAULT_SCHEMA,
    timeoutMs: 900_000,
    claudeBin: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const value = argv[i + 1];
      if (value === undefined) die(`${arg} requires a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "-h":
      case "--help":
        process.stdout.write(headerComment());
        process.exit(0);
        break;
      case "--repo": opts.repo = resolve(next()); break;
      case "--brief": opts.brief = resolve(next()); break;
      case "--model": opts.model = next(); break;
      case "--mode": opts.mode = next(); break;
      case "--target": opts.target = next(); break;
      case "--effort": opts.effort = next(); break;
      case "--state-dir": opts.stateDir = resolve(next()); break;
      case "--resume": opts.resume = true; break;
      case "--session": opts.session = next(); break;
      case "--schema": opts.schema = resolve(next()); break;
      case "--timeout-ms": opts.timeoutMs = Number(next()); break;
      case "--claude-bin": opts.claudeBin = resolve(next()); break;
      default:
        die(`unknown option: ${arg}`);
    }
  }

  if (!opts.repo) die("--repo <dir> is required");
  if (!opts.brief) die("--brief <file> is required");
  if (!opts.model) die("--model <id> is required (pin a model that differs from the implementer's)");
  if (!SAFE_MODEL.test(opts.model)) die("--model contains unsupported characters");
  if (opts.mode !== "code" && opts.mode !== "plan") die(`--mode must be code|plan, got "${opts.mode}"`);
  if (!EFFORT_LEVELS.has(opts.effort)) die(`--effort must be one of ${[...EFFORT_LEVELS].join(", ")}`);
  if (opts.session !== null && !SAFE_SESSION.test(opts.session)) die("--session contains unsupported characters");
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0 || opts.timeoutMs > MAX_TIMER_MS) {
    die("--timeout-ms must be a positive integer within range");
  }
  try {
    if (!statSync(opts.repo).isDirectory()) die(`--repo is not a directory: ${opts.repo}`);
  } catch { die(`--repo not found: ${opts.repo}`); }
  if (!existsSync(opts.brief)) die(`--brief file not found: ${opts.brief}`);
  if (!existsSync(opts.schema)) die(`--schema file not found: ${opts.schema}`);
  return opts;
}

function headerComment() {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  return match ? `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n` : "claude-review.mjs\n";
}

/* --------------------------- claude CLI launcher -------------------------- */
// Ported from claude-delegate/relay.mjs: resolve `claude` on PATH, handle the
// Windows .cmd npm shim through cmd.exe with serialized arguments.

function environmentValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (process.platform !== "win32") return undefined;
  const key = Object.keys(env).find((c) => c.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function childEnvironment() {
  const env = { ...process.env };
  if (process.platform === "win32") {
    for (const key of Object.keys(env)) if (key.toUpperCase() === "CLAUDECODE") delete env[key];
  } else {
    delete env.CLAUDECODE;
  }
  return env;
}

// Well-known install locations to probe when PATH resolution fails. The native
// Claude Code installer drops the binary in ~/.local/bin, which is often absent
// from the Windows process PATH a spawned child inherits (git-bash injects it,
// cmd/node do not). An explicit override wins over everything.
function fallbackClaudeDirs(env) {
  const home = environmentValue(env, "HOME") || environmentValue(env, "USERPROFILE") || homedir();
  const dirs = [];
  if (home) {
    dirs.push(join(home, ".local", "bin"));
    dirs.push(join(home, ".claude", "local"));
  }
  return dirs;
}

function probeDir(dir, cwd, exts) {
  const resolvedDir = resolve(cwd, dir || ".");
  if (process.platform === "win32") {
    for (const ext of exts) {
      const candidate = join(resolvedDir, `claude${ext}`);
      try {
        if (statSync(candidate).isFile()) {
          return { path: candidate, kind: ext === ".cmd" || ext === ".bat" ? "cmd" : "direct" };
        }
      } catch { /* keep searching */ }
    }
    return null;
  }
  const candidate = join(resolvedDir, "claude");
  try {
    accessSync(candidate, fsConstants.X_OK);
    if (statSync(candidate).isFile()) return { path: candidate, kind: "direct" };
  } catch { /* keep searching */ }
  return null;
}

function resolveClaudeLauncher(env, cwd) {
  // 1. Explicit override — a flag value or env var pointing at the binary.
  const override = env.__claudeReviewCliOverride || environmentValue(env, "CLAUDE_REVIEW_CLI");
  if (override) {
    try {
      if (statSync(override).isFile()) {
        const isCmd = /\.(cmd|bat)$/i.test(override);
        return { path: override, kind: isCmd ? "cmd" : "direct" };
      }
    } catch { /* fall through to PATH search */ }
  }

  const exts = (environmentValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD")
    .split(";").map((v) => v.trim().toLowerCase()).filter(Boolean);
  const pathValue = environmentValue(env, "PATH");
  const pathEntries = pathValue
    ? pathValue.split(delimiter).map((e) => e.replace(/^"(.*)"$/, "$1"))
    : [];

  // 2. PATH, then 3. well-known fallback dirs.
  for (const entry of [...pathEntries, ...fallbackClaudeDirs(env)]) {
    const found = probeDir(entry, cwd, exts);
    if (found) return found;
  }
  return null;
}

function quoteCmdArgument(value) {
  if (/[\0\r\n"%!]/.test(value)) {
    throw new Error("cannot safely serialize an argument containing %, !, a quote, or a newline for the npm claude.cmd launch");
  }
  return `"${value}"`;
}

function launchSpec(launcher, argv, env) {
  if (launcher.kind === "direct") {
    return { command: launcher.path, argv, windowsVerbatimArguments: false };
  }
  const commandLine = [launcher.path, ...argv].map(quoteCmdArgument).join(" ");
  const comspec = environmentValue(env, "COMSPEC") || "cmd.exe";
  return {
    command: comspec,
    argv: ["/d", "/v:off", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true,
  };
}

function claudeVersion(launcher, env, cwd) {
  try {
    const spec = launchSpec(launcher, ["--version"], env);
    const probe = spawnSync(spec.command, spec.argv, {
      cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    if (probe.error && probe.error.code === "ENOENT") return null;
    if (probe.status !== 0) return "unknown";
    return String(probe.stdout || "").trim() || "unknown";
  } catch { return "unknown"; }
}

/* ----------------------------- git inspection ---------------------------- */

function git(repo, args) {
  return execFileSync("git", args, {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024,
  });
}

function tryGit(repo, args) {
  try { return git(repo, args); } catch { return null; }
}

function porcelain(repo) {
  const out = tryGit(repo, ["status", "--porcelain"]);
  return out === null ? null : out.split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

// Build the exact change under review as a single patch string. Returns
// { patch, untracked: string[] } or throws on a hard git failure.
function captureTarget(repo, target) {
  if (target.includes("..")) {
    const patch = git(repo, ["diff", target]);
    return { patch, untracked: [], describe: `git diff ${target}` };
  }
  if (target !== "working") {
    const patch = git(repo, ["show", target]);
    return { patch, untracked: [], describe: `git show ${target}` };
  }
  // working: staged+unstaged vs HEAD, plus untracked file contents.
  let patch = git(repo, ["diff", "HEAD"]);
  const status = porcelain(repo) || [];
  const untracked = status
    .filter((line) => line.startsWith("??"))
    .map((line) => line.slice(3).replace(/^"(.*)"$/, "$1"));
  for (const file of untracked) {
    const extra = tryGit(repo, ["diff", "--no-index", "--", "/dev/null", file]);
    if (extra) patch += (patch.endsWith("\n") || patch === "" ? "" : "\n") + extra;
  }
  return { patch, untracked, describe: "git diff HEAD (+ untracked files)" };
}

/* --------------------------- prompt construction ------------------------- */

function schemaContract() {
  return [
    "Return EXACTLY ONE JSON object and NOTHING ELSE — no prose, no markdown fences, no preamble.",
    "It must conform to this shape:",
    '  { "verdict": "approve" | "changes_required",',
    '    "summary": "<one short paragraph: what you reviewed and the overall judgment>",',
    '    "findings": [ { "severity": "blocker"|"major"|"minor",',
    '                    "location": "<file:line or precise locator>",',
    '                    "problem": "<what is wrong and why it matters>",',
    '                    "required_change": "<the concrete change that resolves it>" } ] }',
    "findings MUST be empty if and only if verdict is \"approve\". Each finding is an",
    "actionable defect, not a style preference. Do not approve if any blocker or major stands.",
  ].join("\n");
}

function buildPrompt(opts, round, brief) {
  const lines = [];
  lines.push("You are an INDEPENDENT CODE REVIEWER running in a fresh, isolated process.");
  lines.push("You have NO access to the implementer's chat or reasoning — only what is below plus the repository.");
  lines.push("You are STRICTLY READ-ONLY: use only Read, Grep, and Glob. Never edit, write, or modify any file.");
  lines.push(`The repository under review is: ${opts.repo}`);
  lines.push("");
  if (opts.mode === "code") {
    lines.push(`The EXACT change under review (${round.describe}) is in this patch file — read it FIRST:`);
    lines.push(`  ${round.targetPath}`);
    if (round.untracked.length) {
      lines.push(`It includes these untracked files: ${round.untracked.join(", ")}`);
    }
    lines.push("Then read any file in the repository you need for context around the change.");
    lines.push("An EMPTY diff is NOT an approval: if the patch is empty, say so in `summary` and return `changes_required`.");
  } else {
    lines.push("This is a PLAN review — the plan under review is carried in the brief below. Judge the plan, not a diff.");
  }
  lines.push("");
  if (opts.effort === "high" || opts.effort === "xhigh" || opts.effort === "max") {
    lines.push("Think deeply and adversarially before deciding — challenge the design, hunt for the failure that breaks it.");
  } else {
    lines.push("Do a focused pass and decide.");
  }
  lines.push("");
  lines.push("=== BRIEF (what was done and what to scrutinize) ===");
  lines.push(brief.trim());
  lines.push("=== END BRIEF ===");
  lines.push("");
  lines.push(schemaContract());
  return lines.join("\n");
}

/* -------------------------- stream-json scanner -------------------------- */
// Ported from relay.mjs: brace-aware NDJSON scanner tolerant of chunk splits.

function makeEventScanner(onObject) {
  let buffer = "", index = 0, depth = 0, start = -1, inString = false, escaped = false;
  return (text) => {
    if (!text) return;
    buffer += text;
    while (index < buffer.length) {
      const ch = buffer[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        index += 1; continue;
      }
      if (ch === '"') { if (depth > 0) inString = true; index += 1; continue; }
      if (ch === "{") { if (depth === 0) start = index; depth += 1; }
      else if (ch === "}" && depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          const candidate = buffer.slice(start, index + 1);
          try { onObject(JSON.parse(candidate)); } catch { /* keep raw only */ }
          buffer = buffer.slice(index + 1); index = 0; start = -1; inString = false; escaped = false;
          continue;
        }
      }
      index += 1;
    }
    if (depth === 0) { buffer = ""; index = 0; start = -1; }
    else if (start > 0) { buffer = buffer.slice(start); index -= start; start = 0; }
  };
}

function eventSessionId(event) {
  return event.session_id ?? event.sessionId ??
    (event.session && (event.session.id ?? event.session.session_id)) ?? null;
}

/* --------------------------- verdict validation -------------------------- */

// Extract the reviewer's verdict object from its final message. Prefer a clean
// whole-string parse; otherwise take the LAST balanced {...} that parses and
// carries a `verdict` key (guards against prose wrapping the JSON).
function extractVerdict(finalText) {
  const trimmed = String(finalText || "").trim()
    .replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  const direct = tryParse(trimmed);
  if (direct && typeof direct === "object" && "verdict" in direct) return direct;
  let best = null;
  const scan = makeEventScanner((obj) => { if (obj && typeof obj === "object" && "verdict" in obj) best = obj; });
  scan(trimmed);
  return best;
}

function tryParse(text) { try { return JSON.parse(text); } catch { return null; } }

function validateVerdict(v) {
  const errors = [];
  if (!v || typeof v !== "object") return ["final message did not contain a JSON verdict object"];
  if (v.verdict !== "approve" && v.verdict !== "changes_required") {
    errors.push('`verdict` must be "approve" or "changes_required"');
  }
  if (typeof v.summary !== "string" || v.summary.trim() === "") errors.push("`summary` must be a non-empty string");
  if (!Array.isArray(v.findings)) {
    errors.push("`findings` must be an array");
  } else {
    if (v.verdict === "approve" && v.findings.length !== 0) errors.push("`findings` must be empty when verdict is approve");
    if (v.verdict === "changes_required" && v.findings.length === 0) errors.push("`findings` must be non-empty when verdict is changes_required");
    v.findings.forEach((f, i) => {
      if (!f || typeof f !== "object") { errors.push(`findings[${i}] is not an object`); return; }
      if (!["blocker", "major", "minor"].includes(f.severity)) errors.push(`findings[${i}].severity invalid`);
      for (const key of ["location", "problem", "required_change"]) {
        if (typeof f[key] !== "string" || f[key].trim() === "") errors.push(`findings[${i}].${key} must be a non-empty string`);
      }
    });
  }
  return errors;
}

/* ------------------------------ round layout ----------------------------- */

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function nextRoundDir(stateDir) {
  const roundsRoot = join(stateDir, "rounds");
  mkdirSync(roundsRoot, { recursive: true });
  let max = 0;
  for (const name of readdirSync(roundsRoot)) {
    const n = Number(name);
    if (Number.isInteger(n) && n > max) max = n;
  }
  const nn = String(max + 1).padStart(2, "0");
  const dir = join(roundsRoot, nn);
  mkdirSync(dir, { recursive: true });
  return { dir, nn };
}

function readRecordedSession(stateDir) {
  const path = join(stateDir, "agent.json");
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return null; }
}

function writeJsonAtomic(path, value) {
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

/* --------------------------------- run ----------------------------------- */

// Emit a structured result on stdout, then exit. Used for every outcome that
// happens after arg-validation so a caller can always parse stdout for `status`.
function emitAndExit(result, exit) {
  process.stdout.write(`${JSON.stringify({ schema: "claude-review.result.v1", ...result }, null, 2)}\n`);
  if (result.error) process.stderr.write(`claude-review: ${result.status} — ${result.error}\n`);
  process.exit(exit);
}

function runReview(opts) {
  const env = childEnvironment();
  if (opts.claudeBin) env.__claudeReviewCliOverride = opts.claudeBin;
  const launcher = resolveClaudeLauncher(env, opts.repo);
  const version = launcher ? claudeVersion(launcher, env, opts.repo) : null;
  if (!launcher || version === null) {
    emitAndExit({
      status: "claude_unavailable",
      error: "`claude` CLI not found on PATH or well-known install dirs. Install Claude Code, run `claude auth login`, or pass --claude-bin <path>.",
      reviewer: { tool: "claude", model: opts.model, effort: opts.effort, integrity: "by-construction", claudeVersion: null },
    }, EXIT_TRANSPORT);
  }

  const stateDir = opts.stateDir ||
    join(tmpdir(), "claude-review", `${basename(opts.repo) || "repo"}-${timestamp()}-${process.pid}`);
  mkdirSync(stateDir, { recursive: true });

  // Resolve resume session.
  let session = opts.session;
  if (!session && opts.resume) {
    const recorded = readRecordedSession(stateDir);
    if (!recorded || !recorded.sessionId) {
      die(`--resume was requested but no session id is recorded in ${join(stateDir, "agent.json")}`, EXIT_USAGE);
    }
    session = recorded.sessionId;
  }

  const brief = readFileSync(opts.brief, "utf8");
  if (!brief.trim()) die("brief is empty", EXIT_USAGE);

  const { dir: roundDir, nn } = nextRoundDir(stateDir);

  // Capture the review target BEFORE launching (into the state dir, never the
  // repo) so an empty target fails closed and the tree stays clean.
  let round = { describe: "plan review", untracked: [], targetPath: null };
  if (opts.mode === "code") {
    let captured;
    try { captured = captureTarget(opts.repo, opts.target); }
    catch (e) {
      emitAndExit({ status: "target_capture_failed", error: `failed to capture review target: ${e && e.message ? e.message : e}`,
        stateDir, roundDir }, EXIT_TRANSPORT);
    }
    if (!captured.patch.trim()) {
      emitAndExit({ status: "empty_target", verdict: null,
        error: `the review target (${captured.describe}) is EMPTY — nothing to review. An empty diff is not an approval.`,
        mode: opts.mode, target: captured.describe, stateDir, roundDir }, EXIT_CONTRACT);
    }
    const targetPath = join(roundDir, "target.diff");
    writeFileSync(targetPath, captured.patch, "utf8");
    round = { describe: captured.describe, untracked: captured.untracked, targetPath };
  }

  const prompt = buildPrompt(opts, round, brief);
  writeFileSync(join(roundDir, "brief.txt"), brief, "utf8");
  writeFileSync(join(roundDir, "prompt.txt"), prompt, "utf8");
  const eventsPath = join(roundDir, "events.jsonl");
  writeFileSync(eventsPath, "", "utf8");

  const settingsPath = join(roundDir, "profile.json");
  writeFileSync(settingsPath, `${JSON.stringify(readOnlyProfile(), null, 2)}\n`, "utf8");

  const beforeTree = porcelain(opts.repo);

  const argv = [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--permission-mode", "plan",
    "--tools", "Read,Glob,Grep",
    "--strict-mcp-config",
    "--disallowedTools", "mcp__*",
    "--disable-slash-commands",
    "--settings", settingsPath,
    "--model", opts.model,
    "--effort", opts.effort,
  ];
  if (session) argv.push("--resume", session);

  return dispatch({ opts, launcher, env, version, argv, prompt, roundDir, nn, eventsPath, beforeTree, stateDir, round });
}

function readOnlyProfile() {
  return {
    disableClaudeAiConnectors: true,
    ...(process.platform === "win32" ? { env: { CLAUDE_CODE_USE_POWERSHELL_TOOL: "1" } } : {}),
    permissions: { deny: [] },
  };
}

function dispatch(ctx) {
  const { opts, launcher, env, version, argv, prompt, roundDir, nn, eventsPath, beforeTree, stateDir, round } = ctx;
  const state = { sessionId: null, sawResult: false, resultIsError: false, subtype: null, finalMessage: "" };
  const scan = makeEventScanner((event) => {
    if (!event || typeof event !== "object") return;
    const sid = eventSessionId(event);
    if (typeof sid === "string" && sid) state.sessionId = sid;
    if (event.type !== "result") return;
    state.sawResult = true;
    state.subtype = typeof event.subtype === "string" ? event.subtype : null;
    state.resultIsError = event.is_error === true || (state.subtype !== null && /^error(?:_|$)/i.test(state.subtype));
    state.finalMessage = typeof event.result === "string" ? event.result : "";
  });

  const spec = launchSpec(launcher, argv, env);
  let child;
  try {
    child = spawn(spec.command, spec.argv, {
      cwd: opts.repo, env, stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32", windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
  } catch (e) {
    die(`failed to launch claude: ${e && e.message ? e.message : e}`, EXIT_TRANSPORT);
  }

  const decoder = new StringDecoder("utf8");
  const stderrChunks = [];
  child.stdout.on("data", (chunk) => {
    appendFile(eventsPath, chunk);
    scan(decoder.write(chunk));
  });
  child.stderr.on("data", (chunk) => { stderrChunks.push(chunk); process.stderr.write(chunk); });

  let watchdog = null, killed = false;
  watchdog = setTimeout(() => {
    killed = true;
    killTree(child);
  }, opts.timeoutMs);

  child.stdin.on("error", () => {});
  child.stdin.end(prompt);

  child.on("error", (e) => {
    clearTimeout(watchdog);
    const unavailable = e && e.code === "ENOENT";
    finish({
      ctx, state, version,
      status: unavailable ? "claude_unavailable" : "failed",
      exit: EXIT_TRANSPORT,
      error: e && e.message ? e.message : String(e),
      stderr: Buffer.concat(stderrChunks).toString("utf8"),
    });
  });

  child.on("close", (code, signal) => {
    clearTimeout(watchdog);
    scan(decoder.end());
    const stderr = Buffer.concat(stderrChunks).toString("utf8");

    if (killed) {
      finish({ ctx, state, version, status: "timeout", exit: EXIT_TRANSPORT,
        error: `claude exceeded --timeout-ms ${opts.timeoutMs}; killed by watchdog`, stderr });
      return;
    }
    if (code !== 0 || state.resultIsError || !state.sawResult) {
      finish({ ctx, state, version, status: "failed", exit: EXIT_TRANSPORT,
        error: state.resultIsError ? `claude returned an error result${state.subtype ? ` (${state.subtype})` : ""}`
          : !state.sawResult ? "claude exited without a terminal result event"
          : `claude exited ${code}`, stderr });
      return;
    }

    // Success path: extract + validate the verdict.
    writeFileSync(join(roundDir, "report.md"), state.finalMessage || "(empty final message)", "utf8");
    const verdict = extractVerdict(state.finalMessage);
    const errors = validateVerdict(verdict);
    const afterTree = porcelain(opts.repo);
    const readOnlyViolation = beforeTree === null || afterTree === null ? null
      : JSON.stringify(beforeTree) !== JSON.stringify(afterTree);

    if (errors.length) {
      finish({ ctx, state, version, status: "bad_verdict", exit: EXIT_CONTRACT, readOnlyViolation,
        error: `the final message was not one valid schema-conforming verdict: ${errors.join("; ")}`, stderr });
      return;
    }

    writeJsonAtomic(join(roundDir, "verdict.json"), verdict);
    writeJsonAtomic(join(stateDir, "agent.json"), { sessionId: state.sessionId, model: opts.model, effort: opts.effort });

    const result = {
      schema: "claude-review.result.v1",
      status: "ok",
      verdict: verdict.verdict,
      summary: verdict.summary,
      findings: verdict.findings,
      reviewer: {
        tool: "claude",
        model: opts.model,
        effort: opts.effort,
        integrity: "by-construction",
        integrityNote: "separate read-only claude process, model pinned via --model; NOT cryptographically verified like codex observedModel/observedSandbox.",
        claudeVersion: version,
        sessionId: state.sessionId,
        readOnlyViolation,
      },
      round: Number(nn),
      mode: opts.mode,
      target: opts.mode === "code" ? round.describe : "plan",
      stateDir,
      roundDir,
      artifacts: {
        prompt: join(roundDir, "prompt.txt"),
        events: eventsPath,
        report: join(roundDir, "report.md"),
        verdict: join(roundDir, "verdict.json"),
        targetDiff: round.targetPath,
        agent: join(stateDir, "agent.json"),
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (readOnlyViolation === true) {
      process.stderr.write("claude-review: WARNING — the read-only reviewer changed git porcelain; inspect the tree.\n");
    }
    process.exit(EXIT_OK);
  });
}

function finish({ ctx, state, version, status, exit, error, stderr, readOnlyViolation = null }) {
  const { opts, roundDir, nn, eventsPath, stateDir, round } = ctx;
  if (state && state.finalMessage) {
    try { writeFileSync(join(roundDir, "report.md"), state.finalMessage, "utf8"); } catch { /* best effort */ }
  }
  const result = {
    schema: "claude-review.result.v1",
    status,
    error,
    reviewer: {
      tool: "claude", model: opts.model, effort: opts.effort, integrity: "by-construction",
      claudeVersion: version, sessionId: state ? state.sessionId : null, readOnlyViolation,
    },
    round: Number(nn),
    mode: opts.mode,
    target: opts.mode === "code" ? round.describe : "plan",
    stateDir, roundDir,
    stderrTail: String(stderr || "").split(/\r?\n/).filter((l) => l.trim()).slice(-12),
    artifacts: { prompt: join(roundDir, "prompt.txt"), events: eventsPath, report: join(roundDir, "report.md") },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`claude-review: ${status} — ${error}\n`);
  process.exit(exit);
}

/* ------------------------------ small utils ------------------------------ */

function appendFile(path, chunk) {
  // Append the raw stream to disk instead of buffering it in RAM.
  try { appendFileSync(path, chunk); } catch { /* best effort */ }
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === "win32") {
    try { execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" }); } catch { /* gone */ }
    return;
  }
  try { process.kill(-child.pid, "SIGTERM"); } catch { try { child.kill("SIGTERM"); } catch { /* gone */ } }
  setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 8000);
}

/* -------------------------------- doctor --------------------------------- */

function doctor() {
  const env = childEnvironment();
  const launcher = resolveClaudeLauncher(env, process.cwd());
  const report = {
    node: process.version,
    platform: process.platform,
    claudeFound: Boolean(launcher),
    claudePath: launcher ? launcher.path : null,
    claudeVersion: launcher ? claudeVersion(launcher, env, process.cwd()) : null,
    schemaDefault: existsSync(DEFAULT_SCHEMA) ? DEFAULT_SCHEMA : `MISSING: ${DEFAULT_SCHEMA}`,
    git: (() => { try { return git(process.cwd(), ["--version"]).trim(); } catch { return null; } })(),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const ok = report.claudeFound && report.claudeVersion && report.git;
  process.exit(ok ? EXIT_OK : EXIT_TRANSPORT);
}

/* --------------------------------- main ---------------------------------- */

function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === "-h" || sub === "--help" || sub === undefined) { process.stdout.write(headerComment()); process.exit(0); }
  if (sub === "doctor") { doctor(); return; }
  if (sub === "review") { runReview(parseArgs(rest)); return; }
  die(`unknown subcommand "${sub}" (expected: review | doctor)`);
}

main();
