import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateTasks } from "../src/config.js";
import { checkInitTemplate, loadInitTemplate, renderInitPrompt } from "../src/init.js";
import type { LaunchRecord, RunState } from "../src/state.js";
import { PROMPT_START } from "../src/status.js";
import { CONFIG, FakeLauncher, NOW, TASKS, run, tempDir } from "./fake.js";
import { FakeAgents, FakeGitHub } from "./fake-status.js";

const EXPECTED_PROMPT = `/poteto-mode set up this repo so cloud agents can take tickets and prove their work.
done means one pr on acme/app that adds:
- pstack, installed at the project level and pinned to a version
- a verification skill for this app, made with /create-verification-skill
- a formal verification skill, made with /create-formal-verification-skill
- AGENTS.md with the install, run and test commands, each one actually run
- cloud environment setup so later agents start with dependencies installed
the pr shows the app running and the test suite result.
if pstack's skills aren't available in this session after installing it, say so in the pr instead of faking them.
don't ask me before committing or opening the pr. if you're truly stuck, stop and write up why.`;

async function project(files: Record<string, string> = {}) {
  return tempDir({ "tasks.yaml": TASKS, "proofline.yaml": CONFIG, ...files });
}

async function state(dir: string): Promise<RunState> {
  return JSON.parse(await readFile(join(dir, ".proofline", "run.json"), "utf8"));
}

describe("init --dry-run", () => {
  it("prints the exact init prompt for the tasks.yaml repo and launches nothing", async () => {
    const dir = await project();
    const { code, stdout, stderr, launcherCreated } = await run(["init", "--dry-run"], dir, { env: {} });
    expect(code).toBe(0);
    expect(stdout).toBe(`===== init =====\n${EXPECTED_PROMPT}\n`);
    expect(stderr).toBe("\ndry run: init prompt for acme/app; nothing was launched\n");
    expect(launcherCreated).toBe(false);
    await expect(readFile(join(dir, ".proofline", "run.json"), "utf8")).rejects.toThrow();
  });

  it("still prints the prompt when an init is already recorded", async () => {
    const dir = await project();
    await run(["init"], dir);
    const { code, stdout } = await run(["init", "--dry-run"], dir);
    expect(code).toBe(0);
    expect(stdout).toContain(EXPECTED_PROMPT);
  });

  it("reports invalid config like run does", async () => {
    const dir = await project({ "proofline.yaml": "evidence: {always: [log]}\n" });
    const { code, stderr } = await run(["init", "--dry-run"], dir);
    expect(code).toBe(1);
    expect(stderr).toContain('proofline.yaml: field "repro" is required');
  });
});

