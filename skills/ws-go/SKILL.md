---
name: ws-go
description: >-
  Drive one workstream (WS) end to end with Codex review baked in: resolve which WS to work on,
  validate the WS's described tasks against the real code before touching anything, review each plan
  and code change with codex-review, verify with the project's real gates, close out the WS's docs and
  status, and hand back a fixed final-response contract ready for the human to stage and commit. Use
  when the user says "/ws-go", "start a workstream", "work the next WS", "run WS-<x>", or hands a
  workstream description and expects the standard validate/plan/implement + Codex-review + handoff
  cycle. Do NOT use for quick one-off edits, pure questions, or work the user explicitly wants done
  without Codex review.
metadata:
  version: 0.5.0
---

# WS-Go — workstream runner with Codex review

You are the **implementer and orchestrator** for one workstream. This skill standardizes the cycle
you repeat every WS so you never re-type it: **resolve the WS → validate it against the real code →
obey the rules → do the work → review it with [codex-review](../codex-review/SKILL.md) → verify →
close out its docs/status → hand back**. Codex-review is the engine; this skill decides *what* to run
and *how to report it*. One WS per run.

## Invocation flags

Flags may appear anywhere in the user's invocation (e.g. `/ws-go WS-C3 -defer-review`).

- **`-defer-review`** — do the implementation and verification in this session but **do not run the
  Codex review here**. Instead, hand back a ready-to-paste prompt so the review runs in a separate
  session. This is the **only** sanctioned exception to the "review is non-negotiable" rule, and it is
  strictly opt-in: never defer unless the user typed this flag. When it is set, skip Step 3, and end
  with the **deferred final response (Step 5b)** — never the standard one. The work is explicitly
  **UNREVIEWED**: do not call it approved, verified-for-merge, or "ready to commit", and do not invent
  a Codex verdict. Still write the review `brief.md` into the WS state dir so the separate session can
  point straight at it.

- **`-reviewer=<skill>[/<model>-<effort>]`** — **override the primary reviewer** for this run, replacing
  the `codex-review` default outright. Unlike `-reviewer-fallback` (which only activates when Codex is
  unavailable), this makes the named reviewer the one that actually runs, *even when Codex is available*
  — use it to deliberately review on Fable (to test `claude-review`, or to spend Fable quota instead of
  Codex quota). Grammar mirrors the fallback flag: `-reviewer=claude-review` (defaults to model `fable`,
  effort `high`) or `-reviewer=claude-review/fable-5-high`. The review is still **non-negotiable** — this
  changes *who* reviews, not *whether*. Constraints still hold: the reviewer model **must differ from the
  implementer's**, and Step 5 §3 must disclose the reviewer identity and its integrity tier (a
  `claude-review` verdict is semi-independent — never dress it up as a Codex one). If both `-reviewer` and
  `-reviewer-fallback` are given, `-reviewer` is the primary and the fallback backs *it* up.

- **`-reviewer-fallback=<skill>[/<model>-<effort>]`** — authorize a **fallback reviewer** for when the
  primary reviewer (by default `codex-review`, or whatever `-reviewer` set) is *unavailable*. It does
  not change the primary — it only names what to use if the primary can't be reached. Grammar: bare
  `-reviewer-fallback=claude-review` (defaults to model `fable`, effort `high`), or pin them with
  `-reviewer-fallback=claude-review/fable-5-high`. **Fallback fires only on genuine unavailability**:
  Codex quota exhausted, auth expired/unauthenticated, or transport/timeout (codex-review exit `3`,
  after its one sanctioned retry). It must **not** fire on CLI-missing/env/`doctor` failures, on
  integrity (exit `4`) or contract (exit `5`) failures, or any case where Codex actually returned a
  verdict — those still **fail closed** (see Fail closed). Without this flag, Codex unavailability
  **stops** the run. When the fallback is used, the reviewer model **must differ from the
  implementer's** model, and Step 5 §3 must disclose the reviewer identity and its weaker integrity
  tier — never present a claude-review verdict as a Codex one.

## Standing rules (every WS, non-negotiable)

