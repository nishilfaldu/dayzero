// Manual smoke test against the real Cursor API. Not part of `npm test`.
//
// Launches the one trivial ticket in smoke/ (a SMOKE.md file on nishilfaldu/proofline)
// through the normal `proofline run` path, then polls the agent's first run until it
// finishes or 10 minutes pass. This spends real Cursor usage and opens a real PR.
//
//   npm run smoke

import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "@cursor/sdk";
import { main } from "../src/cli.js";
import { API_KEY_VAR, resolveApiKey } from "../src/env.js";
import { createCursorLauncher } from "../src/launcher.js";
import { readState } from "../src/state.js";

const POLL_MS = 10_000;
const TIMEOUT_MS = 10 * 60_000;

const root = fileURLToPath(new URL("..", import.meta.url));
const apiKey = await resolveApiKey(root, process.env);
if (!apiKey) {
  console.error(`smoke: ${API_KEY_VAR} is not set in the environment or in .env.local`);
  process.exit(1);
}

// A fresh directory, so the smoke launch never touches this checkout's .proofline/run.json.
const dir = await mkdtemp(join(tmpdir(), "proofline-smoke-"));
await cp(join(root, "smoke"), dir, { recursive: true });
console.log(`smoke: using ${apiKey.source} key; working in ${dir}\n`);

const code = await main(["run"], {
  cwd: dir,
  env: { [API_KEY_VAR]: apiKey.key },
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  createLauncher: (key) => createCursorLauncher(key),
  now: () => new Date(),
});
if (code !== 0) {
  console.error(`\nsmoke: FAILED to launch (exit ${code})`);
  process.exit(1);
}

const [launch] = (await readState(dir)).launches;
if (!launch) throw new Error("smoke: proofline exited 0 but recorded no launch");
console.log(`\nsmoke: launched ${launch.agentId} (run ${launch.runId}); watching for up to ${TIMEOUT_MS / 60_000} min`);

const started = Date.now();
let last = "";
for (;;) {
  const run = await Agent.getRun(launch.runId, { runtime: "cloud", agentId: launch.agentId, apiKey: apiKey.key });
  const seconds = Math.round((Date.now() - started) / 1000);
  if (run.status !== last) console.log(`smoke: ${seconds}s ${run.status}`);
  last = run.status;

  if (run.status !== "running") {
    for (const branch of run.git?.branches ?? []) {
      console.log(`smoke: branch ${branch.branch ?? "(none)"}${branch.prUrl ? `, PR ${branch.prUrl}` : ""}`);
    }
    if (run.error) console.log(`smoke: error ${run.error.code ? `[${run.error.code}] ` : ""}${run.error.message}`);
    console.log(`smoke: ${run.status === "finished" ? "PASSED" : "FAILED"}; see ${launch.agentUrl}`);
    process.exit(run.status === "finished" ? 0 : 1);
  }
  if (Date.now() - started > TIMEOUT_MS) {
    console.log(`smoke: still running after ${TIMEOUT_MS / 60_000} min; launch worked, check ${launch.agentUrl}`);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
