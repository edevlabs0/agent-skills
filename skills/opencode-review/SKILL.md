---
name: opencode-review
description: >-
  Run an independent, structured review of your work from a fresh opencode reviewer process
  (clean context, read-only plan agent, model pinned via --model), returning the same verdict
  shape as codex-review (approve / changes_required + findings). You (any implementing agent)
  are the implementer; the reviewer is a different, pinned provider/model in its own OS process
  with no access to your working chat. Use when you want an opencode review of a plan or code
  change — e.g. the implementer already used Codex or Claude and you want a third reviewer, or
  opencode hosts a model worth hearing from. Not for letting the reviewer implement — this is
  review only.
metadata:
  version: 0.1.0
---

# Opencode Review

A review primitive that mirrors [codex-review](../codex-review/SKILL.md) and
[claude-review](../claude-review/SKILL.md), but the reviewer is a **fresh `opencode run`
process** instead of the Codex or Claude CLIs. **You** (the caller — Claude Code, Codex CLI,
OpenCode, or any implementing agent) do the work — a plan or a code
change — then run one command that launches a separate `opencode` process which reviews the
repository **read-only** and returns a structured verdict. The loop is identical:

> do work → write a brief → run the reviewer → read the verdict → (fix and re-review) → summarize.

The verdict shape is the **same** as codex-review (`assets/reviewer-verdict.schema.json`), so callers
like `ws-go` consume any of the three reviewers without changing their report contract.

## Why a separate process (read this first)

The reviewer runs as its own `opencode run --model <provider/model>` process — **not** as an
in-process subagent. This matters: an in-process subagent inherits the orchestrator's session
model, so it shares every blind spot of the implementer. The separate process fixes that: the
model you pass with `--model` is the model that actually runs, completely independent of the
orchestrator's model. **Always cross the model line — the reviewer model must differ from the
implementer's, whoever the implementer is.** There is no default: `--model` is required, in
`provider/model` form (e.g. `opencode/muse-spark-1.3-contributor-free`), so every call pins a
deliberate choice.

## Independence tier

The tier depends on the **implementer × reviewer pairing**, not on this skill alone:

- codex-review is **cross-vendor and CLI-verified** when the implementer is *not* Codex (observed
  model, observed sandbox). That independence is what catches bugs a same-family reviewer would share.
- claude-review and opencode-review are **cross-vendor and by-construction** when the implementer
  is *not* the reviewer's family: a fresh non-session process with no working-chat context, model
  pinned at the CLI, read-only agent. When the implementer IS the same family (an opencode agent
  implemented and opencode reviews), it is **same-family**: shared training and blind spots, and
  using a **different model than the implementer** is what makes it useful.
- Its guarantees are **by construction**: independence comes from a fresh process (no working-chat
  context); the model is pinned via `--model`; read-only comes from the `plan` agent (which
  refuses file writes in non-interactive mode) plus a read-only prompt, plus a git-porcelain
  tripwire (`readOnlyViolation`). There is **no cryptographic observed-model/sandbox attestation**
  like Codex has — the session id in the JSON event stream and the tripwire are strong
  by-construction evidence, not a verified sandbox.

Order of preference when several reviewers exist: **a cross-vendor reviewer (any of the three,
whoever is NOT the implementer's family) > a same-family reviewer with a different model > no
review.** Don't present a same-family verdict with the authority of a cross-vendor one.
"Independent" means *not the author's context* — this skill works equally to have opencode review
a Claude or Codex implementation.

## Requirements

Node 18+, Git, and an authenticated `opencode` (`opencode auth login`). Verify with:

```text
node <skill-dir>/scripts/opencode-review.mjs doctor
```

`doctor` reports whether `opencode` was found (PATH, the npm-global sibling
`node_modules/opencode-ai/bin/opencode.exe`, or well-known install dirs), its version, auth
state, git, and the default schema. If `opencode` isn't found (e.g. only a non-spawnable
`opencode.ps1` shim is on PATH), pass `--opencode-bin <path>` or set `OPENCODE_REVIEW_CLI=<path>`
to point at the real binary.

## Reviewing

Write a brief to a file, then run one command. `<sd>` abbreviates `<skill-dir>/scripts/opencode-review.mjs`.

```text
node <sd> review --repo <absolute-repo> --brief <absolute-brief> --model <provider/model> \
  [--mode code|plan] [--target working|<a..b>|<commit>] [--effort low|medium|high|xhigh|max] \
  [--agent plan] [--state-dir <absolute>] [--resume | --session <id>] [--schema <absolute>] \
  [--timeout-ms <ms>] [--opencode-bin <path>]
```

Parameters (this is opencode-review's equivalent of the other reviewers' flags):

- **`--repo`** — the git repository under review. The reviewer process runs there (`--dir`) read-only.
- **`--brief`** — a file describing what you did and what to review. The reviewer sees **only this text,
  the captured diff, and the repository** — no chat history — so put everything needed in it (goal, what
  changed, what to scrutinize, constraints). See "Writing the brief".
- **`--model`** — the model to **pin for the reviewer**, in `provider/model` form (e.g.
  `opencode/muse-spark-1.3-contributor-free`). **Required — no default. Make it differ from the
  implementer's model.**
- **`--mode`** — `code` (default): the script captures the change as a diff and hands the reviewer that
  patch plus the repo. `plan`: no diff; the plan under review is carried in the brief.