- **Never implement a WS blindly — validate it first.** A WS doc is a claim about the code, and it may
  be stale, superseded, or wrong (the user may hand you an old WS that no longer applies). Before you
  plan or write anything, verify the WS's described tasks, steps, and plan against the *actual* current
  code (Step 1.5). Contradictions get resolved or escalated there — you do not carry an unverified
  assumption into implementation.
- **Any plan or code change is reviewed by Codex** via the `codex-review` skill. There is no
  "small enough to skip review" path in a WS run — that is the whole point of the cycle. The **only**
  exception is an explicit `-defer-review` flag (see Invocation flags), which does not skip the review
  but relocates it to a separate session and forbids any "approved / ready to commit" claim here.
- **Leave no stale docs or status behind.** A WS is not done until its own docs reflect what shipped
  and its status is moved off `open`/`in-progress` to `completed`/`done` (Step 4.5). The common failure
  is implementing the code and leaving the WS doc, plan, roadmap, and memory index still saying "open"
  — that is an unfinished WS, not a finished one.
- **Never stage, commit, or push.** You end by telling the human exactly what to stage; they commit.
  (Matches the user's global git rule.)
- **Scope tests to the stage** (user's global rule): during implementation run the closest
  test/method/file; when the area is complete run that module/area's tests; run the full suite once
  at final hand-back. Don't rebuild/reseed a test DB unless schema files changed.
- **Self-check with the guard skills before you hand off to review.** While implementing, consider
  running the relevant guards on what you changed so the reviewer sees already-clean work, not obvious
  issues: `clean-code-guard` on changed production code, `test-guard` on new/changed tests, and
  `docs-guard` when the change touches docs (including the WS's own `docs/<topic>/*` files and the
  status/doc updates from Step 4.5). These are a self-review pass, not a substitute for the
  Codex/fallback review in Step 3 — run them first, fix what they surface, then send the cleaner diff
  to the independent reviewer.
- **Obey the active project live, don't hardcode it.** Before touching anything, read the repo's
  root `CLAUDE.md`, the nearest directory-scoped `CLAUDE.md`, and any module `CLAUDE.md` for the
  area you'll change, plus the WS's own docs (`docs/<topic>/current-flow.md` as-is and any
  `*-plan.md` to-be). Those are the project's rules for this WS; follow them.

## Step 1 — Resolve the workstream

If the user gave a WS description or id, use it. Otherwise **propose candidates** from their latest
work and let them pick or specify one. Gather candidates from all three sources:

- **Git**: current branch name and the last ~10 commit subjects (`git branch --show-current`,
  `git log --oneline -10`) — infer the active WS line (e.g. `WS-C2`, `WS-C4`).
- **Docs plan files**: scan `docs/**/*-plan.md` and any `*-workstreams.md` for WS marked open,
  next, or in-progress.
- **Memory**: read the auto-memory index (`MEMORY.md`) for in-progress WS notes and decisions.

Present a short numbered list (WS id · one-line scope · source), then ask the user to choose or
describe a different one. Do not start work until the WS is fixed.

## Step 1.5 — Validate the WS against the real code (never implement blindly)

Before deciding deliverables or writing anything, **audit the WS's described tasks against the actual
current code.** The WS doc is a claim made at some earlier point; the code is the truth now. The user
may hand you an old or superseded WS, or one whose premises the code has since moved past. Do not trust
the WS narrative — check it.

For each task / step / claim / plan item in the WS, confirm against the real repo:

- **The premise still holds** — the file, function, route, table, config key, or behavior the task
  targets actually exists and works the way the WS assumes. (A WS that says "add X to `Foo::bar()`"
  when `bar()` was deleted or already does X is stale.)
- **The task isn't already done** — the change may have shipped in a prior session or a later commit.
  Re-implementing it is waste at best and a regression at worst.
- **The steps are internally consistent** — no step contradicts another, no step depends on an earlier
  step that the WS dropped, no acceptance criterion conflicts with a stated constraint.
- **It agrees with the project rules** — nothing in the WS contradicts the root/module `CLAUDE.md`,
  the current-flow docs, or an already-agreed decision.

Classify what you find and act:

- **Verified** — the task matches the code; proceed.
- **Already done** — say so, with the evidence (commit / code that already satisfies it), and drop or
  down-scope that task rather than redoing it.
- **Contradiction / inconsistency / error you can resolve confidently** — correct the task's
  description to match reality, state the correction and the evidence, and **confirm the correction with
  the reviewer** before building on it: a corrected understanding is a plan change, so route it through
  the same `codex-review` loop (Step 3) as a mini plan review. If the reviewer agrees, proceed on the
  corrected basis; record the correction so Step 5 §1 reflects it.
- **Contradiction you cannot resolve confidently** — do **not** guess, and do **not** implement on a
  shaky premise. Escalate:
  - **If a reviewer is running this session** (i.e. `-defer-review` is *not* set), put the ambiguity to
    the reviewer as a scoped question first. If the model and the reviewer *together* reach a confident
    answer, proceed on it (and disclose the reconciliation in Step 5 §1). If they still can't decide,
    **stop and ask the developer** — return a clear, well-explained clarification question (see below).
  - **If no reviewer is running** (`-defer-review` is set) — there is no live reviewer to confirm a
    correction with, so **always stop and ask the developer**. Never ship an unconfirmed guess on the
    deferred path.

A **clarification question to the developer** is a hard stop, not a footnote. State: which WS
task/step is in question; exactly what the WS claims vs. what the code actually shows (cite
file:line / commit); why it can't be resolved automatically; and 2–3 concrete options for how to
proceed, with your recommendation. Then wait — do not implement past an unresolved contradiction.

## Step 2 — Decide what this run produces

Establish what the WS run delivers, because each deliverable gets its own Codex review:

- **A plan** — an audit or improvement/implementation plan. Review it before writing code.
- **An implementation** — the code change. Review it before handing back.
- **Both** — plan first, get it reviewed, implement, then review the implementation.

Rules:

- If the plan was **already reviewed and agreed** (this WS's earlier session, or the user hands you an
  approved plan), don't re-plan — go straight to implementing and reviewing the code. (You still run
  Step 1.5: an agreed plan can still have gone stale against the code since it was agreed.)
- Any plan you author and any code you change **must** be reviewed via `codex-review` before it counts
  as done. There is no skip path.
- **State dir**: one per WS, stable and outside the repo, reused across sessions and across both the
  plan and implementation reviews — e.g. `<scratch>/ws-go/<ws-id>/`. Reusing it resumes the same Codex
  thread, so the implementation review remembers the plan review. Announce the path.
- **Model/effort**: pin an exact Codex model and, for anything non-trivial, `--effort high`.

## Step 3 — Run the codex-review loop

**If `-defer-review` was passed, skip this step** — write the `brief.md` into the WS state dir (so the
separate session can review from it), then go to Step 4 and finish with the deferred response (Step 5b).

Use the **codex-review** skill (`review` verb) as the default reviewer. For each deliverable: do the
work, write a brief describing it and what to scrutinize (for code, point the reviewer at the change),
then run `review` against the WS state dir. **Resolve the review target when writing the brief — don't
assume the WS is still uncommitted:** if the tree is dirty review `git diff HEAD` (plus named untracked
paths); if the human already committed the WS (a real case mid-run), point at the WS commit(s) instead
(`git show <sha>` / `git diff <base>..<head>`), and state that an empty diff is not an approval. Read the verdict;
if `changes_required`, fix each finding and re-`review` with the same state dir and a short delta brief.
Repeat until `approve`. Do not reverse roles, and never call advisory prose an approval.

**Reviewer selection and fallback.** The **primary reviewer** is `codex-review` by default, or whatever
`-reviewer=<skill>[/<model>-<effort>]` names if that flag was passed. Run the primary against the WS
state dir with the brief, and loop until `approve`.

- **`-reviewer` was passed** (e.g. `-reviewer=claude-review/fable-5-high`) → that reviewer *is* the
  primary; run it and do **not** touch Codex at all. This is the deliberate "review on Fable" path
  (testing `claude-review`, or sparing Codex quota). The review is still mandatory; only the reviewer
  changed. For `claude-review`, pin a model that **differs from the implementer's** (default `fable`,
  effort `high`).
