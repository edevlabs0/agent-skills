---
name: ws-go
description: >-
  Drive one workstream (WS) end to end with independent review baked in: resolve which WS to work on,
  validate the WS's described tasks against the real code before touching anything, review each plan
  and code change with a separately-configured reviewer skill, verify with the project's real gates,
  reconcile the WS's docs and status with what actually shipped (deferred parts included), and hand
  back a fixed final-response contract ready for the human to stage and commit. The implementer is
  whichever agent runs this skill; the reviewer is selected per run (flag, saved default, or ask).
  Use when the user says "/ws-go", "start a workstream", "work the next WS", "run WS-<x>", or hands a
  workstream description and expects the standard validate/plan/implement + independent-review +
  handoff cycle. Do NOT use for quick one-off edits, pure questions, or work the user explicitly
  wants done without review.
metadata:
  version: 0.7.0
---

# WS-Go — workstream runner with independent review

You are the **implementer and orchestrator** for one workstream — and "you" is whichever agent
runs this skill (Claude Code, Codex CLI, OpenCode, or any orchestrating agent with shell access),
not a fixed model. This skill standardizes the cycle you repeat every WS so you never re-type it:
**detect implementer + resolve reviewer (Step 0) → resolve the WS → validate it against the real
code → obey the rules → do the work → review it with the resolved reviewer skill → verify →
reconcile its docs/status with what shipped → hand back**. The reviewer skill is the engine; this
skill decides *what* to run and *how to report it*. One WS per run.

The reviewer is **never you in your own context**. It is always a separate review skill running in
its own process (e.g. [codex-review](../codex-review/SKILL.md),
[claude-review](../claude-review/SKILL.md),
[opencode-review](../opencode-review/SKILL.md)), pinned to a model that **differs from the
implementer's**. Any direction works: Claude can implement while Codex reviews, Codex can
implement while Claude reviews, or opencode can review either — what matters is that implementer
and reviewer are independent of each other, never self-review.

## Invocation flags

Flags may appear anywhere in the user's invocation (e.g. `/ws-go WS-C3 -defer-review`).

- **`-defer-review`** — do the implementation and verification in this session but **do not run the
  review here**. Instead, hand back a ready-to-paste prompt so the review runs in a separate
  session. This is the **only** sanctioned exception to the "review is non-negotiable" rule, and it is
  strictly opt-in: never defer unless the user typed this flag (or explicitly picked "defer" when
  asked to select a reviewer — see Step 0). When it is set, skip Step 3, and end
  with the **deferred final response (Step 5b)** — never the standard one. The work is explicitly
  **UNREVIEWED**: do not call it approved, verified-for-merge, or "ready to commit", and do not invent
  a review verdict. Still write the review `brief.md` into the WS state dir so the separate session can
  point straight at it.

- **`-reviewer=<skill>[/<model>-<effort>]`** — **select the reviewer** for this run. There is no
  built-in default: this flag is the highest-priority way to set the reviewer, and it replaces any
  saved default or interactive pick. Grammar: `-reviewer=codex-review` or
  `-reviewer=claude-review` (those two skills fill in their own documented model/effort defaults), or pin
  them with `-reviewer=codex-review/<model>-high` /
  `-reviewer=claude-review/fable-5-high`. For `opencode-review` the model is `provider/model`
  (it contains a slash), so the form is `-reviewer=opencode-review/<provider>/<model>-<effort>`
  (e.g. `-reviewer=opencode-review/opencode/muse-spark-1.3-contributor-free-high` — skill is the
  first segment, effort is after the last dash, everything between is the model); bare
  `-reviewer=opencode-review` is not enough since that skill requires an explicit `--model`.
  The review is still **non-negotiable** — this
  changes *who* reviews, not *whether*. Constraints still hold: the reviewer **must run in its own
  process and its model must differ from the implementer's** (see Step 0), and Step 5 §3 must
  disclose the reviewer identity and its integrity tier for this implementer×reviewer pairing. If
  both `-reviewer` and `-reviewer-fallback` are given, `-reviewer` is the primary and the fallback
  backs *it* up.

