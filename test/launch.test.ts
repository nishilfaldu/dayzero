import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { describeError } from "../src/launch.js";
import type { LaunchRecord, RunState } from "../src/state.js";
import { CONFIG, FakeLauncher, NOW, TASKS, run, tempDir } from "./fake.js";

async function project(files: Record<string, string> = {}) {
  return tempDir({ "tasks.yaml": TASKS, "proofline.yaml": CONFIG, ...files });
}

async function state(dir: string): Promise<RunState> {
  return JSON.parse(await readFile(join(dir, ".proofline", "run.json"), "utf8"));
}

async function dryRunPrompts(dir: string): Promise<Record<string, string>> {
  const { stdout } = await run(["run", "--dry-run"], dir);
  const prompts: Record<string, string> = {};
  for (const block of stdout.split(/^===== /m).filter(Boolean)) {
    const [header, ...rest] = block.split("\n");
    prompts[header!.split(" ")[0]!] = rest.join("\n").trimEnd();
  }
  return prompts;
}

describe("proofline run", () => {
  it("launches one agent per ticket on the tasks.yaml repo from main, with the rendered prompt", async () => {
    const dir = await project();
    const { code, launcher } = await run(["run"], dir);
    expect(code).toBe(0);
    const prompts = await dryRunPrompts(dir);
    expect(launcher.requests).toEqual([
      { repo: "acme/app", startingRef: "main", prompt: prompts.alpha },
      { repo: "acme/app", startingRef: "main", prompt: prompts.beta },
      { repo: "acme/app", startingRef: "main", prompt: prompts.gamma },
    ]);
    expect(launcher.apiKeys).toEqual(["test-key"]);
  });

  it("records ticket id, agent id, agent url, launch time and the exact prompt in .proofline/run.json", async () => {
    const dir = await project();
    await run(["run"], dir);
    const prompts = await dryRunPrompts(dir);
    const { launches } = await state(dir);
    expect(launches).toHaveLength(3);
    expect(launches[0]).toEqual<LaunchRecord>({
      ticketId: "alpha",
      agentId: "bc-fake-1",
      agentUrl: "https://cursor.com/agents/bc-fake-1",
      runId: "run-fake-1",
      launchedAt: NOW.toISOString(),
      repo: "acme/app",
      model: null,
      prompt: prompts.alpha!,
    });
    expect(launches.map((l) => l.prompt)).toEqual([prompts.alpha, prompts.beta, prompts.gamma]);
  });

  it("saves each launch before starting the next, so an interrupted run keeps what it launched", async () => {
    const dir = await project();
    const seenBySecondLaunch: string[] = [];
    const launcher = new FakeLauncher((request) => {
      if (request.prompt.includes("Fix beta")) {
        const saved: RunState = JSON.parse(readFileSync(join(dir, ".proofline", "run.json"), "utf8"));
        seenBySecondLaunch.push(...saved.launches.map((l) => l.ticketId));
      }
      return undefined;
    });
    await run(["run"], dir, { launcher });
    expect(seenBySecondLaunch).toEqual(["alpha"]);
  });

  it("never sends or records seeded", async () => {
    const dir = await project();
    const { launcher } = await run(["run"], dir);
    expect(JSON.stringify(launcher.requests)).not.toContain("planted beta leak");
    expect(await readFile(join(dir, ".proofline", "run.json"), "utf8")).not.toContain("planted beta leak");
  });

  it("prints each agent url and a summary", async () => {
    const dir = await project();
    const { stdout } = await run(["run"], dir);
    expect(stdout).toContain("launching 3 agent(s) on acme/app from main with the SDK default model");
    expect(stdout).toContain("launched alpha: https://cursor.com/agents/bc-fake-1");
    expect(stdout).toContain("launched 3 of 3; recorded in .proofline/run.json");
  });
});

