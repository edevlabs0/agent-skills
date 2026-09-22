---
name: codex-review
description: >-
  Hand the OpenAI Codex CLI a brief and have it review your work read-only, returning a light
  structured verdict (approve / changes_required + findings). You (any implementing agent) are the
  implementer; the Codex CLI is the independent reviewer. Use when you want an independent Codex
  review of a plan or a code change you produced, with an optional rework loop. The reviewer model
  must differ from the implementer's. Not for letting Codex implement or for
  ordinary single-agent work.
---

# Codex Review

A lean review primitive. **You** (whichever agent runs this skill — Claude Code, Codex CLI, OpenCode,
or other) do the work — a plan or a code change — then hand Codex a
brief and it reviews the repository **read-only** and returns a structured verdict. That is the whole
loop:

> do work → write a brief → `review` → read the verdict → (fix and re-review) → summarize for the human.

There are **no git-tree restrictions, no gates, and no prescribed hand-back** — you decide when to
call it, what the brief covers, and what to tell the human afterward. If you need a fixed
report shape, that belongs in the calling workflow (e.g. the `ws-go` skill), not here.

The one guarantee kept: every round is **verified** to have run read-only, at the exact model you
pinned, in the target repo. That verification is what makes this a trustworthy review rather than an
unchecked opinion — do not remove it or substitute self-review in your own implementer context for
the separate Codex process. Pin a reviewer model that **differs from the implementer's model**;
when a Codex agent implements and Codex reviews, the pairing is same-family, so say so plainly in
the report rather than claiming cross-vendor independence.

## Requirements

Node 18+, Git, and an authenticated Codex CLI (`codex login`) that supports `codex exec --json`,
`--output-schema`, `-c sandbox_mode`, and `exec resume`. Verify with:

```text
node <skill-dir>/scripts/codex-review.mjs doctor
```

`doctor` prints which Codex launcher it resolved. On Windows the script finds the Codex desktop app's
`codex.exe`, a `codex.exe` on PATH, or an npm install (it runs the package's `bin/codex.js` with Node,
because the `codex.cmd` shim cannot be spawned directly). To point at a specific install, set
`CODEX_BIN=<path>` (a `codex` binary, or a `codex.js` entry file).

## Reviewing

Write a brief to a file, then run one command. `<sd>` abbreviates `<skill-dir>/scripts/codex-review.mjs`.

```text
node <sd> review --repo <absolute-repo> --brief <absolute-brief> --model <exact-model-id> [--effort minimal|low|medium|high] [--state-dir <absolute>] [--schema <absolute>] [--timeout-ms <ms>]
```

- **`--repo`** — the git repository to review in. Codex runs there read-only and can read any file or
  run read-only commands (`git diff`, `grep`, …) to inspect your work.
- **`--brief`** — a file describing what you did and what to review. This is the scope: name the plan,
  the files, or say "review the uncommitted changes (`git diff HEAD`)". Codex sees only this text plus
  the repository — no chat history — so put everything needed in it.
- **`--model`** — pin an exact Codex model id; do not rely on the global default. It is verified.
  It must differ from the implementer's model (Step 0A in `ws-go`, or your session model otherwise).
- **`--effort`** — optional reasoning effort (`model_reasoning_effort`); omit to inherit Codex config.
- **`--state-dir`** — optional. Reuse the **same** dir to resume the same Codex thread for a rework
  round (Codex remembers the prior round). Omit it for a one-shot review in a temp dir.

The command prints JSON: `verdict` (`approve` | `changes_required`), `summary`, `findings[]`
(`severity` blocker/major/minor · `location` · `problem` · `required_change`), plus the verified
`observedModel` / `observedSandbox`, the `threadId`, and artifact paths.

## The rework loop

1. Do the work (write the plan, or make the code change).
2. `review` with a brief. Read the verdict.
3. If `changes_required`, address each finding, then `review` again **with the same `--state-dir`**
   and a short delta brief ("addressed F1 by …; re-review"). Codex resumes the thread and sees the
   prior round.
4. Repeat until `approve`, then summarize for the human however fits the task.

Don't paper over findings and don't call advisory prose an approval — the verdict is the signal.

## Writing the brief

Keep it to one review. Include: the goal, what you changed (or the plan), what to focus on, and any
constraints Codex should judge against. For a code review, point Codex at the change explicitly —
either list the files or tell it to run `git diff HEAD` — since the harness no longer scopes the diff
for you. For a rework round, send only the delta (which findings you addressed and how).

**Resolve the review target first — don't assume the work is uncommitted.** If the tree is dirty,
review `git diff HEAD` (plus any named untracked paths). If it is already committed, point at the
specific commit or range instead (`git show <sha>`, `git diff <base>..<head>`). Tell the reviewer that
**an empty diff is not an approval**: if the named target shows no changes, it must say so and stop,
not approve.

## Fail closed

Stop and tell the human when Codex is unavailable, unauthenticated, times out, or exits non-zero; the
thread, model, sandbox, or cwd cannot be verified; or the output is not a valid verdict. The failure
exit codes are `3` transport (safe to retry once), `4` integrity, and `5` contract (do not retry —
the same call fails identically). Do not replace a failed Codex round with self-review in your own
implementer context.