- **No `-reviewer`** → Codex-review is primary, and unless the caller authorized a fallback it is the
  only reviewer — do not substitute a Claude subagent on your own initiative.

If the **primary** reviewer is *unavailable* — quota exhausted, unauthenticated/auth-expired, or
transport/timeout (codex-review exit `3`, after its one sanctioned retry) — then:

- if `-reviewer-fallback=<skill>[/<model>-<effort>]` was passed, run that fallback reviewer instead
  (typically [`claude-review`](../claude-review/SKILL.md)), against the **same WS state dir**, with the
  same brief. Pin the fallback model so it **differs from the implementer's** model (default `fable`,
  effort `high`), and run the identical `changes_required` → fix → re-review loop until `approve`;
- if no fallback was authorized, **fail closed** — stop and tell the human the primary is unavailable.

Do **not** fall back on CLI-missing/env/`doctor` failures, integrity (exit `4`), contract (exit `5`),
or any run where the primary actually produced a verdict — those fail closed regardless of the flag.
Whatever reviewer produced the accepted verdict, record which one it was; Step 5 §3 must disclose it and
its integrity tier.

## Step 4 — Verify

Discover the project's **real** gate commands from its docs/config (don't assume) and run them at
the right scope per the Standing rules. Record exact commands, exit codes, and **counts / failures /
skips** — never rely on memory or Codex's test claims. Missing required test evidence is a blocker,
not a footnote.