describe("init", () => {
  it("launches one agent on the tasks.yaml repo from main with the init prompt and the configured model", async () => {
    const dir = await project({ "proofline.yaml": `model: composer-2.5\n${CONFIG}` });
    const { code, stdout, launcher } = await run(["init"], dir);
    expect(code).toBe(0);
    expect(launcher.requests).toEqual([
      { repo: "acme/app", startingRef: "main", prompt: EXPECTED_PROMPT, model: { id: "composer-2.5", params: [] } },
    ]);
    expect(stdout).toContain("launching the init agent on acme/app from main with composer-2.5");
    expect(stdout).toContain("launched init: https://cursor.com/agents/bc-fake-1");
    expect(stdout).toContain("follow it with `proofline status --watch`");
  });

  it("records the launch as init, with no type", async () => {
    const dir = await project();
    await run(["init"], dir);
    expect((await state(dir)).launches).toEqual<LaunchRecord[]>([
      {
        ticketId: "init",
        kind: "init",
        agentId: "bc-fake-1",
        agentUrl: "https://cursor.com/agents/bc-fake-1",
        runId: "run-fake-1",
        launchedAt: NOW.toISOString(),
        repo: "acme/app",
        model: null,
        prompt: EXPECTED_PROMPT,
      },
    ]);
  });

  it("refuses to launch a second init", async () => {
    const dir = await project();
    await run(["init"], dir);
    const again = await run(["init"], dir);
    expect(again.code).toBe(1);
    expect(again.launcherCreated).toBe(false);
    expect(again.stderr).toBe(
      `error: init was already launched at ${NOW.toISOString()}: https://cursor.com/agents/bc-fake-1\nnothing was launched; run \`proofline init --force\` to launch another\n`,
    );
    expect((await state(dir)).launches).toHaveLength(1);
  });

  it("launches another with --force, keeping the first record", async () => {
    const dir = await project();
    await run(["init"], dir);
    const again = await run(["init", "--force"], dir);
    expect(again.code).toBe(0);
    expect(again.launcher.requests).toHaveLength(1);
    expect((await state(dir)).launches.map((l) => [l.ticketId, l.kind])).toEqual([
      ["init", "init"],
      ["init", "init"],
    ]);
  });

  it("refuses even when the recorded init isn't the latest launch", async () => {
    const dir = await project();
    await run(["init"], dir);
    await run(["run"], dir);
    expect((await run(["init"], dir)).code).toBe(1);
  });

  it("reports a failed launch, records nothing, and lets a plain init retry", async () => {
    const dir = await project();
    const failing = new FakeLauncher(() => Object.assign(new Error("Your prepaid balance is used up."), { name: "RateLimitError" }));
    const first = await run(["init"], dir, { launcher: failing });
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("failed   init: RateLimitError: Your prepaid balance is used up.");
    await expect(readFile(join(dir, ".proofline", "run.json"), "utf8")).rejects.toThrow();
    expect((await run(["init"], dir)).code).toBe(0);
  });

  it("fails before launching when there is no API key", async () => {
    const dir = await project();
    const { code, stderr, launcherCreated } = await run(["init"], dir, { env: {} });
    expect(code).toBe(1);
    expect(stderr).toContain("CURSOR_API_KEY is not set");
    expect(launcherCreated).toBe(false);
  });

  it("rejects --only and --watch", async () => {
    const dir = await project();
    expect((await run(["init", "--only", "alpha"], dir)).stderr).toContain("--only only applies to `proofline run`");
    expect((await run(["init", "--watch"], dir)).stderr).toContain("--watch only applies to `proofline status`");
  });
});

describe("run and init together", () => {
  const WARNING = "warning: no `proofline init` launch is recorded";

  it("run warns when no init is recorded, but still launches", async () => {
    const dir = await project();
    const { code, stderr, launcher } = await run(["run"], dir);
    expect(code).toBe(0);
    expect(stderr).toContain(WARNING);
    expect(stderr).toContain("Launching anyway");
    expect(launcher.requests).toHaveLength(3);
  });

  it("run doesn't warn once an init is recorded", async () => {
    const dir = await project();
    await run(["init"], dir);
    const { stderr } = await run(["run"], dir);
    expect(stderr).not.toContain(WARNING);
  });

  it("run doesn't warn on --dry-run or when there is nothing to launch", async () => {
    const dir = await project();
    expect((await run(["run", "--dry-run"], dir)).stderr).not.toContain(WARNING);
    await run(["run"], dir);
    expect((await run(["run"], dir)).stderr).not.toContain(WARNING);
  });

  it("an init record doesn't count as a launched ticket, and run --force doesn't relaunch init", async () => {
    const dir = await project();
    await run(["init"], dir);
    const first = await run(["run"], dir);
    expect(first.launcher.requests).toHaveLength(3);
    const forced = await run(["run", "--force"], dir);
    expect(forced.launcher.requests.map((r) => r.prompt.split(":")[0])).toEqual([
      "/poteto-mode feature",
      "/poteto-mode security",
      "/poteto-mode bug",
    ]);
    expect((await state(dir)).launches.filter((l) => l.kind === "init")).toHaveLength(1);
  });

  it("reserves the ticket id init", () => {
    const tasks = { repo: "a/b", tickets: [{ id: "init", type: "bug", title: "T", description: "D", done: "X" }] };
    expect(() => validateTasks(tasks)).toThrow('tasks.yaml: ticket "init": field "id" "init" is reserved for `proofline init`');
  });
});