describe("rerunning", () => {
  it("skips tickets already launched", async () => {
    const dir = await project();
    await run(["run"], dir);
    const second = await run(["run"], dir);
    expect(second.code).toBe(0);
    expect(second.launcher.requests).toEqual([]);
    expect(second.stdout).toContain("nothing to launch");
    expect(second.stdout).toContain("skipped 3 already launched (relaunch with --only <id> or --force): alpha, beta, gamma");
    expect((await state(dir)).launches).toHaveLength(3);
  });

  it("launches only the tickets that are new since the last run", async () => {
    const dir = await project();
    await writeFile(join(dir, "first.yaml"), TASKS.split("\n  - {id: beta")[0]!);
    await run(["run", "--tasks", "first.yaml"], dir);
    const second = await run(["run"], dir);
    expect(second.launcher.requests.map((r) => r.prompt.split(":")[0])).toEqual([
      "/poteto-mode security",
      "/poteto-mode bug",
    ]);
    expect(second.stdout).toContain("skipped 1 already launched (relaunch with --only <id> or --force): alpha");
    expect((await state(dir)).launches.map((l) => l.ticketId)).toEqual(["alpha", "beta", "gamma"]);
  });

  it("relaunches a ticket named with --only, and nothing else", async () => {
    const dir = await project();
    await run(["run"], dir);
    const again = await run(["run", "--only", "beta"], dir);
    expect(again.code).toBe(0);
    expect(again.launcher.requests).toHaveLength(1);
    expect(again.launcher.requests[0]!.prompt).toContain("Fix beta");
    expect((await state(dir)).launches.map((l) => l.ticketId)).toEqual(["alpha", "beta", "gamma", "beta"]);
  });

  it("accepts --only more than once", async () => {
    const dir = await project();
    const { launcher } = await run(["run", "--only", "gamma", "--only", "alpha"], dir);
    expect(launcher.requests.map((r) => r.prompt.split(":")[0])).toEqual(["/poteto-mode feature", "/poteto-mode bug"]);
  });

  it("relaunches every ticket with --force, keeping the earlier records", async () => {
    const dir = await project();
    await run(["run"], dir);
    const again = await run(["run", "--force"], dir);
    expect(again.launcher.requests).toHaveLength(3);
    expect((await state(dir)).launches.map((l) => l.ticketId)).toEqual(["alpha", "beta", "gamma", "alpha", "beta", "gamma"]);
  });

  it("rejects an --only id that isn't in tasks.yaml before launching anything", async () => {
    const dir = await project();
    const { code, stderr, launcherCreated } = await run(["run", "--only", "alpha", "--only", "nope"], dir);
    expect(code).toBe(2);
    expect(stderr).toBe('error: --only: no ticket with id "nope" in tasks.yaml\n');
    expect(launcherCreated).toBe(false);
  });

  it("refuses to launch over a corrupt run.json", async () => {
    const dir = await project();
    await mkdir(join(dir, ".proofline"));
    await writeFile(join(dir, ".proofline", "run.json"), "{ not json");
    const { code, stderr, launcherCreated } = await run(["run"], dir);
    expect(code).toBe(1);
    expect(stderr).toMatch(/error: \.proofline\/run\.json: not valid JSON/);
    expect(launcherCreated).toBe(false);
    expect(await readFile(join(dir, ".proofline", "run.json"), "utf8")).toBe("{ not json");
  });
});

describe("failures", () => {
  const failBeta = () =>
    new FakeLauncher((request) => {
      if (!request.prompt.includes("Fix beta")) return undefined;
      return Object.assign(new Error("Your prepaid balance is used up."), {
        name: "RateLimitError",
        code: "usage_limit_exceeded",
      });
    });

  it("keeps launching the other tickets and says which failed and why", async () => {
    const dir = await project();
    const { code, stdout, launcher } = await run(["run"], dir, { launcher: failBeta() });
    expect(code).toBe(1);
    expect(launcher.requests).toHaveLength(3);
    expect(stdout).toContain("launched 2 of 3");
    expect(stdout).toContain(
      "failed 1:\n  beta: RateLimitError: Your prepaid balance is used up. [usage_limit_exceeded]\n",
    );
    expect((await state(dir)).launches.map((l) => l.ticketId)).toEqual(["alpha", "gamma"]);
  });

  it("retries a failed ticket on the next run, and only that one", async () => {
    const dir = await project();
    await run(["run"], dir, { launcher: failBeta() });
    const retry = await run(["run"], dir);
    expect(retry.code).toBe(0);
    expect(retry.launcher.requests).toHaveLength(1);
    expect(retry.launcher.requests[0]!.prompt).toContain("Fix beta");
    expect((await state(dir)).launches.map((l) => l.ticketId)).toEqual(["alpha", "gamma", "beta"]);
  });

  it("reports non-Error throws too, and doesn't claim anything was recorded", async () => {
    const dir = await project();
    const launcher = new FakeLauncher(() => {
      throw "socket hang up";
    });
    const { code, stdout } = await run(["run", "--only", "alpha"], dir, { launcher });
    expect(code).toBe(1);
    expect(stdout).toContain("  alpha: socket hang up\n");
    expect(stdout).toContain("launched 0 of 1\n");
    await expect(readFile(join(dir, ".proofline", "run.json"), "utf8")).rejects.toThrow();
  });

  it("leaves out error codes that add nothing", () => {
    const authError = Object.assign(new Error("Invalid User API Key"), { name: "AuthenticationError", code: "error" });
    expect(describeError(authError)).toBe("AuthenticationError: Invalid User API Key");
    const echoed = Object.assign(new Error("[rate_limited] slow down"), { code: "rate_limited" });
    expect(describeError(echoed)).toBe("[rate_limited] slow down");
  });
});

