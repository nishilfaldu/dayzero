# proofline

Write tickets in `tasks.yaml`; proofline starts one Cursor cloud agent per ticket, and each agent opens a PR on the target repo that carries its own evidence.

Part 1 reads and validates the config and renders each ticket's prompt. It makes no Cursor or GitHub calls.

```sh
npm install
npm run proofline -- run --dry-run        # from source
npm run build && node dist/bin.js run --dry-run
npm test
```

`--tasks <file>` and `--config <file>` override the default `tasks.yaml` and `proofline.yaml` in the current directory. Prompts go to stdout and errors to stderr. The exit code is 1 for invalid input and 2 for bad usage.

## Inputs

- `tasks.yaml`: `repo` plus `tickets`, each with `id`, `type`, `title`, `description` and `done`, and optionally `seeded` and `evidence`. `type` is one of feature, bug, concurrency, perf, migration or security.
- `proofline.yaml`:
  - `repro.default` (required): the repro line.
  - Optional `repro.<type>` lines that override the default for that ticket type.
  - `evidence.always` (list) and `evidence.by_type` (type → list).
- `prompts/ticket.md`: the prompt template, with `{type} {title} {description} {repro} {done} {evidence} {repo}` placeholders. `{repro}` is required.

A ticket's `{repro}` is its type's override if there is one, otherwise `repro.default`. The shipped config overrides only `feature`, with "write the failing e2e test first." A ticket's evidence is `always` + `by_type[type]` + its own `evidence`, with duplicates removed. `seeded` is never put in a prompt.