- **`-reviewer-fallback=<skill>[/<model>-<effort>]`** — authorize a **fallback reviewer** for when the
  primary reviewer (whatever Step 0 resolved) is *unavailable*. It does
  not change the primary — it only names what to use if the primary can't be reached. Grammar mirrors
  `-reviewer`: bare `-reviewer-fallback=claude-review` or pinned
  `-reviewer-fallback=claude-review/fable-5-high`. **Fallback fires only on genuine unavailability**:
  quota exhausted, auth expired/unauthenticated, or transport/timeout (reviewer exit `3`,
  after its one sanctioned retry). It must **not** fire on CLI-missing/env/`doctor` failures, on
  integrity (exit `4`) or contract (exit `5`) failures, or any case where the primary actually returned a
  verdict — those still **fail closed** (see Fail closed). Without this flag, primary unavailability
  **stops** the run (unless the user authorizes a fallback when asked). When the fallback is used, the
  fallback reviewer **must also run in its own process with a model that differs from the
  implementer's**, and Step 5 §3 must disclose the reviewer identity and its integrity
  tier — never present a same-family verdict with the authority of a cross-vendor one.

## Standing rules (every WS, non-negotiable)

- **Never implement a WS blindly — validate it first.** A WS doc is a claim about the code, and it may
  be stale, superseded, or wrong (the user may hand you an old WS that no longer applies). Before you
  plan or write anything, verify the WS's described tasks, steps, and plan against the *actual* current
  code (Step 1.5). Contradictions get resolved or escalated there — you do not carry an unverified
  assumption into implementation.
- **Any plan or code change is reviewed by the resolved independent reviewer** (see Step 0).
  There is no "small enough to skip review" path in a WS run — that is the whole point of the cycle.
  The **only** exception is an explicit `-defer-review` flag (see Invocation flags), which does not
  skip the review but relocates it to a separate session and forbids any "approved / ready to commit"
  claim here.
- **Leave no stale docs behind — reconcile them with what actually shipped.** Before hand-back, the
  WS's own docs and status must match reality *as of this run* (Step 4.5), so the next agent trusts them
  instead of acting on a stale claim. "Reality" is not always "completed": a run may ship some parts and
  **defer others**, correct scope, or split the WS. Record what that run's actual outcome was — parts
  done, parts deferred/remaining, decisions made — rather than blindly flipping the status to `done`.
  The failure this prevents is leaving the code changed while the WS doc, plan, roadmap, and memory
  index still describe the pre-run world.
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
  independent review in Step 3 — run them first, fix what they surface, then send the cleaner diff
  to the independent reviewer.
- **Obey the active project live, don't hardcode it.** Before touching anything, read the repo's
  root agent rules (`AGENTS.md` where it exists, `CLAUDE.md` where it exists — read both when both
  exist), the nearest directory-scoped rules, and any module rules for the
  area you'll change, plus the WS's own docs (`docs/<topic>/current-flow.md` as-is and any
  `*-plan.md` to-be). Those are the project's rules for this WS; follow them.

## Step 0 — Detect implementer, resolve reviewer (runs first, every WS)

Do this before anything else. It fixes *who implements* and *who reviews* for the whole run.

### 0A — Detect and record the implementer

The implementer is whatever agent invoked this skill. At run time it is implicit — it is this
session — so no file is needed to route the work. Record it anyway, because later readers need it:
Step 3 (to pin a different reviewer model), Step 5 §3 (review proof), and the deferred session
(Step 5b, where this session is gone). Do not assume Claude, Codex, or any fixed model:

- **Agent / vendor** — which harness is running (Claude Code, Codex CLI, OpenCode, other). Use the
  session context if it names the harness; otherwise record what you can observe (e.g. which CLI
  launched you) and mark the rest `unknown`.
- **Model** — the exact implementing model id if visible (session/init event, system prompt, agent
  config). If it is not visible, record `unknown` rather than guessing.

Hold this record in memory through Step 1 — the WS state dir does not exist yet (its name needs the
WS id). Write it into `ws.json` once the state dir exists (end of Step 1, see Step 2) and announce
it (e.g. `Implementer: Codex CLI / gpt-5.4`). Every later step derives from that record. If the
implementer is `unknown`, the reviewer must still be a separate review-skill process; note the
weaker identity proof in Step 5 §3.

### 0B — Resolve the reviewer

Resolution order (first hit wins):

1. **`-reviewer` flag** — explicit per-run choice; use it as-is.
2. **`WS_GO_REVIEWER` env var** — per-agent saved choice (e.g. export it in the agent's shell
   profile). Same `<skill>[/<model>-<effort>]` grammar as the flag. This is how one machine gives
   Claude runs a different default reviewer than Codex runs.
3. **Config file** — shared saved choice at `~/.config/ws-go/config.json` (honor
   `$XDG_CONFIG_HOME` when set: `$XDG_CONFIG_HOME/ws-go/config.json`). Single JSON object, e.g.
   `{ "defaultReviewer": "codex-review" }` or
   `{ "defaultReviewer": "claude-review/fable-5-high" }` — same grammar as the flag. If the file
   exists and `defaultReviewer` parses, use it.
