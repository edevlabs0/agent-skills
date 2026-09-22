#!/usr/bin/env node
/**
 * opencode-review · opencode-review.mjs
 *
 * Run an INDEPENDENT, READ-ONLY code/plan review in a SEPARATE `opencode run`
 * process pinned to a model you choose — the analog of codex-review.mjs and
 * claude-review.mjs, but the reviewer is a fresh opencode process instead of
 * Codex or Claude. This is what decouples the reviewer's model from the
 * orchestrator's: the orchestrator may run Opus/GPT while the review runs on
 * a different provider/model, because the reviewer is its own OS process
 * launched with `opencode run --model <provider/model>`, not an in-process
 * subagent that inherits the session model.
 *
 * The whole loop:
 *   capture the review target (git diff) → launch `opencode run` read-only
 *   (plan agent), pinned model, full prompt attached via `--file` → capture
 *   its text output → extract + validate the verdict JSON against
 *   reviewer-verdict.schema.json → persist the round → print a structured
 *   result. Resume the same session for a rework round.
 *
 * Prompt delivery uses `--file` (plus a one-line pointer message) rather than
 * a giant argv positional so prompts of any length survive Windows cmd.exe
 * quoting through npm `opencode.cmd` shims.
 *
 * Trust posture: no network of its own, no credentials, no telemetry, Node
 * built-ins only. It launches `opencode` (which authenticates exactly as it
 * does at the terminal) and runs read-only `git` inspection commands. The
 * child runs as the `plan` agent (which refuses file writes in non-interactive
 * mode) under a prompt that orders strict read-only behavior; a git-porcelain
 * tripwire (readOnlyViolation) is recorded as a backstop. Independence is BY
 * CONSTRUCTION (fresh process, pinned model, read-only agent), NOT
 * cryptographically verified the way Codex verifies its observed model +
 * sandbox. Label the verdict accordingly.
 *
 * Usage:
 *   node opencode-review.mjs review --repo <dir> --brief <file> --model <provider/model> [options]
 *   node opencode-review.mjs doctor
 *   node opencode-review.mjs --help
 *
 * review options:
 *   --repo <dir>          Git repository to review in (required).
 *   --brief <file>        Brief describing the work and what to scrutinize (required).
 *   --model <id>          Model to PIN for the reviewer in provider/model form,
 *                         e.g. `opencode/muse-spark-1.3-contributor-free`
 *                         (required). Make it DIFFER from the implementer's model.
 *   --mode code|plan      code (default): capture and review a git diff. plan:
 *                         no diff; review the plan carried in the brief.
 *   --target <spec>       code mode only. `working` (default) = TRACKED changes
 *                         only (`git diff HEAD`). Untracked files are NEVER
 *                         swept in — name them with --include-untracked or
 *                         hand-build the patch with --patch. `A..B` =
 *                         `git diff A..B`. Any other value = a commit reviewed
 *                         via `git show <value>`.
 *   --include-untracked <paths>
 *                         code mode only. Comma-separated and/or repeatable:
 *                         untracked files to append to a `working` target
 *                         (e.g. `--include-untracked new.js,lib/new2.js`).
 *                         Each path must exist under --repo.
 *   --patch <file>        code mode only. Use this hand-built patch file as
 *                         the review target instead of capturing from git.
 *                         Cannot be combined with --target or
 *                         --include-untracked.
 *   --effort <level>      Reviewer reasoning effort: low|medium|high|xhigh|max.
 *                         Passed to `opencode run --variant`. Default: high.
 *   --agent <name>        opencode agent for the reviewer. Default: plan
 *                         (refuses file writes). Use a custom read-only agent
 *                         only if you know what you are doing.
 *   --state-dir <dir>     Persist rounds/agent.json here; reuse across rounds.
 *                         Default: a fresh temp dir (printed).
 *   --resume              Resume the session recorded in <state-dir>/agent.json.
 *   --session <id>        Resume this explicit session id (overrides agent.json).
 *   --schema <file>       Verdict JSON Schema the final message is validated
 *                         against. Default: ../assets/reviewer-verdict.schema.json.
 *                         Supported keywords: type, enum, minLength, required,
 *                         properties, additionalProperties:false, items.
 *   --timeout-ms <ms>     Watchdog for the opencode process. Default: 900000 (15m).
 *   --opencode-bin <path> Explicit opencode binary (overrides PATH search).
 *   -h, --help            Show this help.
 *
 * Exit codes (mirroring codex-review's contract):
 *   0  a valid verdict was produced (approve OR changes_required).
 *   2  usage error (bad flags) — nothing launched.
 *   3  transport: opencode unavailable/unauthenticated/timeout/non-zero — retry once.
 *   5  contract: empty review target, or the final message was not one valid
 *      schema-conforming verdict — do NOT retry, the same call fails identically.
 *
 * Artifacts under <state-dir>/rounds/<NN>/:
 *   brief.txt      the brief sent for this round
 *   prompt.txt     the exact message handed to opencode
 *   target.diff    the captured review target (audit copy; the reviewer reads
 *                  the twin copy inside the repo git dir — see below)
 *   events.jsonl   raw opencode --format json stream
 *   report.md      the reviewer's full final text
 *   verdict.json   the extracted, validated verdict
 * plus <state-dir>/agent.json { sessionId, model, effort, agent } for resume.
 *
 * The reviewer can only read files inside --repo, so the patch is ALSO written
 * to <gitdir>/opencode-review/<NN>-<pid>-<time>/target.diff (inside the repo
 * git dir: readable, yet invisible to `git status`, so the read-only tripwire
 * stays valid). The prompt points the reviewer at that copy. It is temporary:
 * the script deletes it on exit; the audit copy in the round dir stays.
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
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_SCHEMA = resolve(HERE, "..", "assets", "reviewer-verdict.schema.json");
const EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const SAFE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:@\/-]*$/;
const SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_AGENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MAX_TIMER_MS = 2_147_483_647;

// Exit codes — kept parallel to codex-review so callers branch identically.
const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_TRANSPORT = 3;
const EXIT_CONTRACT = 5;

function die(message, code = EXIT_USAGE) {
  process.stderr.write(`opencode-review: ${message}\n`);
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
    targetExplicit: false,
    includeUntracked: [],
    patch: null,
    effort: "high",
    agent: "plan",
    stateDir: null,
    resume: false,
    session: null,
    schema: DEFAULT_SCHEMA,
    timeoutMs: 900_000,
    opencodeBin: null,
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
      case "--target": opts.target = next(); opts.targetExplicit = true; break;
      case "--include-untracked": opts.includeUntracked.push(next()); break;
      case "--patch": opts.patch = resolve(next()); break;
      case "--effort": opts.effort = next(); break;
      case "--agent": opts.agent = next(); break;
      case "--state-dir": opts.stateDir = resolve(next()); break;
      case "--resume": opts.resume = true; break;
      case "--session": opts.session = next(); break;
      case "--schema": opts.schema = resolve(next()); break;
      case "--timeout-ms": opts.timeoutMs = Number(next()); break;
      case "--opencode-bin": opts.opencodeBin = resolve(next()); break;
      default:
        die(`unknown option: ${arg}`);
    }
  }

  if (!opts.repo) die("--repo <dir> is required");
  if (!opts.brief) die("--brief <file> is required");
  if (!opts.model) die("--model <provider/model> is required (pin a model that differs from the implementer's)");
  if (!SAFE_MODEL.test(opts.model) || !opts.model.includes("/")) {
    die('--model must be in provider/model form (e.g. "opencode/muse-spark-1.3-contributor-free")');
  }
  if (!SAFE_AGENT.test(opts.agent)) die("--agent contains unsupported characters");
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
  opts.schemaText = readFileSync(opts.schema, "utf8");
  opts.schemaJson = tryParse(opts.schemaText);
  if (!opts.schemaJson || typeof opts.schemaJson !== "object") die(`--schema is not valid JSON: ${opts.schema}`);
  if (opts.mode === "plan" && (opts.patch || opts.includeUntracked.length || opts.targetExplicit)) {
    die("--patch, --include-untracked, and --target need --mode code (plan mode carries no diff)");
  }
  if (opts.patch && (opts.targetExplicit || opts.includeUntracked.length)) {
    die("--patch cannot be combined with --target or --include-untracked (the patch is already hand-built)");
  }
  if (opts.patch && (!existsSync(opts.patch) || !statSync(opts.patch).isFile())) {
    die(`--patch file not found: ${opts.patch}`);
  }
  // Flatten repeatable + comma-separated --include-untracked into canonical
  // (realpath) repo-contained file paths. Canonical form lets captureTarget
  // compare them with git's own paths even when --repo is a junction,
  // symlink, or differently-cased path. Validated now (exit 2) so a typo
  // fails before anything launches.
  const repoReal = realpathSync.native(opts.repo);
  opts.includeUntracked = opts.includeUntracked
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean)
    .map((v) => resolve(opts.repo, v));
  opts.includeUntracked = opts.includeUntracked.map((includePath) => {
    if (!existsSync(includePath) || !statSync(includePath).isFile()) {
      die(`--include-untracked file not found: ${includePath}`);
    }
    const real = realpathSync.native(includePath);
    if (!isInside(repoReal, real)) die(`--include-untracked path escapes --repo: ${includePath}`);
    return real;
  });
  return opts;
}

function headerComment() {
  const src = readFileSync(fileURLToPath(import.meta.url), "utf8");
  const match = src.match(/\/\*\*([\s\S]*?)\*\//);
  return match ? `${match[1].replace(/^\s*\* ?/gm, "").trim()}\n` : "opencode-review.mjs\n";
}

/* --------------------------- opencode CLI launcher ------------------------ */
// `opencode` is often an npm shim (opencode.cmd / extensionless shell stub next
// to node, with the real binary at node_modules/opencode-ai/bin/opencode.exe),
// so PATH probing must cover PATHEXT executables AND the npm sibling layout.
// A bare `opencode.ps1` on PATH is NOT directly spawnable and is skipped.