## Step 4.5 — Close the loop on docs & WS status

Code passing is not the finish line. A WS is done only when its **own documentation and status match
what actually shipped** — the standard failure mode is leaving the code changed but every doc still
describing the old world and every status field still saying `open`. Before the final response, sweep
and update, treating each edited doc as a reviewable change (it goes through Step 3 with the rest of the
diff, and `-defer-review` includes it in the deferred diff):

- **The WS doc itself** — mark its status `completed`/`done` (not `open`/`in-progress`/`next`), tick
  its checklist/acceptance items, and note anything intentionally left out of scope. If Step 1.5
  corrected a task, make the WS doc reflect the corrected reality, not the stale claim.
- **Plans, roadmaps, and workstream indexes** — any `*-plan.md`, `*-workstreams.md`, remediation
  roadmap, or tracking table that lists this WS: flip its entry to done and update any "next WS"
  pointer that now moves on.
- **Flow / behavior docs** — if the change altered behavior the docs describe (`current-flow.md`, API
  notes, READMEs, module docs), update them to the new behavior. Run `docs-guard` on these.
- **Memory index** — if the project keeps an auto-memory `MEMORY.md`, update or add the one-line
  pointer for this WS so the next session sees it as done, not open.

Do not invent status fields the project doesn't use, and don't touch unrelated docs — mirror the
project's existing doc/status conventions. If a doc's "done" wording is genuinely ambiguous, ask rather
than guess. List every doc/status file you touched in Step 5 §1 and include them in the stage list
(Step 5 §5).

## Step 5 — Final response (fixed contract)

When the WS is validated, reviewed, verified, its docs/status closed out, and ready to commit, end with
**exactly** these sections, in this order. Derive the review facts from the codex-review verdict/round
files under the WS state dir, not recollection. Never stage or commit.

1. **WHAT I DID** — the changes; any WS tasks Step 1.5 found already-done, corrected, or escalated (and
   how each resolved); the docs/status files closed out in Step 4.5; and any explicitly unchanged
   approved-risk areas.
