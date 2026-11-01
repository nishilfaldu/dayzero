import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseGitHubRemote, scaffold } from "../src/scaffold.js";
import { run, tempDir } from "./fake.js";

const noRemote = async () => undefined;

describe("parseGitHubRemote", () => {
  it.each([
    ["git@github.com:acme/app.git", "acme/app"],
    ["https://github.com/acme/app.git", "acme/app"],
    ["https://github.com/acme/app", "acme/app"],
    ["https://github.com/acme/app/\n", "acme/app"],
  ])("reads %s", (url, repo) => {
    expect(parseGitHubRemote(url)).toBe(repo);
  });

  it("ignores other hosts", () => {
    expect(parseGitHubRemote("git@gitlab.com:acme/app.git")).toBeUndefined();
  });
});

describe("dayzero new", () => {
  it("writes both starter files, fills the repo from origin, and ignores .dayzero/ and .env.local", async () => {
    const dir = await tempDir({});
    const result = await scaffold(dir, false, async () => "acme/app");
    expect(result).toEqual({ written: ["tasks.yaml", "dayzero.yaml"], kept: [], ignored: [".dayzero/", ".env.local"], repo: "acme/app" });
    expect(await readFile(join(dir, "tasks.yaml"), "utf8")).toContain("repo: acme/app\n");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe(".dayzero/\n.env.local\n");
  });

  it("keeps the OWNER/REPO placeholder when there is no GitHub origin", async () => {
    const dir = await tempDir({});
    await scaffold(dir, false, noRemote);
    expect(await readFile(join(dir, "tasks.yaml"), "utf8")).toContain("repo: OWNER/REPO\n");
  });

  it("keeps existing files unless forced, and only adds missing .gitignore lines", async () => {
    const dir = await tempDir({ "tasks.yaml": "mine\n", ".gitignore": "node_modules\n.env.local" });
    const kept = await scaffold(dir, false, noRemote);
    expect(kept.written).toEqual(["dayzero.yaml"]);
    expect(kept.kept).toEqual(["tasks.yaml"]);
    expect(await readFile(join(dir, "tasks.yaml"), "utf8")).toBe("mine\n");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.env.local\n.dayzero/\n");

    const forced = await scaffold(dir, true, noRemote);
    expect(forced.written).toEqual(["tasks.yaml", "dayzero.yaml"]);
    expect(forced.ignored).toEqual([]);
  });

  it("produces files that run --dry-run accepts", async () => {
    const dir = await tempDir({});
    await scaffold(dir, false, async () => "acme/app");
    const { code, stdout, stderr } = await run(["run", "--dry-run"], dir);
    expect(code).toBe(0);
    expect(stdout).toContain("===== example-bug (bug) =====");
    expect(stderr).toContain("dry run: 1 prompt(s) for acme/app");
  });

  it("rejects flags that belong to other commands", async () => {
    const dir = await tempDir({});
    const { code, stderr } = await run(["new", "--watch"], dir);
    expect(code).toBe(2);
    expect(stderr).toContain("--watch doesn't apply to `dayzero new`");
  });
});