function environmentValue(env, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  if (process.platform !== "win32") return undefined;
  const key = Object.keys(env).find((c) => c.toUpperCase() === name);
  return key ? env[key] : undefined;
}

function childEnvironment() {
  return { ...process.env };
}

// Well-known install locations to probe when PATH resolution fails. An
// explicit override (--opencode-bin / OPENCODE_REVIEW_CLI) wins over everything.
function fallbackOpencodeDirs(env) {
  const home = environmentValue(env, "HOME") || environmentValue(env, "USERPROFILE") || homedir();
  const dirs = [];
  if (home) {
    dirs.push(join(home, ".local", "bin"));
    dirs.push(join(home, ".opencode", "bin"));
  }
  return dirs;
}

function probeDir(dir, cwd, exts) {
  const resolvedDir = resolve(cwd, dir || ".");
  if (process.platform === "win32") {
    for (const ext of exts) {
      const candidate = join(resolvedDir, `opencode${ext}`);
      try {
        if (statSync(candidate).isFile()) {
          return { path: candidate, kind: ext === ".cmd" || ext === ".bat" ? "cmd" : "direct" };
        }
      } catch { /* keep searching */ }
    }
    return null;
  }
  const candidate = join(resolvedDir, "opencode");
  try {
    accessSync(candidate, fsConstants.X_OK);
    if (statSync(candidate).isFile()) return { path: candidate, kind: "direct" };
  } catch { /* keep searching */ }
  return null;
}

