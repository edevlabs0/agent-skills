# agent-skills

My personal collection of agent skills, installed straight from GitHub with the
[Skills CLI](https://github.com/vercel-labs/skills) — no npm account, no publishing.

```bash
npx skills add edevlabs0/agent-skills
```

## Skills

| Skill | What it does | Reviewer CLI |
| --- | --- | --- |
| [`claude-review`](skills/claude-review/SKILL.md) | Independent, structured review of your work from a fresh `claude` process (clean context, read-only, model pinned at the CLI). Returns the same verdict shape as `codex-review`. | Claude Code (`claude`) |
| [`codex-review`](skills/codex-review/SKILL.md) | Hand the OpenAI Codex CLI a brief and get a light, **verified** read-only verdict (approve / changes_required + findings). Cross-vendor second opinion. | OpenAI Codex (`codex`) |

Both are review-only: you stay the implementer; the reviewer runs in a separate process and never edits your tree.

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
- **No npm account and no publishing** — the Skills CLI installs directly from this GitHub repo.
- An orchestrating agent that can run shell commands and read files.

Each skill's `SKILL.md` carries its own prerequisites, flags, and a `doctor` check.

## License

MIT — see [LICENSE](LICENSE).
