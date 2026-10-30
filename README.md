# proofline

Write tickets in `tasks.yaml`; proofline starts one Cursor cloud agent per ticket, and each agent opens a PR on the target repo that carries its own evidence.

So far proofline validates the config, renders each ticket's prompt, and launches the agents. Tracking agents and verifying their PRs come later.

Requires Node 22.13 or later, which `@cursor/sdk` needs.

```sh
npm install
npm run proofline -- run --dry-run        # print every prompt; no API key, no network
npm run proofline -- run                  # launch an agent for each ticket not yet launched
npm run build && node dist/bin.js run     # same, from the build
npm test                                  # uses a fake Cursor client; no network
npm run smoke                             # manual: one real launch, see below
```

## Launching

`proofline run` starts one Cursor cloud agent per ticket using `@cursor/sdk`:
- **Where:** on `https://github.com/<repo>`, starting from `main`.
- **Prompt:** the ticket's rendered prompt.
- **PR:** `autoCreatePR` is on.

proofline returns as soon as each agent's first run is accepted. It doesn't wait for the agent to finish.

Each successful launch is appended to `.proofline/run.json` (gitignored) before the next one starts. A record holds the ticket id, agent id, agent URL, run id, launch time, repo, model, and the exact prompt sent.

- **Rerunning** skips tickets that already have a record.
- **`--only <id>`** (repeatable) launches just those tickets, even if they were launched before.
- **`--force`** relaunches every ticket. Relaunches add new records; old ones are kept.
- **A failed launch** doesn't stop the others. It is listed with its reason, isn't recorded, and is retried on the next plain `run`.
- **`CURSOR_API_KEY`** comes from the environment, or else from `.env.local`. If neither has it, proofline fails before launching anything. No key is needed when there's nothing to launch.
- **`--dry-run`** prints prompts exactly as before. It never reads `.proofline/` or the key. `--only` narrows which prompts it prints.

Exit codes:
- **0:** everything launched, or nothing needed to.
- **1:** invalid input, a missing key, or at least one failed launch.
- **2:** bad usage, including an unknown `--only` id.

## Inputs

- `tasks.yaml`: `repo` plus `tickets`, each with `id`, `type`, `title`, `description` and `done`, and optionally `seeded` and `evidence`. `type` is one of feature, bug, concurrency, perf, migration or security.
- `proofline.yaml`:
  - `model` (optional): a model id such as `composer-2.5`, or `{id: grok-4.5, params: {effort: low}}`. Without it, the SDK uses your account's default model.
  - `repro.default` (required): the repro line.
  - Optional `repro.<type>` lines that override the default for that ticket type.
  - `evidence.always` (list) and `evidence.by_type` (type → list).
- `prompts/ticket.md`: the prompt template, with `{type} {title} {description} {repro} {done} {evidence} {repo}` placeholders. `{repro}` is required.

A ticket's `{repro}` is its type's override if there is one, otherwise `repro.default`. The shipped config overrides only `feature`, with "write the failing e2e test first." A ticket's evidence is `always` + `by_type[type]` + its own `evidence`, with duplicates removed. `seeded` is never put in a prompt.

## Smoke test

`npm run smoke` makes one real launch:
1. Copies `smoke/` into a temp directory, so this checkout's `.proofline/run.json` is untouched.
2. Runs the normal `proofline run` there, which launches one trivial ticket: add `SMOKE.md` to `nishilfaldu/proofline`, on the default model.
3. Polls that agent's run for up to 10 minutes and prints its status, branch, PR and any error.

It exits 0 if the run finishes or is still running at the timeout, and 1 if the launch or the run fails. It spends real Cursor usage and opens a real PR.