// npm-global layout: <dir>/node.exe + <dir>/node_modules/opencode-ai/bin/opencode.exe
function probeNpmSibling(dir, cwd) {
  const resolvedDir = resolve(cwd, dir || ".");
  const nodeBin = join(resolvedDir, process.platform === "win32" ? "node.exe" : "node");
  try {
    if (!statSync(nodeBin).isFile()) return null;
  } catch { return null; }
  const candidate = join(resolvedDir, "node_modules", "opencode-ai", "bin", "opencode.exe");
  try {
    if (statSync(candidate).isFile()) return { path: candidate, kind: "direct" };
  } catch { /* keep searching */ }
  return null;
}

function resolveOpencodeLauncher(env, cwd) {
  // 1. Explicit override — a flag value or env var pointing at the binary.
  const override = env.__opencodeReviewCliOverride || environmentValue(env, "OPENCODE_REVIEW_CLI");
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

  // 2. PATH executables (skips non-spawnable .ps1 shims), then 3. npm siblings,
  // then 4. well-known fallback dirs.
  for (const entry of pathEntries) {
    const found = probeDir(entry, cwd, exts);
    if (found) return found;
  }
  for (const entry of pathEntries) {
    const found = probeNpmSibling(entry, cwd);
    if (found) return found;
  }
  for (const entry of fallbackOpencodeDirs(env)) {
    const found = probeDir(entry, cwd, exts);
    if (found) return found;
  }
  return null;
}

