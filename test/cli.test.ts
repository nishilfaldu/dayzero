import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CONFIG, TASKS, run as runIn, tempDir } from "./fake.js";

const root = fileURLToPath(new URL("../examples/epic-stack", import.meta.url));

const run = (argv: string[], cwd = root) => runIn(argv, cwd);

describe("dayzero run --dry-run", () => {
  it("prints one prompt per sample ticket", async () => {
    const { code, stdout, stderr } = await run(["run", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("===== share-notes (feature) =====\n/poteto-mode feature: Let me share a note");
    expect(stdout).toContain("===== reset-code-race (concurrency) =====\n/poteto-mode concurrency: A password reset code");
    expect(stdout).toContain("===== note-delete-idor (security) =====\n/poteto-mode security: My note was deleted");
    expect(stdout).toContain("===== notes-page-perf (perf) =====\n/poteto-mode perf: The notes page is slow");
    expect(stdout).toContain("===== prisma-7 (migration) =====\n/poteto-mode migration: Move the app off Prisma 6");
    expect(stderr).toContain("dry run: 5 prompt(s) for nishilfaldu/epic-stack; nothing was launched");
  });

  it("uses the shipped dayzero.yaml repro lines: feature and migration overrides, default for the rest", async () => {
    const { stdout } = await run(["run", "--dry-run"]);
    const repro = stdout
      .split(/^===== .+ =====\n/m)
      .filter(Boolean)
      .map((prompt) => prompt.split("\n")[1]);
    const byDefault = "repro it on main first; if it doesn't repro, stop and say so.";
    expect(repro).toEqual([
      "write the failing e2e test first.",
      byDefault,
      byDefault,
      byDefault,
      "record the current versions and a passing test run on main first.",
    ]);
  });

  it("dedupes evidence that appears in both by_type and the ticket", async () => {
    const dir = await tempDir({
      "tasks.yaml": "repo: a/b\ntickets:\n  - {id: one, type: bug, title: T, description: D, done: X, evidence: [red then green]}\n",
      "dayzero.yaml": "repro:\n  default: repro it.\nevidence:\n  by_type: {bug: [red then green]}\n",
    });
    const { stdout } = await run(["run", "--dry-run"], dir);
    expect(stdout.match(/red then green/g)).toHaveLength(1);
  });

  it("reads files from the given paths", async () => {
    const dir = await tempDir({
      "t.yaml": "repo: a/b\ntickets:\n  - {id: one, type: perf, title: T, description: D, done: X}\n",
      "c.yaml": "repro:\n  default: repro it.\n  perf: time it on main first.\nevidence:\n  always: [numbers]\n",
    });
    const { code, stdout } = await run(["run", "--dry-run", "--tasks", "t.yaml", "--config", "c.yaml"], dir);
    expect(code).toBe(0);
    expect(stdout).toContain("\ntime it on main first.\n");
    expect(stdout).toContain("the pr shows numbers.");
  });

  it("exits 1 and names the ticket id and field when a file is invalid", async () => {
    const dir = await tempDir({
      "tasks.yaml": "repo: a/b\ntickets:\n  - {id: bad-one, type: chore, title: T, description: D, done: X}\n",
      "dayzero.yaml": "repro: {feature: x, chore: y}\nevidence:\n  always: [log]\n  by_type: {nope: [x]}\n",
    });
    const { code, stdout, stderr } = await run(["run", "--dry-run"], dir);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('error: tasks.yaml: ticket "bad-one": field "type" must be one of');
    expect(stderr).toContain('error: dayzero.yaml: field "repro.default" is required');
    expect(stderr).toContain('error: dayzero.yaml: field "repro.chore" is not a ticket type');
    expect(stderr).toContain('error: dayzero.yaml: field "evidence.by_type.nope" is not a ticket type');
  });

  it("exits 1 when a file is missing", async () => {
    const dir = await tempDir({ "dayzero.yaml": "repro: {default: repro it.}\nevidence: {always: [log]}\n" });
    const { code, stderr } = await run(["run", "--dry-run"], dir);
    expect(code).toBe(1);
    expect(stderr).toMatch(/error: tasks\.yaml: file not found/);
  });

  it("launches nothing, needs no API key, and leaves no run state", async () => {
    const dir = await tempDir({ "tasks.yaml": TASKS, "dayzero.yaml": CONFIG });
    const result = await runIn(["run", "--dry-run"], dir, { env: {} });
    expect(result.code).toBe(0);
    expect(result.launcherCreated).toBe(false);
    expect(result.launcher.requests).toEqual([]);
    await expect(access(join(dir, ".dayzero"))).rejects.toThrow();
  });

  it("ignores existing run state, still printing already-launched tickets", async () => {
    const dir = await tempDir({ "tasks.yaml": TASKS, "dayzero.yaml": CONFIG });
    expect((await runIn(["run", "--skip-init-check"], dir)).code).toBe(0);
    const { stdout } = await runIn(["run", "--dry-run"], dir);
    expect(stdout.match(/^===== /gm)).toHaveLength(3);
  });

  it("prints just the --only tickets", async () => {
    const dir = await tempDir({ "tasks.yaml": TASKS, "dayzero.yaml": CONFIG });
    const { code, stdout } = await runIn(["run", "--dry-run", "--only", "gamma"], dir);
    expect(code).toBe(0);
    expect(stdout.match(/^===== .*$/gm)).toEqual(["===== gamma (bug) ====="]);
  });

  it("prints usage for unknown commands and flags", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["launch"])).code).toBe(2);
    expect((await run(["run", "--dryrun"])).code).toBe(2);
    expect((await run(["--help"])).code).toBe(0);
  });

  it("names an unknown command, or extra ones, before the usage", async () => {
    const unknown = await run(["launch"]);
    expect(unknown.stderr.startsWith('error: unknown command "launch"\n\nusage: dayzero new')).toBe(true);
    const extra = await run(["run", "now"]);
    expect(extra.code).toBe(2);
    expect(extra.stderr.startsWith("error: expected one command, got 2: run now\n\nusage:")).toBe(true);
    expect((await run([])).stderr.startsWith("usage:")).toBe(true);
  });

  it("accepts --skip-init-check only on run", async () => {
    expect((await run(["status", "--skip-init-check"])).stderr).toContain("--skip-init-check only applies to `dayzero run`");
    expect((await run(["init", "--skip-init-check"])).stderr).toContain("--skip-init-check only applies to `dayzero run`");
    expect((await run(["run", "--dry-run", "--skip-init-check"])).code).toBe(0);
  });
});