describe("status with an init launch", () => {
  async function withInit() {
    const dir = await project();
    await run(["init"], dir);
    return dir;
  }

  it("shows init as its own row with no type, and gives its PR the prompt but no label", async () => {
    const dir = await withInit();
    const github = new FakeGitHub();
    const pull = github.addPull({ number: 5, headRef: "cursor/init" });
    const agents = new FakeAgents({ "bc-fake-1": { state: "finished", branch: "cursor/init" } });
    const { code, stdout } = await run(["status"], dir, { agents, github });
    expect(code).toBe(0);
    expect(stdout).toContain("init    -     finished  https://github.com/acme/app/pull/5");
    expect(stdout).not.toContain("type unknown");
    expect(pull.labels).toEqual([]);
    expect(github.writes.some((w) => w.includes("abel"))).toBe(false);
    expect(pull.body).toContain(PROMPT_START);
    expect(pull.body).toContain("`proofline init`, agent [bc-fake-1]");
    expect(pull.body).toContain(EXPECTED_PROMPT);
  });

  it("doesn't need tasks.yaml for the init row", async () => {
    const dir = await withInit();
    await writeFile(join(dir, "tasks.yaml"), "not: [valid");
    const agents = new FakeAgents({ "bc-fake-1": { state: "running" } });
    const { code, stdout } = await run(["status"], dir, { agents });
    expect(code).toBe(0);
    expect(stdout).toContain("init    -     running");
  });

  it("lists init alongside tickets, and --watch waits on it like any other agent", async () => {
    const dir = await project();
    const record = (ticketId: string, agentId: string, extra: Partial<LaunchRecord>): LaunchRecord => ({
      ticketId,
      agentId,
      agentUrl: `https://cursor.com/agents/${agentId}`,
      runId: `run-${agentId}`,
      launchedAt: NOW.toISOString(),
      repo: "acme/app",
      model: null,
      prompt: "p",
      ...extra,
    });
    await mkdir(join(dir, ".proofline"));
    await writeFile(
      join(dir, ".proofline", "run.json"),
      JSON.stringify({ launches: [record("init", "bc-init", { kind: "init" }), record("alpha", "bc-alpha", { type: "feature" })] }),
    );
    const agents = new FakeAgents({
      "bc-init": { state: "running" },
      "bc-alpha": { state: "finished", finishedAt: new Date(NOW.getTime() - 3_600_000) },
    });
    const onSleep = () => {
      agents.agents["bc-init"] = { state: "error" };
    };
    const { stdout, sleeps } = await run(["status", "--watch"], dir, { agents, onSleep });
    const rows = (check: string) =>
      stdout
        .slice(stdout.indexOf(check))
        .split("\n")
        .slice(2, 4)
        .map((line) => line.split(/ {2,}/).slice(0, 3));
    expect(rows("check 1")).toEqual([
      ["init", "-", "running"],
      ["alpha", "feature", "finished"],
    ]);
    expect(rows("check 2")[0]).toEqual(["init", "-", "error"]);
    expect(stdout).toContain("still running: init;");
    expect(sleeps).toHaveLength(1);
  });
});

describe("init template", () => {
  it("ships prompts/init.md with only {repo} to fill in", async () => {
    const template = await loadInitTemplate();
    expect(checkInitTemplate(template)).toEqual([]);
    expect(renderInitPrompt(template, "acme/app")).toBe(EXPECTED_PROMPT);
  });

  it("rejects any other placeholder", () => {
    expect(checkInitTemplate("hi {repo} and {title}")).toEqual([
      "prompts/init.md: unknown placeholder {title} (only {repo} is filled in)",
    ]);
  });

  it("fills {repo} everywhere and leaves braces in the result alone", () => {
    expect(renderInitPrompt("{repo} / {repo}\n\n", "x/{repo}")).toBe("x/{repo} / x/{repo}");
  });
});