2. **WHAT IT SOLVES** — per fix, a concrete before/after in the project's real domain terms.
3. **REVIEW** — which reviewer ran and its **integrity tier**: `codex-review` (independent, cross-vendor,
   CLI-verified) or, if the fallback was used, `claude-review` (semi-independent, same-family,
   by-construction — say so plainly and never dress it up as a Codex verdict). Then: what was reviewed
   (plan and/or code); how many rounds; the findings raised (severity · location) and how each was
   resolved (fixed / rejected-with-evidence / deferred); the final verdict; and the reviewer's identity
   proof — for Codex the exact model · verified sandbox · thread id; for claude-review the exact model
   (as seen in the reviewer process's init event, e.g. `claude-fable-5`) · effort · session id, noting
   the read-only/independence guarantees are by-construction, not verified.
4. **TEST RESULTS** — each command run, its exit code, and **counts: passed / failed / skipped**,
   naming any failures or skips.
5. **WHAT TO STAGE** — literal `git add` commands with hunk-level precision (include the Step 4.5
   docs/status files), **and** the dirty files to deliberately **leave unstaged** (with why). Format the
   commands **PowerShell-compatible**: wrap every path in double quotes, use forward slashes
   (`git add "database/sql_changes/eman/2026/2026-08-03/1- labels.sql"`), and quote unconditionally so
   paths containing spaces work. Give one `git add` per path (or a small grouped command); never emit a
   bare unquoted `git add path/with a space`.
6. **SUGGESTED COMMIT MESSAGE** — one per repository; no invented `Co-Authored-By` trailer. Present it
   as a **ready-to-copy, PowerShell-compatible `git commit` command**. For a multi-line message use a
   single-quoted here-string so `$` and backticks stay literal, with the closing `'@` at column 0:

   ```powershell
   git commit -m @'
   feat(ad-marketing): WS-C3 reservation + wallet money model + gates

   Longer body line here.
   '@
   ```

   A single-line message may instead use `git commit -m "…"`.
7. **MANUAL TEST LIST** — numbered steps with expected result each, plus the exact focused test
   command.
8. **NEXT-PHASE PROMPT or WS** — either a ready-to-paste cold-start prompt for the next phase of this
   WS (file paths, branch, commit hash once the human commits, state-dir path, deferred findings,
   dirty-worktree state, environment needs, next scope, session-start approval requirement), or the
   next candidate WS to pick up.

End with: `Nothing staged, nothing committed — that's yours.`

## Step 5b — Deferred final response (only when `-defer-review` was passed)

The review has **not** run. Do not use the Step 5 contract or its closing line, and make no
"approved / ready to commit" claim. Open with a one-line banner —
`⚠️ IMPLEMENTATION ONLY — CODEX REVIEW DEFERRED — DO NOT COMMIT UNTIL IT RETURNS approve` — then, in
this order:

1. **WHAT I DID** — the changes; any WS tasks Step 1.5 found already-done or corrected (contradictions
   the model couldn't resolve alone were escalated to you, not guessed — a `-defer-review` run stops at
   an unresolved contradiction rather than shipping it); the docs/status files closed out in Step 4.5;
   and any explicitly unchanged approved-risk areas.
2. **WHAT IT SOLVES** — per change, a concrete before/after in the project's real domain terms.
3. **TEST RESULTS** — each command run, its exit code, and **counts: passed / failed / skipped**,
   naming any failures or skips.
4. **REVIEW-SESSION PROMPT** — the ready-to-paste block for the separate session: the absolute
   **repo path**, the **WS state-dir** path, the **`brief.md`** path already written there, and the
   exact `codex-review` invocation to run — pinned model and `--effort`, `--repo`, `--brief`, the same
   `--state-dir`. Tell that session to **resolve the review target itself**: review `git diff HEAD` (plus
   named untracked paths) if the tree is still dirty, or the WS commit(s) (`git show <sha>` /
   `git diff <base>..<head>`) if the human committed in the meantime — and that an empty diff is not an
   approval. State the current worktree state (dirty vs which commit) as of hand-off.
5. **WHAT TO STAGE (AFTER REVIEW PASSES)** — the same PowerShell-compatible `git add` list as Step 5
   item 5 (including the Step 4.5 docs/status files), explicitly gated on an `approve` verdict.
6. **NEXT-PHASE PROMPT or WS** — as in Step 5 item 8.

End with: `Nothing staged, nothing committed, review deferred — run the prompt above to finish it.`

## Fail closed

Stop and tell the human if: the WS can't be fixed; **Step 1.5 surfaces a contradiction the model (and
the reviewer, when one is running) can't confidently resolve** — return the clarification question and
wait, do not implement past it; Codex is unavailable **and** no `-reviewer-fallback` was authorized (or
it failed for a non-fallback reason — CLI/env/`doctor`, integrity exit `4`, or contract exit `5`); the
authorized fallback reviewer is itself unavailable or returns a malformed verdict; a review (by either
reviewer) stays `changes_required` after reasonable rework; the reviewer's model/sandbox/thread (or
claude-review session) can't be recorded; or the project's gates can't be run or fail. Do not paper over
a failed gate, do not label advisory prose as an approval, and do not silently self-review — reviewing
the work in your own implementer context is never a valid substitute for the independent reviewer.
