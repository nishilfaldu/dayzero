import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";

const root = fileURLToPath(new URL("..", import.meta.url));

async function run(argv: string[], cwd = root) {
  let stdout = "";
  let stderr = "";
  const code = await main(argv, { cwd, stdout: (t) => (stdout += t), stderr: (t) => (stderr += t) });
  return { code, stdout, stderr };
}

async function tempDir(files: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), "proofline-"));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
  return dir;
}

describe("proofline run --dry-run", () => {
  it("prints one prompt per sample ticket", async () => {
    const { code, stdout, stderr } = await run(["run", "--dry-run"]);
    expect(code).toBe(0);
    expect(stdout).toContain("===== notes-count (feature) =====\n/poteto-mode feature: Show a note count");
    expect(stdout).toContain("===== note-edit-idor (security) =====\n/poteto-mode security: Users can edit");
    expect(stderr).toContain("dry run: 2 prompt(s) for nishilfaldu/epic-stack; nothing was launched");
  });

  it("never prints the sample's seeded text", async () => {
    const tasks = await readFile(join(root, "tasks.yaml"), "utf8");
    const seeded = tasks.match(/seeded: (.+)/)![1]!;
    const { stdout } = await run(["run", "--dry-run"]);
    expect(stdout).not.toContain(seeded);
  });

  it("uses the shipped proofline.yaml repro lines: feature override, default for the rest", async () => {
    const { stdout } = await run(["run", "--dry-run"]);
    const [feature, security] = stdout.split(/^===== .+ =====\n/m).filter(Boolean);
    expect(feature!.split("\n")[1]).toBe("write the failing e2e test first.");
    expect(security!.split("\n")[1]).toBe("repro it on main first; if it doesn't repro, stop and say so.");
  });

  it("dedupes evidence that appears in both by_type and the ticket", async () => {
    const { stdout } = await run(["run", "--dry-run"]);
    expect(stdout.match(/failing test on main, passing on the branch/g)).toHaveLength(1);
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
      "proofline.yaml": "repro: {feature: x, chore: y}\nevidence:\n  always: [log]\n  by_type: {nope: [x]}\n",
    });
    const { code, stdout, stderr } = await run(["run", "--dry-run"], dir);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain('error: tasks.yaml: ticket "bad-one": field "type" must be one of');
    expect(stderr).toContain('error: proofline.yaml: field "repro.default" is required');
    expect(stderr).toContain('error: proofline.yaml: field "repro.chore" is not a ticket type');
    expect(stderr).toContain('error: proofline.yaml: field "evidence.by_type.nope" is not a ticket type');
  });

  it("exits 1 when a file is missing", async () => {
    const dir = await tempDir({ "proofline.yaml": "repro: {default: repro it.}\nevidence: {always: [log]}\n" });
    const { code, stderr } = await run(["run", "--dry-run"], dir);
    expect(code).toBe(1);
    expect(stderr).toMatch(/error: tasks\.yaml: file not found/);
  });

  it("refuses to run without --dry-run", async () => {
    const { code, stderr } = await run(["run"]);
    expect(code).toBe(2);
    expect(stderr).toContain("only `proofline run --dry-run` works so far");
  });

  it("prints usage for unknown commands and flags", async () => {
    expect((await run([])).code).toBe(2);
    expect((await run(["launch"])).code).toBe(2);
    expect((await run(["run", "--dryrun"])).code).toBe(2);
    expect((await run(["--help"])).code).toBe(0);
  });
});