4. **Ask the user** — if none of the above set a reviewer, stop and ask before doing any WS work.
   Offer the review skills installed on this host **by name** (the host resolves each name to its
   own skill path — never store or guess directory paths; at minimum `codex-review`,
   `claude-review`, and `opencode-review`, plus any other installed `*-review` skill the host reports), one line each with
   its integrity character (cross-vendor vs same-family *for this implementer*), plus two extra
   options: `defer-review` (equal to passing `-defer-review`) and `none — stop`. Include a
   follow-up on the selected reviewer: `save as default?` — writing the choice as
   `defaultReviewer` into the config file above (and noting the `WS_GO_REVIEWER` alternative for a
   per-agent-only default). Do not start Step 1 until the user picks a reviewer, defers, or stops.

Write the resolved reviewer (skill + model + effort) into `ws.json` alongside the Step 0A record
once the state dir exists (end of Step 1). The saved value is always a skill **name** — path
resolution is the host's job. If the host cannot resolve the name, fail closed with a clear error
instead of guessing a path.

Rules:

- The reviewer **must be a separate review skill in its own process** — never review in your own
  implementer context, never substitute an in-process subagent that inherits your model.
- The reviewer **model must differ from the implementer's model**. When both are the same family
  (Claude reviewing Claude work, Codex reviewing Codex work), this is what keeps the review useful —
  pin a different model explicitly (each review skill documents its model default; override it when
  it collides with the Step 0A record).
- `-reviewer-fallback` never selects the primary — it only authorizes what Step 3 may use when the
  primary is genuinely unavailable.

## Step 1 — Resolve the workstream

If the user gave a WS description or id, use it. Otherwise **propose candidates** from their latest
work and let them pick or specify one. Gather candidates from all three sources:

- **Git**: current branch name and the last ~10 commit subjects (`git branch --show-current`,
  `git log --oneline -10`) — infer the active WS line (e.g. `WS-C2`, `WS-C4`).
- **Docs plan files**: scan `docs/**/*-plan.md` and any `*-workstreams.md` for WS marked open,
  next, or in-progress.
- **Memory**: read the auto-memory index (`MEMORY.md`) for in-progress WS notes and decisions.

Present a short numbered list (WS id · one-line scope · source), then ask the user to choose or
describe a different one. Do not start work until the WS is fixed. Once it is fixed, create the WS
state dir (see Step 2) and write `ws.json` — the single WS config holding the Step 0A implementer
record and the Step 0B resolved reviewer (skill + model + effort) — then continue.

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
  the same review loop (Step 3) as a mini plan review. If the reviewer agrees, proceed on the
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

Establish what the WS run delivers, because each deliverable gets its own independent review:

- **A plan** — an audit or improvement/implementation plan. Review it before writing code.
- **An implementation** — the code change. Review it before handing back.
- **Both** — plan first, get it reviewed, implement, then review the implementation.

Rules:

- If the plan was **already reviewed and agreed** (this WS's earlier session, or the user hands you an
  approved plan), don't re-plan — go straight to implementing and reviewing the code. (You still run
  Step 1.5: an agreed plan can still have gone stale against the code since it was agreed.)
- Any plan you author and any code you change **must** be reviewed by the Step 0 reviewer before it
  counts as done. There is no skip path.
- **State dir**: one per WS, stable and outside the repo, reused across sessions and across both the
  plan and implementation reviews — e.g. `<scratch>/ws-go/<ws-id>/`. Reusing it resumes the same
  reviewer thread (where the review skill supports resume), so the implementation review remembers
  the plan review. Holds `ws.json` (the single WS config: WS id, Step 0A implementer, Step 0B
  reviewer) alongside the briefs and verdicts. Announce the path.
