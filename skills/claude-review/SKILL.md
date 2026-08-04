---
name: claude-review
description: >-
  Get an independent, structured review of your work from a fresh Claude reviewer running in a
  SEPARATE `claude` CLI process (clean context, read-only, model pinned at the CLI), returning the same
  verdict shape as codex-review (approve / changes_required + findings). You are the implementer; the
  reviewer is a different, pinned model in its own OS process with no access to your working chat — so
  the reviewer's model is decoupled from yours (Opus can implement while Fable reviews). Use when you
  want a second-opinion review of a plan or code change and an independent-vendor reviewer (Codex) is
  unavailable, or when you deliberately want a Claude reviewer on a different model than the implementer.
  Not for letting the reviewer implement — this is review only.
metadata:
  version: 0.2.0
---

# Claude Review

A review primitive that mirrors [codex-review](../codex-review/SKILL.md), but the reviewer is a **fresh
`claude` CLI process** instead of the Codex CLI. **You** (the caller) do the work — a plan or a code
change — then run one command that launches a separate `claude` process which reviews the repository
**read-only** and returns a structured verdict. The loop is identical:

> do work → write a brief → run the reviewer → read the verdict → (fix and re-review) → summarize.

The verdict shape is the **same** as codex-review (`assets/reviewer-verdict.schema.json`), so callers
like `ws-go` consume either reviewer without changing their report contract.

## Why a separate process (read this first)

