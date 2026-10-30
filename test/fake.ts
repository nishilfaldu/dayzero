import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Io, main } from "../src/cli.js";
import type { LaunchRequest, LaunchedAgent, Launcher } from "../src/launcher.js";

/** Records every launch; `fail` decides per request whether to throw instead. */
export class FakeLauncher implements Launcher {
  readonly requests: LaunchRequest[] = [];
  readonly apiKeys: string[] = [];
  constructor(private readonly fail: (request: LaunchRequest) => Error | undefined = () => undefined) {}

  async launch(request: LaunchRequest): Promise<LaunchedAgent> {
    this.requests.push(request);
    const error = this.fail(request);
    if (error) throw error;
    const agentId = `bc-fake-${this.requests.length}`;
    return { agentId, runId: `run-fake-${this.requests.length}`, agentUrl: `https://cursor.com/agents/${agentId}` };
  }
}

export const NOW = new Date("2026-10-30T12:00:00.000Z");

export async function run(
  argv: string[],
  cwd: string,
  { launcher = new FakeLauncher(), env = { CURSOR_API_KEY: "test-key" } as NodeJS.ProcessEnv } = {},
) {
  let stdout = "";
  let stderr = "";
  let launcherCreated = false;
  const io: Io = {
    cwd,
    env,
    stdout: (t) => {
      stdout += t;
    },
    stderr: (t) => {
      stderr += t;
    },
    createLauncher: (apiKey) => {
      launcherCreated = true;
      launcher.apiKeys.push(apiKey);
      return launcher;
    },
    now: () => NOW,
  };
  const code = await main(argv, io);
  return { code, stdout, stderr, launcher, launcherCreated };
}

export async function tempDir(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "proofline-"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

export const TASKS = `repo: acme/app
tickets:
  - {id: alpha, type: feature, title: Add alpha, description: Alpha please., done: alpha shows}
  - {id: beta, type: security, title: Fix beta, description: Beta leaks., done: beta is closed, seeded: planted beta leak}
  - {id: gamma, type: bug, title: Fix gamma, description: Gamma crashes., done: gamma works}
`;

export const CONFIG = `repro:
  default: repro it.
  feature: write the test first.
evidence:
  always: [decision log]
`;
