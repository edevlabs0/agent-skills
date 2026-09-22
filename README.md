# agent-skills

My personal collection of agent skills, installed straight from GitHub with the
[Skills CLI](https://github.com/vercel-labs/skills) — no npm account, no publishing.

```bash
npx skills add edevlabs0/agent-skills
```

## Skills

Three independent-review primitives, plus a workstream runner built on top of them.

| Skill | What it does | Reviewer CLI |
| --- | --- | --- |
| [`claude-review`](skills/claude-review/SKILL.md) | Independent, structured review of your work from a fresh `claude` process (clean context, read-only, model pinned at the CLI). Returns the same verdict shape as `codex-review`. | Claude Code (`claude`) |
| [`codex-review`](skills/codex-review/SKILL.md) | Hand the OpenAI Codex CLI a brief and get a light, **verified** read-only verdict (approve / changes_required + findings). Cross-vendor second opinion. | OpenAI Codex (`codex`) |
| [`opencode-review`](skills/opencode-review/SKILL.md) | Independent, structured review of your work from a fresh `opencode` process (clean context, read-only plan agent, model pinned via `--model` in `provider/model` form). Returns the same verdict shape as `codex-review`. | opencode (`opencode`) |
| [`ws-go`](skills/ws-go/SKILL.md) | Drive one workstream end to end: detect the implementer (whichever agent runs it), resolve the reviewer per run (flag, saved default, or ask), validate the WS against the real code before implementing, review each plan/change with the reviewer skills, verify with the project's gates, reconcile its docs and status with what actually shipped (deferred parts included), and hand back a fixed staging contract. You stay the implementer; it never stages or commits. | Resolved per run (`-reviewer`, `WS_GO_REVIEWER`, `~/.config/ws-go/config.json`, or ask) |

`claude-review`, `codex-review`, and `opencode-review` are review-only: you stay the implementer (whichever agent you run); the reviewer runs in a separate process and never edits your tree. `ws-go` orchestrates a full workstream but delegates every review to those skills — it plans, implements, and verifies, but never stages or commits.

## Install

Browse what's in the package first:

```bash
npx skills add edevlabs0/agent-skills --list
```

Install everything, or just one skill (any `name` from the table above):

```bash
npx skills add edevlabs0/agent-skills
npx skills add edevlabs0/agent-skills --skill claude-review
```

Install for a specific agent, or globally for every agent on the machine:

```bash
npx skills add edevlabs0/agent-skills --skill claude-review --agent claude-code
npx skills add edevlabs0/agent-skills --global
```

Works with any orchestrating agent the Skills CLI supports.

### Updating

After the skills are installed, pull future edits from this repo with:

```bash
npx skills update
```

That re-fetches every skill this repo provided and rewrites the installed copies in place, so an edit
here reaches each agent on its next `update`.

## Requirements

- **Node 18+** and **git** — to run the Skills CLI and fetch this repo.
- The reviewer CLI for whichever skill you use, authenticated as you would at the terminal:
  - `claude-review` → an authenticated **Claude Code** CLI (`claude`).
  - `codex-review` → an authenticated **OpenAI Codex** CLI (`codex`).
  - `opencode-review` → an authenticated **opencode** CLI (`opencode`).
- **No npm account and no publishing** — the Skills CLI installs directly from this GitHub repo.
- An orchestrating agent that can run shell commands and read files.

Each skill's `SKILL.md` carries its own prerequisites, flags, and a `doctor` check.

## License

MIT — see [LICENSE](LICENSE).
