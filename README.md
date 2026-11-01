# dayzero

Write tickets in `tasks.yaml`; dayzero starts one Cursor cloud agent per ticket, and each agent opens a PR on the target repo that carries its own evidence.

So far dayzero sets the target repo up for agents, validates the config, renders each ticket's prompt, launches the agents, and tracks them to their PRs. Verifying the PRs comes later.

Requires Node 22.13 or later, which `@cursor/sdk` needs.

```sh
npm install
npm run dayzero -- init --dry-run       # print the setup prompt; no API key, no network
npm run dayzero -- init                 # launch the one setup agent on the repo
npm run dayzero -- status --watch       # follow it to its PR; then review and merge that PR
npm run dayzero -- run --dry-run        # print every prompt; no API key, no network
npm run dayzero -- run                  # once init's PR is merged: an agent per ticket not yet launched
npm run dayzero -- status               # agent state + PR per ticket; labels and annotates PRs
npm run dayzero -- status --watch       # same, every 60s until nothing is pending
npm run build && node dist/bin.js run     # same, from the build
npm test                                  # uses a fake Cursor client; no network
```

## Init

`dayzero init` launches one cloud agent that sets the target repo up so later agents can take tickets and prove their work. It works the same way as `run`: the `tasks.yaml` repo, `main`, the `dayzero.yaml` model, and `CURSOR_API_KEY`.

**The prompt** is [prompts/init.md](prompts/init.md), with `{repo}` filled in; no other placeholder is allowed. It asks for one PR adding:
- pstack, pinned
- a verification skill and a formal verification skill
- AGENTS.md with commands that were actually run
- a cloud environment setup

**Recording:** the launch goes in `.dayzero/run.json` with `ticketId: "init"` and `kind: "init"`, and no type. `status` and `status --watch` show it as its own `init` row with type `-`. Its PR gets the prompt section but no label. `init` is reserved, so no ticket can use that id.

- **`--dry-run`** prints the prompt and launches nothing.
- **Running `init` again** refuses while an init is recorded, and names the existing agent. **`--force`** launches another one; the earlier record is kept.

**`run` waits for init's PR to be merged.** Every agent starts from `main`, so ticket agents only get pstack, the skills, AGENTS.md and the environment setup once init's PR is merged there. Before launching anything, `run` looks up the recorded init's agent and PR, the same way `status` does, and refuses unless that PR is merged into `main`. The error says what's missing:
- no init is recorded for the `tasks.yaml` repo
- the init agent is still running, or ended without a PR
- its PR is still open, or was merged into a branch other than `main`

If init was launched more than once, any one of them with a merged PR is enough. `--skip-init-check` launches without checking and prints a warning. The check is skipped on `--dry-run` and when there's nothing to launch.

So the order is: `init`, `status --watch` until its PR is up, review and merge that PR, then `run`.

## Launching

`dayzero run` starts one Cursor cloud agent per ticket using `@cursor/sdk`:
- **Where:** on `https://github.com/<repo>`, starting from `main`.
- **Prompt:** the ticket's rendered prompt.
- **PR:** `autoCreatePR` is on.

dayzero returns as soon as each agent's first run is accepted. It doesn't wait for the agent to finish.

Each successful launch is appended to `.dayzero/run.json` (gitignored) before the next one starts. A record holds the ticket id and type, agent id, agent URL, run id, launch time, repo, model, and the exact prompt sent.

- **Rerunning** skips tickets that already have a record.
- **`--only <id>`** (repeatable) launches just those tickets, even if they were launched before.
- **`--force`** relaunches every ticket. Relaunches add new records; old ones are kept.
- **A failed launch** doesn't stop the others. It is listed with its reason, isn't recorded, and is retried on the next plain `run`.
- **`CURSOR_API_KEY`** comes from the environment, or else from `.env.local`. If neither has it, dayzero fails before launching anything. No key is needed when there's nothing to launch.
- **The init check** needs a GitHub token from `gh auth token`, like `status` (see Auth below), unless `--skip-init-check` is passed.
- **`--dry-run`** prints prompts exactly as before. It never reads `.dayzero/` or the key. `--only` narrows which prompts it prints.

Exit codes:
- **0:** everything launched, or nothing needed to.
- **1:** invalid input, a missing key or GitHub token, init's PR not merged into `main`, or at least one failed launch.
- **2:** bad usage, including an unknown `--only` id.

## Status

`dayzero status` reads `.dayzero/run.json` and checks each ticket's latest launch. It prints a table:

```
TICKET            TYPE         AGENT     PR
init              -            finished  https://github.com/nishilfaldu/epic-stack/pull/12 (merged)
share-notes       feature      finished  https://github.com/nishilfaldu/epic-stack/pull/13
note-delete-idor  security     running   no PR yet (branch cursor/note-delete-1a2b not pushed yet)
reset-code-race   concurrency  error     branch cursor/reset-race-9f8e never reached GitHub
```

**Type** is the one recorded in `run.json` at launch. Records written before types were recorded fall back to the ticket's type in `tasks.yaml`, which is only read in that case. If neither has it, the type shows as `?` and no label is added.

**Agent state** comes from the agent's newest run, which may be a follow-up started from the Cursor web app. **The branch and PR** come from the newest run that reports them.

**The PR is found** in one of two ways, and GitHub is always asked to confirm it:
- **From Cursor's `prUrl`:** used only if GitHub has that PR, opened against the tasks repo, from the agent's branch.
- **From the branch:** otherwise dayzero looks up a PR from the branch, preferring an open one.

If there's no PR, the PR column says why:
- the branch is pushed but has no PR yet
- the branch isn't pushed yet
- the branch never reached GitHub
- the agent failed or finished without creating a branch

Once a PR is confirmed, `status` brings it up to date. Running it again changes nothing:
- **Label:** the ticket type. It's created in the repo if missing, and isn't re-added if already there.
- **Description:** a "Prompt sent by dayzero" section with the exact prompt is appended, between `<!-- dayzero:prompt -->` markers. A later run only replaces that section, and only if it differs.
- **Test files:** if the PR edits, deletes or renames existing test files, one comment lists them. It's marked `<!-- dayzero:test-files -->` and updated in place if the list changes. New test files don't count.
  - A test file is anything under `test/`, `tests/`, `__tests__/`, `spec/`, `specs/`, `e2e/` or `__snapshots__/`.
  - It's also any file named like `*.test.*`, `*.spec.*`, `*_test.*` or `test_*`.

**Errors:** a failed Cursor or GitHub lookup for one ticket shows in its row and on stderr, and the rest carry on. The exit code is then 1.

**`--watch`** re-checks every 60 seconds, printing a timestamped table each time. It keeps going while any ticket is still pending, and stops once none are. The exit code is that of the last check.

A ticket is pending if:
- **its agent is running.** A failed lookup counts too, so it gets retried.
- **its agent finished less than 5 minutes ago and has no confirmed PR.** The PR column counts down, e.g. `no PR yet; waiting 3m20s more (branch cursor/x is on GitHub)`. After 5 minutes it reads `finished without a PR (…)` and the watch stops waiting on it.
- **its agent failed less than 10 minutes ago.** Cursor sometimes reports a run as failed and then carries on with it, so the watch keeps re-checking, e.g. `no PR (agent failed); re-checking for 7m10s more in case Cursor resumes it`. If the agent goes back to running, it's followed as usual. After 10 minutes the watch stops waiting on it.

Finish and failure times come from Cursor: the run's start plus its duration. If Cursor doesn't report one, the clock starts when the watch first sees the agent finished or failed. An agent that fails again after recovering gets a fresh 10 minutes.

Cancelled and unknown agents aren't waited on. Plain `status` never waits.

`run.json` is re-read on every check, so launches made meanwhile are picked up.

**Auth:** the GitHub token comes only from `gh auth token`, run with `GH_TOKEN` and `GITHUB_TOKEN` removed from its environment. gh would otherwise print those instead, so the token is always the account `gh auth login` stored. If there's no token, or GitHub rejects it, `status` and `run`'s init check stop and say to run `gh auth login`. `CURSOR_API_KEY` is found the same way as for `run`.

## Inputs

- `tasks.yaml`: `repo` plus `tickets`, each with `id`, `type`, `title`, `description` and `done`, and optionally `evidence`. Any other key is an error, and the id `init` is reserved. `type` is one of feature, bug, concurrency, perf, migration or security.
- `dayzero.yaml`:
  - `model` (optional): a model id such as `composer-2.5`, or `{id: grok-4.5, params: {effort: low}}`. Without it, the SDK uses your account's default model.
  - `repro.default` (required): the repro line.
  - Optional `repro.<type>` lines that override the default for that ticket type.
  - `evidence.always` (list) and `evidence.by_type` (type → list).
- `prompts/init.md`: the `dayzero init` prompt; only `{repo}` is filled in.
- `prompts/ticket.md`: the ticket prompt template, with `{type} {title} {description} {repro} {done} {evidence} {repo}` placeholders. `{repro}` is required.

A ticket's `{repro}` is its type's override if there is one, otherwise `repro.default`. The shipped config overrides `feature`, with "write the failing e2e test first.", and `migration`, with "record the current versions and a passing test run on main first." A ticket's evidence is `always` + `by_type[type]` + its own `evidence`, with duplicates removed.