describe("model", () => {
  it("passes the proofline.yaml model, with params, and records its id", async () => {
    const dir = await project({ "proofline.yaml": `model: {id: grok-4.5, params: {effort: low, fast: false}}\n${CONFIG}` });
    const { stdout, launcher } = await run(["run", "--only", "alpha"], dir);
    expect(launcher.requests[0]!.model).toEqual({
      id: "grok-4.5",
      params: [
        { id: "effort", value: "low" },
        { id: "fast", value: "false" },
      ],
    });
    expect(stdout).toContain("with grok-4.5");
    expect((await state(dir)).launches[0]!.model).toBe("grok-4.5");
  });

  it("accepts a bare model id", async () => {
    const dir = await project({ "proofline.yaml": `model: composer-2.5\n${CONFIG}` });
    const { launcher } = await run(["run", "--only", "alpha"], dir);
    expect(launcher.requests[0]!.model).toEqual({ id: "composer-2.5", params: [] });
  });

  it("sends no model when proofline.yaml has none, so the SDK default applies", async () => {
    const dir = await project();
    const { launcher } = await run(["run", "--only", "alpha"], dir);
    expect(launcher.requests[0]).not.toHaveProperty("model");
  });
});

describe("API key", () => {
  it("fails before launching anything when there is no key", async () => {
    const dir = await project();
    const { code, stderr, launcherCreated } = await run(["run"], dir, { env: {} });
    expect(code).toBe(1);
    expect(stderr).toBe("error: CURSOR_API_KEY is not set in the environment or in .env.local; nothing was launched\n");
    expect(launcherCreated).toBe(false);
    await expect(readFile(join(dir, ".proofline", "run.json"), "utf8")).rejects.toThrow();
  });

  it("treats an empty key as missing", async () => {
    const dir = await project({ ".env.local": "CURSOR_API_KEY=\n" });
    expect((await run(["run"], dir, { env: { CURSOR_API_KEY: "  " } })).code).toBe(1);
  });

  it("reads the key from .env.local when the environment has none", async () => {
    const dir = await project({ ".env.local": "# local secrets\nOTHER=x\nCURSOR_API_KEY=\"from-file\"\n" });
    const { code, launcher } = await run(["run"], dir, { env: {} });
    expect(code).toBe(0);
    expect(launcher.apiKeys).toEqual(["from-file"]);
  });

  it("prefers the environment over .env.local", async () => {
    const dir = await project({ ".env.local": "CURSOR_API_KEY=from-file\n" });
    const { launcher } = await run(["run"], dir, { env: { CURSOR_API_KEY: "from-env" } });
    expect(launcher.apiKeys).toEqual(["from-env"]);
  });

  it("is not needed when there is nothing to launch", async () => {
    const dir = await project();
    await run(["run"], dir);
    const { code, launcherCreated } = await run(["run"], dir, { env: {} });
    expect(code).toBe(0);
    expect(launcherCreated).toBe(false);
  });

  it("is checked after the config, so bad config is reported first", async () => {
    const dir = await project({ "tasks.yaml": "repo: acme/app\ntickets: []\n" });
    const { code, stderr } = await run(["run"], dir, { env: {} });
    expect(code).toBe(1);
    expect(stderr).toContain('field "tickets" must have at least one ticket');
    expect(stderr).not.toContain("CURSOR_API_KEY");
  });
});
