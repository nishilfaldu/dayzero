import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type DoctorDeps, runChecks } from "../src/doctor.js";
import { CONFIG, TASKS, tempDir } from "./fake.js";

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    nodeVersion: "22.13.0",
    ghAuthToken: async () => "gh-token",
    fetch: async () => new Response("{}", { status: 200 }),
    listCursorRepos: async () => ["https://github.com/acme/app"],
    ...overrides,
  };
}

async function check(env: NodeJS.ProcessEnv, overrides: Partial<DoctorDeps> = {}, files = { "tasks.yaml": TASKS, "dayzero.yaml": CONFIG }) {
  const dir = await tempDir(files);
  return runChecks(dir, env, join(dir, "tasks.yaml"), "tasks.yaml", join(dir, "dayzero.yaml"), "dayzero.yaml", deps(overrides));
}

const KEY = { CURSOR_API_KEY: "k" };

describe("dayzero doctor", () => {
  it("passes every check when everything is in place", async () => {
    const checks = await check(KEY);
    expect(checks.map((c) => c.label)).toEqual([
      "Node 22.13.0",
      "tasks.yaml is valid",
      "dayzero.yaml is valid",
      "GitHub token from `gh auth token`",
      "GitHub can see acme/app",
      "CURSOR_API_KEY (from environment)",
      "Cursor can reach acme/app",
    ]);
    expect(checks.every((c) => c.ok)).toBe(true);
  });

  it("fails an old Node", async () => {
    const [node] = await check(KEY, { nodeVersion: "22.12.9" });
    expect(node).toMatchObject({ ok: false, label: "Node 22.12.9" });
  });

  it("skips the repo checks it can't run and says how to fix what's missing", async () => {
    const checks = await check({}, { ghAuthToken: async () => undefined });
    const failed = checks.filter((c) => !c.ok);
    expect(failed.map((c) => c.label)).toEqual(["GitHub token from `gh auth token`", "CURSOR_API_KEY"]);
    expect(failed.map((c) => c.fix)).toEqual(["run `gh auth login`", "set CURSOR_API_KEY in the environment or in .env.local"]);
  });

  it("fails when GitHub can't see the repo or Cursor hasn't connected it", async () => {
    const checks = await check(KEY, {
      fetch: async () => new Response("{}", { status: 404 }),
      listCursorRepos: async () => ["https://github.com/acme/other.git"],
    });
    expect(checks.filter((c) => !c.ok).map((c) => c.label)).toEqual(["GitHub can see acme/app", "Cursor can reach acme/app"]);
  });

  it("matches the Cursor repo URL without case or a .git suffix mattering", async () => {
    const checks = await check(KEY, { listCursorRepos: async () => ["https://github.com/Acme/App.git"] });
    expect(checks.at(-1)).toMatchObject({ ok: true, label: "Cursor can reach acme/app" });
  });

  it("reports invalid files", async () => {
    const checks = await check(KEY, {}, { "tasks.yaml": "repo: acme/app\n", "dayzero.yaml": CONFIG });
    expect(checks[1]).toMatchObject({ ok: false, label: "tasks.yaml is invalid" });
  });
});