function quoteCmdArgument(value) {
  if (/[\0\r\n"%!]/.test(value)) {
    throw new Error("cannot safely serialize an argument containing %, !, a quote, or a newline for the opencode.cmd launch");
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

function opencodeVersion(launcher, env, cwd) {
  try {
    const spec = launchSpec(launcher, ["--version"], env);
    const probe = spawnSync(spec.command, spec.argv, {
      cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
    if (probe.error && probe.error.code === "ENOENT") return null;
    if (probe.status !== 0) return "unknown";
    return String(probe.stdout || "").trim().split(/\r?\n/)[0] || "unknown";
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

// `git diff --no-index` exits 1 when differences exist (like diff(1)), so
// exit 0 AND 1 both mean "captured"; anything else (or a signal) is a failure.
function diffNoIndex(repo, file) {
  const execution = spawnSync("git", ["diff", "--no-index", "--", "/dev/null", file], {
    cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 256 * 1024 * 1024,
  });
  if (execution.error) return null;
  if (execution.status !== 0 && execution.status !== 1) return null;
  return execution.stdout || "";
}

function porcelain(repo) {
  const out = tryGit(repo, ["status", "--porcelain"]);
  return out === null ? null : out.split("\n").map((l) => l.trimEnd()).filter(Boolean);
}

function repositoryRoot(repoInput) {
  if (!existsSync(repoInput) || !statSync(repoInput).isDirectory()) {
    throw new Error(`Repository does not exist: ${repoInput}`);
  }
  return realpathSync.native(git(repoInput, ["rev-parse", "--show-toplevel"]).trim());
}

// True when `path` is strictly below `root`. Both must be canonical
// (realpathSync.native) so junctions and path case do not break the test.
function isInside(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

// Absolute path of the repo git dir (handles worktrees, where .git is a
// file). Throws when git cannot tell us — the caller maps that to a
// transport failure.
function gitDir(repo) {
  return git(repo, ["rev-parse", "--absolute-git-dir"]).trim();
}

// Build the exact change under review as a single patch string. `working`
// covers TRACKED changes only (`git diff HEAD`) — untracked files are never
// swept in; only paths named in `includeUntracked` are appended. Returns
// { patch, untracked: string[] } or throws on a hard git failure.
function captureTarget(repo, target, includeUntracked) {
  if (target.includes("..")) {
    const patch = git(repo, ["diff", target]);
    return { patch, untracked: [], describe: `git diff ${target}` };
  }
  if (target !== "working") {
    const patch = git(repo, ["show", target]);
    return { patch, untracked: [], describe: `git show ${target}` };
  }
  const patchParts = [git(repo, ["diff", "HEAD"])];
  // Ask git for the tracked FILE list (`ls-files`), not `status --porcelain`:
  // porcelain collapses a new directory to one `?? dir/` line, so a file
  // inside it would never match and would be dropped silently.
  const tracked = new Set(git(repo, ["ls-files", "-z"]).split("\0").filter(Boolean));
  const included = [];
  for (const includePath of includeUntracked) {
    if (!isInside(repo, includePath)) {
      throw new Error(`--include-untracked path is outside the repository root: ${includePath}`);
    }
    // Repo-relative, forward-slash path: matches git's own paths and keeps
    // the diff headers short and readable.
    const gitPath = relative(repo, includePath).split(sep).join("/");
    // Tracked paths need no extra work: `git diff HEAD` already covers them.
    if (tracked.has(gitPath)) continue;
    const extra = diffNoIndex(repo, gitPath);
    if (extra === null) throw new Error(`could not diff untracked file: ${gitPath}`);
    patchParts.push(extra);
    included.push(includePath);
  }
  const patch = patchParts.filter((part) => part !== "").join("\n");
  const describe = included.length
    ? `git diff HEAD (+ untracked: ${included.map((p) => basename(p)).join(", ")})`
    : "git diff HEAD (tracked only)";
  return { patch, untracked: included, describe };
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
    "\"approve\" may carry minor findings only (or none); any blocker or major finding means",
    "\"changes_required\", which needs at least one finding. Each finding is an actionable defect,",
    "not a style preference.",
  ].join("\n");
}

function buildPrompt(opts, round, brief) {
  const lines = [];
  lines.push("You are an INDEPENDENT CODE REVIEWER running in a fresh, isolated process.");
  lines.push("You have NO access to the implementer's chat or reasoning — only the attached instructions plus the repository.");
  lines.push("You are STRICTLY READ-ONLY: read files, search, and inspect. Never edit, write, create, delete,");
  lines.push("stage, commit, or push any file, and never run commands that modify the tree. Report only.");
  lines.push(`The repository under review is: ${opts.repo}`);
  lines.push("");
  if (opts.mode === "code") {
    lines.push(`The EXACT change under review (${round.describe}) is in this patch file — read it FIRST:`);
    lines.push(`  ${round.targetPath}`);
    if (round.handBuilt) {
      lines.push("The caller built this patch by hand — review exactly these changes, nothing more.");
    }
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
  if (opts.schema !== DEFAULT_SCHEMA) {
    lines.push("");
    lines.push("The caller supplied this JSON Schema — your object MUST validate against it:");
    lines.push(opts.schemaText.trim());
  }
  return lines.join("\n");
}

/* -------------------------- stream-json scanner -------------------------- */
// Brace-aware NDJSON scanner tolerant of chunk splits (opencode --format json
// emits one JSON object per line, but chunk boundaries are arbitrary).

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

/* --------------------------- verdict validation -------------------------- */

// Extract the reviewer's verdict object from its final text. Prefer a clean
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

// Validate against the --schema file, then enforce the verdict/findings
// invariant JSON Schema cannot express. The schema check supports the
// keyword subset the verdict schema uses — type, enum, minLength (counted
// after trim, so whitespace-only strings fail), required, properties,
// additionalProperties: false, items — and ignores any other keyword.
function validateVerdict(v, schema) {
  if (!v || typeof v !== "object") return ["final message did not contain a JSON verdict object"];
  const errors = schemaErrors(v, schema, "verdict");
  if (Array.isArray(v.findings)) {
    if (v.verdict === "approve" && v.findings.some((f) => f && f.severity !== "minor")) errors.push("approve cannot carry blocker or major findings");
    if (v.verdict === "changes_required" && v.findings.length === 0) errors.push("`findings` must be non-empty when verdict is changes_required");
  }
  return errors;
}

function schemaErrors(value, schema, path) {
  if (!schema || typeof schema !== "object") return [];
  const type = schema.type;
  const typeOk = type === undefined ? true
    : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
    : type === "array" ? Array.isArray(value)
    : type === "integer" ? Number.isInteger(value)
    : type === "null" ? value === null
    : typeof value === type;
  if (!typeOk) return [`${path} must be ${type}`];
  const errors = [];
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    errors.push(`${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`);
  }
  if (typeof value === "string" && typeof schema.minLength === "number" && value.trim().length < schema.minLength) {
    errors.push(`${path} must be a non-empty string`);
  }
  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...schemaErrors(item, schema.items, `${path}[${i}]`)));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (key in properties) errors.push(...schemaErrors(child, properties[key], `${path}.${key}`));
      else if (schema.additionalProperties === false) errors.push(`${path}.${key} is not allowed`);
    }
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
  process.stdout.write(`${JSON.stringify({ schema: "opencode-review.result.v1", ...result }, null, 2)}\n`);
  if (result.error) process.stderr.write(`opencode-review: ${result.status} — ${result.error}\n`);
  process.exit(exit);
}

function runReview(opts) {
  const env = childEnvironment();
  if (opts.opencodeBin) env.__opencodeReviewCliOverride = opts.opencodeBin;
  const launcher = resolveOpencodeLauncher(env, opts.repo);
  const version = launcher ? opencodeVersion(launcher, env, opts.repo) : null;
  if (!launcher || version === null) {
    emitAndExit({
      status: "opencode_unavailable",
      error: "`opencode` CLI not found on PATH or well-known install dirs. Install opencode, run `opencode auth login`, or pass --opencode-bin <path> (or set OPENCODE_REVIEW_CLI).",
      reviewer: { tool: "opencode", model: opts.model, effort: opts.effort, integrity: "by-construction", opencodeVersion: null },
    }, EXIT_TRANSPORT);
  }

  const stateDir = opts.stateDir ||
    join(tmpdir(), "opencode-review", `${basename(opts.repo) || "repo"}-${timestamp()}-${process.pid}`);
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

  // All git inspection runs at the worktree root so porcelain paths and the
  // git dir resolve the same way no matter which subdir --repo points at.
  let repository;
  try { repository = repositoryRoot(opts.repo); }
  catch (e) {
    emitAndExit({ status: "target_capture_failed",
      error: `not a git repository: ${e && e.message ? e.message : e}`,
      stateDir, roundDir }, EXIT_TRANSPORT);
  }

  // Capture the review target BEFORE launching so an empty target fails closed
  // and the tree stays clean. The patch is written twice with identical
  // bytes: an audit copy in the round dir, and a working copy inside the repo
  // git dir (the only place the reviewer can read). The git-dir copy is
  // invisible to `git status`, so the read-only tripwire stays valid.
  let round = { describe: "plan review", untracked: [], targetPath: null, handBuilt: false };
  let patchText = null;
  if (opts.mode === "code") {
    let describe;
    let untracked = [];
    if (opts.patch) {
      patchText = readFileSync(opts.patch, "utf8");
      describe = `hand-built patch ${basename(opts.patch)}`;
      round.handBuilt = true;
    } else {
      let captured;
      try { captured = captureTarget(repository, opts.target, opts.includeUntracked); }
      catch (e) {
        emitAndExit({ status: "target_capture_failed", error: `failed to capture review target: ${e && e.message ? e.message : e}`,
          stateDir, roundDir }, EXIT_TRANSPORT);
      }
      patchText = captured.patch;
      describe = captured.describe;
      untracked = captured.untracked;
    }
    if (!patchText.trim()) {
      emitAndExit({ status: "empty_target", verdict: null,
        error: `the review target (${describe}) is EMPTY — nothing to review. An empty diff is not an approval.`,
        mode: opts.mode, target: describe, stateDir, roundDir }, EXIT_CONTRACT);
    }
    const targetPath = join(roundDir, "target.diff");
    writeFileSync(targetPath, patchText, "utf8");
    let repoTargetPath;
    try {
      // One folder per run (round + pid + time), so parallel reviews with
      // different state dirs never overwrite each other's patch. The copy is
      // temporary: it is deleted on process exit (the audit copy stays).
      const repoPatchRoot = join(gitDir(repository), "opencode-review");
      const repoPatchDir = join(repoPatchRoot, `${nn}-${process.pid}-${timestamp()}`);
      process.on("exit", () => removeRepoPatch(repoPatchDir, repoPatchRoot));
      mkdirSync(repoPatchDir, { recursive: true });
      repoTargetPath = join(repoPatchDir, "target.diff");
      writeFileSync(repoTargetPath, patchText, "utf8");
    } catch (e) {
      emitAndExit({ status: "target_capture_failed",
        error: `failed to stage the patch inside the repo git dir: ${e && e.message ? e.message : e}`,
        stateDir, roundDir }, EXIT_TRANSPORT);
    }
    round = { describe, untracked: untracked.map((p) => basename(p)), targetPath: repoTargetPath, handBuilt: round.handBuilt, auditPath: targetPath };
  }

  const prompt = buildPrompt(opts, round, brief);
  writeFileSync(join(roundDir, "brief.txt"), brief, "utf8");
  writeFileSync(join(roundDir, "prompt.txt"), prompt, "utf8");
  const eventsPath = join(roundDir, "events.jsonl");
  writeFileSync(eventsPath, "", "utf8");

  const beforeTree = porcelain(repository);

  // The full prompt travels as an attached file (prompt.txt) so its length
  // and content never hit argv/cmd.exe quoting limits; the positional message
  // is a short pointer. The reviewer also gets the on-disk path so it can
  // re-read the file directly from the repo-adjacent state dir.
  const pointerMessage =
    `You are an independent code reviewer. The full review instructions are attached. ` +
    `Read them, read the repository, then return exactly one JSON verdict object and nothing else. ` +
    `Instructions file: ${join(roundDir, "prompt.txt")}`;

  // `opencode run` greedily treats positionals after `-f` as more files, so the
  // pointer message MUST come first: `opencode run <message> --dir ... -f ...`.
  const argv = [
    "run",
    pointerMessage,
    "--dir", opts.repo,
    "--model", opts.model,
    "--agent", opts.agent,
    "--format", "json",
    "--variant", opts.effort,
    "--title", `opencode-review ${basename(opts.repo) || "repo"} round ${nn}`,
  ];
  if (session) argv.push("--session", session);
  argv.push("-f", join(roundDir, "prompt.txt"));

  if (launcher.kind === "cmd" && /[\0\r\n"%!]/.test(pointerMessage)) {
    emitAndExit({ status: "failed",
      error: "the pointer message contains characters unsafe for the opencode.cmd launch; pass --opencode-bin <path-to-opencode.exe> instead.",
      stateDir, roundDir }, EXIT_TRANSPORT);
  }

  return dispatch({ opts, launcher, env, version, argv, roundDir, nn, eventsPath, beforeTree, stateDir, round, repository });
}

function dispatch(ctx) {
  const { opts, launcher, env, version, argv, roundDir, nn, eventsPath, beforeTree, stateDir, round, repository } = ctx;
  const state = { sessionId: null, texts: [], transportError: null };
  const scan = makeEventScanner((event) => {
    if (!event || typeof event !== "object") return;
    if (typeof event.sessionID === "string" && event.sessionID) state.sessionId = event.sessionID;
    if (event.type === "error") {
      const msg = event.error && event.error.data && event.error.data.message
        ? event.error.data.message
        : (event.error && event.error.name ? event.error.name : "unknown opencode error");
      state.transportError = String(msg);
      return;
    }
    // Text output arrives as { type: "text", part: { type: "text", text } }.
    if (event.type === "text" && event.part && typeof event.part.text === "string") {
      state.texts.push(event.part.text);
    }
  });

  const spec = launchSpec(launcher, argv, env);
  let child;
  try {
    child = spawn(spec.command, spec.argv, {
      cwd: opts.repo, env, stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32", windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments,
    });
  } catch (e) {
    die(`failed to launch opencode: ${e && e.message ? e.message : e}`, EXIT_TRANSPORT);
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

  child.on("error", (e) => {
    clearTimeout(watchdog);
    const unavailable = e && e.code === "ENOENT";
    finish({
      ctx, state, version,
      status: unavailable ? "opencode_unavailable" : "failed",
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
        error: `opencode exceeded --timeout-ms ${opts.timeoutMs}; killed by watchdog`, stderr });
      return;
    }
    if (state.transportError) {
      finish({ ctx, state, version, status: "failed", exit: EXIT_TRANSPORT,
        error: `opencode reported an error: ${state.transportError}`, stderr });
      return;
    }
    if (code !== 0) {
      finish({ ctx, state, version, status: "failed", exit: EXIT_TRANSPORT,
        error: `opencode exited ${code}${signal ? ` (${signal})` : ""}`, stderr });
      return;
    }
    if (!state.sessionId) {
      finish({ ctx, state, version, status: "failed", exit: EXIT_TRANSPORT,
        error: "opencode output exposed no session id", stderr });
      return;
    }

    // Success path: extract + validate the verdict.
    const finalMessage = state.texts.join("\n");
    writeFileSync(join(roundDir, "report.md"), finalMessage || "(empty final message)", "utf8");
    const verdict = extractVerdict(finalMessage);
    const errors = validateVerdict(verdict, opts.schemaJson);
    const afterTree = porcelain(repository);
    const readOnlyViolation = beforeTree === null || afterTree === null ? null
      : JSON.stringify(beforeTree) !== JSON.stringify(afterTree);

    if (errors.length) {
      finish({ ctx, state, version, status: "bad_verdict", exit: EXIT_CONTRACT, readOnlyViolation,
        error: `the final message was not one valid schema-conforming verdict: ${errors.join("; ")}`, stderr });
      return;
    }

    writeJsonAtomic(join(roundDir, "verdict.json"), verdict);
    writeJsonAtomic(join(stateDir, "agent.json"), { sessionId: state.sessionId, model: opts.model, effort: opts.effort, agent: opts.agent });

    const result = {
      schema: "opencode-review.result.v1",
      status: "ok",
      verdict: verdict.verdict,
      summary: verdict.summary,
      findings: verdict.findings,
      reviewer: {
        tool: "opencode",
        model: opts.model,
        effort: opts.effort,
        agent: opts.agent,
        integrity: "by-construction",
        integrityNote: "separate read-only opencode process (plan agent), model pinned via --model; NOT cryptographically verified like codex observedModel/observedSandbox.",
        opencodeVersion: version,
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
        targetDiff: round.auditPath || null,
        agent: join(stateDir, "agent.json"),
      },
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (readOnlyViolation === true) {
      process.stderr.write("opencode-review: WARNING — the read-only reviewer changed git porcelain; inspect the tree.\n");
    }
    process.exit(EXIT_OK);
  });
}

function finish({ ctx, state, version, status, exit, error, stderr, readOnlyViolation = null }) {
  const { opts, roundDir, nn, eventsPath, stateDir, round } = ctx;
  const finalMessage = (state && state.texts && state.texts.join("\n")) || "";
  if (finalMessage) {
    try { writeFileSync(join(roundDir, "report.md"), finalMessage, "utf8"); } catch { /* best effort */ }
  }
  const result = {
    schema: "opencode-review.result.v1",
    status,
    error,
    reviewer: {
      tool: "opencode", model: opts.model, effort: opts.effort, agent: opts.agent, integrity: "by-construction",
      opencodeVersion: version, sessionId: state ? state.sessionId : null, readOnlyViolation,
    },
    round: Number(nn),
    mode: opts.mode,
    target: opts.mode === "code" ? round.describe : "plan",
    stateDir, roundDir,
    stderrTail: String(stderr || "").split(/\r?\n/).filter((l) => l.trim()).slice(-12),
    artifacts: { prompt: join(roundDir, "prompt.txt"), events: eventsPath, report: join(roundDir, "report.md") },
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.stderr.write(`opencode-review: ${status} — ${error}\n`);
  process.exit(exit);
}

/* ------------------------------ small utils ------------------------------ */

function appendFile(path, chunk) {
  // Append the raw stream to disk instead of buffering it in RAM.
  try { appendFileSync(path, chunk); } catch { /* best effort */ }
}

// Best effort: drop this run's patch folder, then the shared parent if no
// other run is still using it (rmdirSync fails on a non-empty dir).
function removeRepoPatch(dir, root) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmdirSync(root); } catch { /* still in use or already gone */ }
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
  if (process.argv.includes("--opencode-bin")) {
    const idx = process.argv.indexOf("--opencode-bin");
    if (process.argv[idx + 1]) env.__opencodeReviewCliOverride = resolve(process.argv[idx + 1]);
  }
  const launcher = resolveOpencodeLauncher(env, process.cwd());
  const version = launcher ? opencodeVersion(launcher, env, process.cwd()) : null;
  let auth = null;
  if (launcher) {
    try {
      const spec = launchSpec(launcher, ["auth", "list"], env);
      const probe = spawnSync(spec.command, spec.argv, {
        cwd: process.cwd(), env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000, windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments,
      });
      auth = probe.status === 0 ? "authenticated (auth list succeeded)" : "auth list exited non-zero";
    } catch (e) { auth = `auth probe failed: ${e && e.message ? e.message : e}`; }
  }
  const report = {
    node: process.version,
    platform: process.platform,
    opencodeFound: Boolean(launcher),
    opencodePath: launcher ? launcher.path : null,
    opencodeVersion: version,
    opencodeAuth: auth,
    schemaDefault: existsSync(DEFAULT_SCHEMA) ? DEFAULT_SCHEMA : `MISSING: ${DEFAULT_SCHEMA}`,
    git: (() => { try { return git(process.cwd(), ["--version"]).trim(); } catch { return null; } })(),
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  const ok = report.opencodeFound && report.opencodeVersion && report.git && existsSync(DEFAULT_SCHEMA);
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