- **Model/effort**: pin an exact reviewer model (one that differs from the Step 0A implementer) and,
  for anything non-trivial, high effort (`--effort high` or the review skill's equivalent).

## Step 3 — Run the review loop

**If `-defer-review` was passed (or the user picked defer in Step 0), skip this step** — write the
`brief.md` into the WS state dir (so the separate session can review from it), then go to Step 4 and
finish with the deferred response (Step 5b).

Run the **Step 0 reviewer** (the `review` verb of whichever review skill Step 0 resolved). For each
deliverable: do the work, write a brief describing it and what to scrutinize (for code, point the
reviewer at the change), then run `review` against the WS state dir. **Resolve the review target when
writing the brief — don't assume the WS is still uncommitted:** if the tree is dirty review
`git diff HEAD` (plus named untracked paths); if the human already committed the WS (a real case
mid-run), point at the WS commit(s) instead (`git show <sha>` / `git diff <base>..<head>`), and state
that an empty diff is not an approval. Read the verdict;
if `changes_required`, fix each finding and re-`review` with the same state dir and a short delta brief.
Repeat until `approve`. Do not reverse roles, and never call advisory prose an approval.

**Primary and fallback.** The **primary reviewer** is whatever Step 0 resolved. Run it against the WS
state dir with the brief, and loop until `approve`. Do not substitute a different reviewer — and
never an in-process subagent — on your own initiative.

If the **primary** reviewer is *unavailable* — quota exhausted, unauthenticated/auth-expired, or
transport/timeout (reviewer exit `3`, after its one sanctioned retry) — then:

- if `-reviewer-fallback=<skill>[/<model>-<effort>]` was passed (or the user authorizes one when
  asked), run that fallback reviewer instead, against the **same WS state dir**, with the
  same brief. Pin the fallback model so it **differs from the implementer's** model, and run the
  identical `changes_required` → fix → re-review loop until `approve`;
- if no fallback was authorized, **fail closed** — stop and tell the human the primary is unavailable.

Do **not** fall back on CLI-missing/env/`doctor` failures, integrity (exit `4`), contract (exit `5`),
or any run where the primary actually produced a verdict — those fail closed regardless of the flag.
Whatever reviewer produced the accepted verdict, record which one it was; Step 5 §3 must disclose it and
its integrity tier.

## Step 4 — Verify

Discover the project's **real** gate commands from its docs/config (don't assume) and run them at
the right scope per the Standing rules. Record exact commands, exit codes, and **counts / failures /
skips** — never rely on memory or the reviewer's test claims. Missing required test evidence is a blocker,
not a footnote.

## Step 4.5 — Reconcile the WS's docs & status with what shipped

Code passing is not the finish line. The **docs and status this WS owns must describe what this run
actually did** — the standard failure mode is leaving the code changed while every doc still describes
the pre-run world and every status field still says `open`, so a later agent acts on a stale claim. The
goal is *truth*, not a green checkmark: if the run shipped everything, say completed; if it shipped some
parts and **deferred** or split the rest, say exactly that. Before the final response, sweep and update,
treating each edited doc as a reviewable change (it goes through Step 3 with the rest of the diff, and
`-defer-review` includes it in the deferred diff):

- **The WS doc itself** — set its status to the *true* state (`completed` only if fully done; otherwise
  `partially done` / `in-progress` with an explicit "shipped this run" vs. "deferred / remaining" split,
  using whatever status vocabulary the project already uses). Tick the acceptance items that genuinely
  landed, leave the rest unticked, and record what was deferred and why. If Step 1.5 corrected a task,
  make the WS doc reflect the corrected reality, not the stale claim.
- **Plans, roadmaps, and workstream indexes** — any `*-plan.md`, `*-workstreams.md`, remediation
  roadmap, or tracking table that lists this WS: move its entry to match reality (done, or
  partially-done with the deferred items still tracked), and update any "next WS" pointer accordingly.
- **Flow / behavior docs** — if the change altered behavior the docs describe (`current-flow.md`, API
  notes, READMEs, module docs), update them to the *new, shipped* behavior — only for what actually
  landed, not what's still deferred. Run `docs-guard` on these.
- **Memory index** — if the project keeps an auto-memory `MEMORY.md`, update or add the one-line
  pointer so the next session sees the accurate state (done, or done-except-<deferred>), not the stale
  "open".

Update docs to reflect *what shipped*, no more: don't mark deferred work as done, don't invent status
fields the project doesn't use, and don't touch unrelated docs — mirror the project's existing
doc/status conventions. If the right status wording is genuinely ambiguous, ask rather than guess. List
every doc/status file you touched in Step 5 §1 and include them in the stage list (Step 5 §5).

## Step 5 — Final response (fixed contract)

When the WS is validated, reviewed, verified, its docs/status reconciled with what shipped, and ready
to commit, end with
**exactly** these sections, in this order. Derive the review facts from the reviewer's verdict/round
files under the WS state dir, not recollection. Never stage or commit.

1. **WHAT I DID** — the changes; any WS tasks Step 1.5 found already-done, corrected, or escalated (and
   how each resolved); the docs/status files reconciled in Step 4.5 (say what shipped vs. what was
   deferred, and how the WS status now reads); and any explicitly unchanged approved-risk areas.
