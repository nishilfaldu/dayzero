# dayzero

Write tickets in `tasks.yaml`. dayzero prepares the repo for Cursor cloud agents, starts one agent per ticket, and tracks each PR along with the proof it carries.

[Example run on Epic Stack →](examples/epic-stack)

## Install

Needs Node 22.13+, the [GitHub CLI](https://cli.github.com) logged in, and a Cursor API key. Run it from any folder; it doesn't have to be inside the target repo.

```sh
npx github:nishilfaldu/dayzero#v0.1.0 new
```

Or add it to a project: `npm i -D github:nishilfaldu/dayzero#v0.1.0`, then `npx dayzero …`.

## Use

```sh
dayzero new              # starter tasks.yaml + dayzero.yaml, gitignores .dayzero/ and .env.local
dayzero doctor           # checks Node, gh, CURSOR_API_KEY, the repo, and Cursor's access to it
dayzero init             # one agent opens a setup PR: pstack, verification skills, AGENTS.md, cloud env
dayzero status --watch   # follow it to its PR, then review and merge that PR
dayzero run              # one cloud agent per ticket (waits until init's PR is merged)
dayzero status --watch   # each ticket's agent and PR; labels PRs and adds the prompt to them
```

Every command takes `--help`. `init` and `run` take `--dry-run` to print the prompts without launching.

## Files

- `tasks.yaml`: `repo` (owner/name) and `tickets`, each with `id`, `type`, `title`, `description`, `done` and optional `evidence`. Types: feature, bug, concurrency, perf, migration, security.
- `dayzero.yaml`: optional `model`, the `repro` line per ticket type, and the `evidence` each type's PR must carry.
- `.env.local`: `CURSOR_API_KEY=…` (or set it in the environment).
- `.dayzero/run.json`: launch records written by `init` and `run`, read by `status`.

## How it decides

- `run` skips tickets already launched; `--only <id>` relaunches one, `--force` relaunches all.
- `run` refuses to start until init's PR is merged into `main`, since every agent starts from `main`.
- `status` finds each PR from Cursor or the agent's branch, and flags any PR that edits existing tests.
- `status --watch` keeps waiting a few minutes after an agent finishes or fails, because Cursor sometimes resumes a failed run.

## Develop

```sh
npm install
npm test          # uses fake Cursor and GitHub clients; no network
npm run dayzero -- run --dry-run
```

MIT licensed.