The reviewer runs as its own `claude -p` process with `--model` pinned at the CLI — **not** as an
in-process Agent-tool subagent. This matters: an Agent-tool subagent inherits the orchestrator's
session model, so an Opus session reviewing with the Agent tool gets an **Opus reviewer no matter what
`model` you pass** — Opus reviewing Opus, which shares every blind spot and is close to worthless. The
separate process fixes that: the model you pass with `--model` is the model that actually runs (you can
see it in the child's `system/init` event, e.g. `"model": "claude-fable-5"`), completely independent of
the orchestrator's model. **Always cross the model line — the reviewer model must differ from the
implementer's.** Default reviewer model: `fable` while the implementer is Opus.

## Independence tier

This is a **weaker guarantee than codex-review**, by design, and must be labeled as such wherever the
verdict is reported:

- codex-review is **cross-vendor** (GPT/Codex) and its model + read-only sandbox are **verified by the
  CLI** (observed model, observed sandbox). That independence is what catches bugs a
  Claude-implementing-Claude would share.
- claude-review is **same-family**: a Claude process reviewing Claude's work shares training and blind
  spots. Using a **different model than the implementer** (e.g. Fable reviewing Opus) is what makes it
  useful.
- Its guarantees are **by construction**: independence comes from a fresh non-session process (no
  working-chat context); the model is pinned via `--model` and observable in the init event; read-only
  is enforced by `plan` permission mode with only `Read,Glob,Grep` (no Edit/Write/shell/MCP), plus a
  git-porcelain tripwire (`readOnlyViolation`). There is **no cryptographic observed-model/sandbox
  attestation** like Codex has — the init-event model and the tripwire are strong by-construction
  evidence, not a verified sandbox.

Order of preference when both exist: **codex-review (independent, verified) > claude-review
(semi-independent, by-construction) > no review.** Prefer it as a *fallback* tier; don't present its
verdict with the authority of a Codex one. "Independent" means *not the author's context*, not "not
Claude" — this skill works equally to have Claude review a Codex implementation.

## Requirements

Node 18+, Git, and an authenticated `claude` CLI (`claude auth login`) that supports
`-p --output-format stream-json`, `--permission-mode plan`, `--tools`, and `--model`. Verify with:

```text
node <skill-dir>/scripts/claude-review.mjs doctor
```

`doctor` reports whether `claude` was found (PATH or the well-known `~/.local/bin` install dir), its
version, git, and the default schema. If `claude` isn't on the child's PATH (common on Windows, where
git-bash injects `~/.local/bin` but a spawned process does not), pass `--claude-bin <path>` or set
`CLAUDE_REVIEW_CLI=<path>`.

## Reviewing

Write a brief to a file, then run one command. `<sd>` abbreviates `<skill-dir>/scripts/claude-review.mjs`.

```text
node <sd> review --repo <absolute-repo> --brief <absolute-brief> --model <id> \
  [--mode code|plan] [--target working|<a..b>|<commit>] [--effort low|medium|high|xhigh|max] \
  [--state-dir <absolute>] [--resume | --session <id>] [--schema <absolute>] \
  [--timeout-ms <ms>] [--claude-bin <path>]
```

Parameters (this is claude-review's equivalent of codex-review's flags):

- **`--repo`** — the git repository under review. The reviewer process runs there read-only.
- **`--brief`** — a file describing what you did and what to review. The reviewer sees **only this text,
  the captured diff, and the repository** — no chat history — so put everything needed in it (goal, what
  changed, what to scrutinize, constraints). See "Writing the brief".
- **`--model`** — the model to **pin for the reviewer** (`fable`, `claude-fable-5`, `sonnet`, `opus`, …).
  **Make it differ from the implementer's model.** Default: `fable`.
- **`--mode`** — `code` (default): the script captures the change as a diff and hands the reviewer that
  patch plus the repo. `plan`: no diff; the plan under review is carried in the brief.
- **`--target`** (code mode) — what to review: `working` (default = `git diff HEAD` **plus untracked
  files**), a range `A..B` (`git diff A..B`), or any other value treated as a commit (`git show`). The
  script **fails closed** if the target is empty — an empty diff is never an approval (exit `5`).
- **`--effort`** — real reviewer reasoning effort, passed to `claude --effort` (`low`…`max`). Default
  `high`. (Unlike the old Agent-tool version, this is a genuine CLI knob, not a brief instruction.)
- **`--state-dir`** — reused across rounds; holds `rounds/<NN>/` artifacts and `agent.json` (the session
  id for resume). Reuse it to keep all rounds of one review together; the script prints its path.

The command prints a JSON result on stdout: `verdict` (`approve` | `changes_required`), `summary`,
`findings[]` (`severity` blocker/major/minor · `location` · `problem` · `required_change`), plus
`reviewer` (`model`, `effort`, `integrity: by-construction`, `claudeVersion`, `sessionId`,
`readOnlyViolation`) and the artifact paths. The script itself persists `verdict.json`, `report.md`,
`target.diff`, `prompt.txt`, and `events.jsonl` per round, and `agent.json` for resume — you do **not**
have to write those.

## The rework loop

1. Do the work (write the plan, or make the code change).
2. `review` with a brief. Read the verdict JSON from stdout.
3. If `changes_required`, address each finding, then `review` again **with the same `--state-dir` and
   `--resume`** and a short delta brief ("addressed F1 by …; re-review"). The script resumes the same
   `claude` session (analog of Codex `exec resume`) and re-captures the current diff, so the reviewer
   sees the prior round *and* your fixes.
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
into `rounds/<NN>/target.diff` and points the reviewer at it. **Resolve the review target first:** if
the work is uncommitted, the default `--target working` is right; if it's already committed, pass the
commit or range (`--target <sha>` or `--target <base>..<head>`). An empty target fails closed with exit
`5` — the reviewer never sees "nothing" and is never asked to approve it.

## Fail closed

Stop and tell the human when the script's `status` is not `ok`. The exit codes mirror codex-review:

- **`3` transport** — `claude` unavailable/unauthenticated, timed out, or exited non-zero
  (`status: claude_unavailable` | `timeout` | `failed` | `target_capture_failed`). Safe to retry once.
- **`5` contract** — the review target was empty (`status: empty_target`), or the reviewer's final
  message was not one valid schema-conforming verdict (`status: bad_verdict`). Do **not** retry — the
  same call fails identically; fix the target or investigate the reviewer output.

Do not downgrade to reviewing the work in your own (implementer) context — that is self-review, not
review, and defeats the skill. A malformed, missing, or empty verdict is a failure, not a pass. If
`readOnlyViolation` is `true`, the reviewer somehow changed the tree — treat the run as untrusted and
inspect the working tree before proceeding.