- **`--target`** (code mode) — what to review: `working` (default = **tracked** changes only,
  `git diff HEAD` — untracked files are never swept in), a range `A..B` (`git diff A..B`), or any
  other value treated as a commit (`git show`). The script **fails closed** if the target is empty
  — an empty diff is never an approval (exit `5`).
- **`--include-untracked`** (code mode, `working` target only) — untracked files to append to the
  patch, comma-separated and/or repeatable (`--include-untracked new.js,lib/other.js`). Each path
  must exist under `--repo`; it may sit inside a new, untracked folder. Tracked paths need no flag —
  `git diff HEAD` already covers them, so a named tracked path is skipped. A named path the script
  cannot diff fails the run (never a silent skip).
- **`--patch`** (code mode) — a hand-built patch file to review instead of capturing from git.
  Cannot be combined with `--target` or `--include-untracked`. An empty file fails closed (exit `5`).
- **`--effort`** — reviewer reasoning effort, passed to `opencode run --variant` (`low`…`max`).
  Default `high`.
- **`--agent`** — opencode agent for the reviewer. Default `plan`, which refuses file writes in
  non-interactive runs (verified). Override only with another read-only agent.
- **`--schema`** — the JSON Schema the reviewer's verdict is validated against. Default
  `assets/reviewer-verdict.schema.json`. The built-in validator supports `type`, `enum`, `minLength`,
  `required`, `properties`, `additionalProperties: false` and `items`; other keywords are ignored. A
  custom schema is also shown to the reviewer in the prompt.
- **`--state-dir`** — reused across rounds; holds `rounds/<NN>/` artifacts and `agent.json` (the session
  id for resume). Reuse it to keep all rounds of one review together; the script prints its path.

The command prints a JSON result on stdout: `verdict` (`approve` | `changes_required`), `summary`,
`findings[]` (`severity` blocker/major/minor · `location` · `problem` · `required_change`), plus
`reviewer` (`model`, `effort`, `agent`, `integrity: by-construction`, `opencodeVersion`, `sessionId`,
`readOnlyViolation`) and the artifact paths. The script itself persists `verdict.json`, `report.md`,
`target.diff`, `prompt.txt`, and `events.jsonl` per round, and `agent.json` for resume — you do **not**
have to write those.

Because the reviewer can only read inside `--repo`, the patch is written twice with identical
bytes: an audit copy at `rounds/<NN>/target.diff`, and the copy the reviewer is pointed at inside
the repo git dir (`<gitdir>/opencode-review/<NN>-<pid>-<time>/target.diff` — readable, yet invisible
to `git status`, so the read-only tripwire stays valid). The git-dir copy is temporary: the script
deletes it when it exits, so nothing accumulates under `.git/`. The audit copy stays.

## The rework loop

1. Do the work (write the plan, or make the code change).
2. `review` with a brief. Read the verdict JSON from stdout.
3. If `changes_required`, address each finding, then `review` again **with the same `--state-dir` and
   `--resume`** and a short delta brief ("addressed F1 by …; re-review"). The script resumes the same
   opencode session (analog of Codex `exec resume` / Claude `--resume`) and re-captures the current
   diff, so the reviewer sees the prior round *and* your fixes.
4. Each round is persisted under a new `rounds/<NN>/`. Repeat until `approve`, then summarize for the
   caller.

Don't paper over findings and don't call advisory prose an approval — the `verdict` field is the signal.
A non-zero exit or a `status` other than `ok` is a failure, not an approval (see Fail closed).

## Writing the brief

Same discipline as codex-review. Keep it to one review. Include: the goal, what changed (or the plan),
what to focus on, and the constraints to judge against. Make it **adversarial** — list the design
decisions you made and ask the reviewer to challenge them; name the correctness properties that must
hold. For a rework round (`--resume`) send only the delta (which findings you addressed and how).

You do **not** need to tell the reviewer to run `git diff` — in code mode the script captures the diff
and points the reviewer at the git-dir copy. **Resolve the review target first:** if
the work is uncommitted and tracked, the default `--target working` is right; name new files
explicitly with `--include-untracked`, or hand-build the exact patch and pass `--patch` (this keeps
unrelated untracked files out of the review); if the work is already committed, pass the
commit or range (`--target <sha>` or `--target <base>..<head>`). An empty target fails closed with exit
`5` — the reviewer never sees "nothing" and is never asked to approve it.

## Fail closed

Stop and tell the human when the script's `status` is not `ok`. The exit codes mirror codex-review:

- **`3` transport** — `opencode` unavailable/unauthenticated, timed out, or exited non-zero
  (`status: opencode_unavailable` | `timeout` | `failed` | `target_capture_failed`). Safe to retry once.
- **`5` contract** — the review target was empty (`status: empty_target`), or the reviewer's final
  message was not one valid schema-conforming verdict (`status: bad_verdict`). Do **not** retry — the
  same call fails identically; fix the target or investigate the reviewer output.

Do not downgrade to reviewing the work in your own (implementer) context — that is self-review, not
review, and defeats the skill. A malformed, missing, or empty verdict is a failure, not a pass. If
`readOnlyViolation` is `true`, the reviewer somehow changed the tree — treat the run as untrusted and
inspect the working tree before proceeding.
