# Example: Epic Stack

The tickets and config dayzero ran against [nishilfaldu/epic-stack](https://github.com/nishilfaldu/epic-stack), a fork of Kent C. Dodds' Epic Stack.

Five tickets, one per type: feature, concurrency, security, perf and migration. The resulting PRs are [#1](https://github.com/nishilfaldu/epic-stack/pull/1) (init) and [#2–#6](https://github.com/nishilfaldu/epic-stack/pulls?q=is%3Apr).

Use it to try dayzero end to end:

```sh
npm install                                 # from the repo root; builds dist/
cd examples/epic-stack
node ../../dist/bin.js run --dry-run        # print the five prompts; no key, no network
node ../../dist/bin.js doctor               # check gh, the key and Cursor's access
node ../../dist/bin.js status               # re-check the recorded agents and their PRs
```

`status` needs the launch records in `.dayzero/` (gitignored, so only on the machine that ran them). Launching for real against your own fork means changing `repo` in `tasks.yaml`.