2. **WHAT IT SOLVES** — per fix, a concrete before/after in the project's real domain terms.
3. **REVIEW** — the Step 0A implementer (`agent / model` from `ws.json`); which reviewer ran
   and its **integrity tier for this pairing**: `codex-review` is cross-vendor and CLI-verified when
   the implementer is *not* Codex (independent, strongest), and same-family when a Codex agent
   implements and Codex reviews (useful, but say so plainly); `claude-review` is cross-vendor and
   by-construction when the implementer is *not* Claude, and semi-independent same-family when
   Claude implements and Claude reviews (useful only with a different model — say so plainly and
   never dress it up with cross-vendor authority); `opencode-review` is cross-vendor and
   by-construction when the implementer is *not* opencode, and semi-independent same-family when
   an opencode agent implements and opencode reviews (useful only with a different model — say so
   plainly, same rule as claude-review). Then: what was reviewed
   (plan and/or code); how many rounds; the findings raised (severity · location) and how each was
   resolved (fixed / rejected-with-evidence / deferred); the final verdict; and the reviewer's identity
   proof — for codex-review the exact model · verified sandbox · thread id; for claude-review the exact model
   (as seen in the reviewer process's init event, e.g. `claude-fable-5`) · effort · session id, noting
   the read-only/independence guarantees are by-construction, not verified; for opencode-review the exact
   `provider/model` · effort · agent · session id from the JSON event stream, noting the read-only
   (plan agent) and independence guarantees are by-construction, not verified.
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

## Step 5b — Deferred final response (only when review was deferred)

The review has **not** run. Do not use the Step 5 contract or its closing line, and make no
"approved / ready to commit" claim. Open with a one-line banner —
`⚠️ IMPLEMENTATION ONLY — REVIEW DEFERRED — DO NOT COMMIT UNTIL IT RETURNS approve` — then, in
this order:

1. **WHAT I DID** — the changes; any WS tasks Step 1.5 found already-done or corrected (contradictions
   the model couldn't resolve alone were escalated to you, not guessed — a `-defer-review` run stops at
   an unresolved contradiction rather than shipping it); the docs/status files reconciled in Step 4.5
   (what shipped vs. what was deferred, and how the WS status now reads); and any explicitly unchanged
   approved-risk areas.
2. **WHAT IT SOLVES** — per change, a concrete before/after in the project's real domain terms.
3. **TEST RESULTS** — each command run, its exit code, and **counts: passed / failed / skipped**,
   naming any failures or skips.
4. **REVIEW-SESSION PROMPT** — the ready-to-paste block for the separate session: the Step 0A
   implementer and Step 0B reviewer records (from `ws.json`), the absolute **repo path**, the **WS
   state-dir** path, the **`brief.md`** path already written there, and the exact reviewer invocation
   to run — review skill name, pinned model (different from the implementer) and effort, `--repo`,
   `--brief`, the same `--state-dir`.
   Tell that session to **resolve the review target itself**: review `git diff HEAD` (plus
   named untracked paths) if the tree is still dirty, or the WS commit(s) (`git show <sha>` /
   `git diff <base>..<head>`) if the human committed in the meantime — and that an empty diff is not an
   approval. State the current worktree state (dirty vs which commit) as of hand-off.
5. **WHAT TO STAGE (AFTER REVIEW PASSES)** — the same PowerShell-compatible `git add` list as Step 5
   item 5 (including the Step 4.5 docs/status files), explicitly gated on an `approve` verdict.
6. **NEXT-PHASE PROMPT or WS** — as in Step 5 item 8.

End with: `Nothing staged, nothing committed, review deferred — run the prompt above to finish it.`

## Fail closed

Stop and tell the human if: the WS can't be fixed; no reviewer could be resolved in Step 0 (user
picked "none — stop"); **Step 1.5 surfaces a contradiction the model (and
the reviewer, when one is running) can't confidently resolve** — return the clarification question and
wait, do not implement past it; the primary reviewer is unavailable **and** no `-reviewer-fallback`
was authorized (or it failed for a non-fallback reason — CLI/env/`doctor`, integrity exit `4`, or
contract exit `5`); the authorized fallback reviewer is itself unavailable or returns a malformed
verdict; a review (by either reviewer) stays `changes_required` after reasonable rework; the
implementer's identity (Step 0A) or the reviewer's model/sandbox/thread (or reviewer session) can't
be recorded; or the project's gates can't be run or fail. Do not paper over
a failed gate, do not label advisory prose as an approval, and do not silently self-review — reviewing
the work in your own implementer context is never a valid substitute for the independent reviewer.
