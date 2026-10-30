import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaunchRecord } from "../src/state.js";
import { PROMPT_END, PROMPT_START, TEST_FILES_MARKER, promptSection } from "../src/status.js";
import { TASKS, run, tempDir } from "./fake.js";
import { FakeAgents, FakeGitHub } from "./fake-status.js";

function launch(ticketId: string, agentId: string, prompt = `prompt for ${ticketId}`): LaunchRecord {
  return {
    ticketId,
    agentId,
    agentUrl: `https://cursor.com/agents/${agentId}`,
    runId: `run-${agentId}`,
    launchedAt: "2026-10-30T12:00:00.000Z",
    repo: "acme/app",
    model: null,
    prompt,
  };
}

async function project(launches: LaunchRecord[], tasks = TASKS) {
  const dir = await tempDir({ "tasks.yaml": tasks });
  await mkdir(join(dir, ".proofline"));
  await writeFile(join(dir, ".proofline", "run.json"), JSON.stringify({ launches }));
  return dir;
}

const ALL = [launch("alpha", "bc-a"), launch("beta", "bc-b"), launch("gamma", "bc-g")];

describe("proofline status table", () => {
  it("shows ticket, type, agent state and PR, with each missing-PR case spelled out", async () => {
    const dir = await project([...ALL, launch("delta", "bc-d"), launch("eps", "bc-e")]);
    const github = new FakeGitHub();
    github.addPull({ number: 7, headRef: "cursor/alpha-1" });
    const agents = new FakeAgents({
      "bc-a": { state: "finished", branch: "cursor/alpha-1", prUrl: "https://github.com/acme/app/pull/7" },
      "bc-b": { state: "running", branch: "cursor/beta-1" },
      "bc-g": { state: "error", branch: "cursor/gamma-1", error: "unexpected error" },
      "bc-d": { state: "error" },
    });
    const { code, stdout } = await run(["status"], dir, { agents, github });
    expect(code).toBe(0);
    expect(stdout.split("\n\n")[0]).toBe(
      [
        "TICKET  TYPE      AGENT      PR",
        "alpha   feature   finished   https://github.com/acme/app/pull/7",
        "beta    security  running    no PR yet (branch cursor/beta-1 not pushed yet)",
        "gamma   bug       error      branch cursor/gamma-1 never reached GitHub",
        "delta   ?         error      no PR (agent failed)",
        "eps     ?         not found  -",
      ].join("\n"),
    );
    expect(stdout).toContain("  gamma: agent error: unexpected error\n");
    expect(stdout).toContain("  delta: no longer in tasks.yaml, so no labels are added\n");
    expect(stdout).toContain("  eps: Cursor has no agent bc-e\n");
  });

  it("shows a pushed branch with no PR, a finished agent with no branch, and closed or merged PRs", async () => {
    const dir = await project(ALL);
    const github = new FakeGitHub();
    github.branches.add("acme/app:cursor/alpha-1");
    github.addPull({ number: 8, headRef: "cursor/beta-1", state: "closed", merged: true });
    const agents = new FakeAgents({
      "bc-a": { state: "running", branch: "cursor/alpha-1" },
      "bc-b": { state: "finished", branch: "cursor/beta-1" },
      "bc-g": { state: "finished" },
    });
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(stdout).toContain("alpha   feature   running   no PR yet (branch cursor/alpha-1 is on GitHub)");
    expect(stdout).toContain("beta    security  finished  https://github.com/acme/app/pull/8 (merged)");
    expect(stdout).toContain("gamma   bug       finished  no PR (agent finished without a branch)");
  });

  it("uses each ticket's latest launch", async () => {
    const dir = await project([launch("alpha", "bc-old", "old prompt"), launch("alpha", "bc-new", "new prompt")]);
    const github = new FakeGitHub();
    const pull = github.addPull({ number: 9, headRef: "b" });
    const agents = new FakeAgents({ "bc-new": { state: "finished", branch: "b" } });
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(agents.lookups).toEqual(["bc-new"]);
    expect(stdout.match(/^alpha /gm)).toHaveLength(1);
    expect(pull.body).toContain("new prompt");
    expect(pull.body).not.toContain("old prompt");
  });

  it("says when nothing has been launched yet", async () => {
    const dir = await tempDir({ "tasks.yaml": TASKS });
    const { code, stdout, githubTokens } = await run(["status"], dir);
    expect(code).toBe(0);
    expect(stdout).toContain("nothing launched yet");
    expect(githubTokens).toEqual([]);
  });
});

describe("finding the PR", () => {
  it("trusts Cursor's prUrl only after GitHub confirms it", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const github = new FakeGitHub();
    github.addPull({ number: 3, headRef: "cursor/alpha-1" });
    const agents = new FakeAgents({ "bc-a": { state: "finished", prUrl: "https://github.com/acme/app/pull/3" } });
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(stdout).toContain("https://github.com/acme/app/pull/3");
  });

  it("ignores a prUrl GitHub doesn't have, and falls back to the branch", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const github = new FakeGitHub();
    github.addPull({ number: 4, headRef: "cursor/alpha-1" });
    const agents = new FakeAgents({
      "bc-a": { state: "finished", branch: "cursor/alpha-1", prUrl: "https://github.com/acme/app/pull/99" },
    });
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(stdout).toContain("alpha   feature  finished  https://github.com/acme/app/pull/4");
    expect(stdout).toContain("Cursor's PR link https://github.com/acme/app/pull/99 doesn't exist on GitHub; ignored");
  });

  it("ignores a prUrl for another repo or branch", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const github = new FakeGitHub();
    github.addPull({ number: 5, headRef: "cursor/alpha-1", repo: "evil/fork", url: "https://github.com/evil/fork/pull/5" });
    github.addPull({ number: 6, headRef: "someone-else" });
    for (const prUrl of ["https://github.com/evil/fork/pull/5", "https://github.com/acme/app/pull/6"]) {
      const agents = new FakeAgents({ "bc-a": { state: "finished", branch: "cursor/alpha-1", prUrl } });
      const { stdout } = await run(["status"], dir, { agents, github });
      expect(stdout).toContain("alpha   feature  finished  branch cursor/alpha-1 never reached GitHub");
      expect(stdout).toMatch(/Cursor's PR link .* is for .*; ignored/);
    }
    expect(github.writes).toEqual([]);
  });

  it("finds the PR from the branch when Cursor gives no prUrl, preferring an open one", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const github = new FakeGitHub();
    github.addPull({ number: 10, headRef: "cursor/alpha-1", state: "closed" });
    github.addPull({ number: 11, headRef: "cursor/alpha-1" });
    const agents = new FakeAgents({ "bc-a": { state: "finished", branch: "cursor/alpha-1" } });
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(stdout).toContain("https://github.com/acme/app/pull/11");
  });
});

describe("updating the PR", () => {
  function setup(files = [] as { filename: string; status: string; previousFilename?: string }[]) {
    const github = new FakeGitHub();
    const alphaPull = github.addPull({ number: 1, headRef: "a", body: "Adds alpha.\n\nMade by Cursor.", files });
    const betaPull = github.addPull({ number: 2, headRef: "b" });
    const agents = new FakeAgents({
      "bc-a": { state: "finished", branch: "a" },
      "bc-b": { state: "finished", branch: "b" },
    });
    return { github, agents, alphaPull, betaPull };
  }

  it("labels the PR with the ticket type, plus seeded for seeded tickets", async () => {
    const dir = await project([launch("alpha", "bc-a"), launch("beta", "bc-b")]);
    const { github, agents, alphaPull, betaPull } = setup();
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(alphaPull.labels).toEqual(["feature"]);
    expect(betaPull.labels).toEqual(["security", "seeded"]);
    expect(github.writes).toContain("createLabel acme/app seeded #b60205");
    expect(stdout).toContain("  beta: labelled security, seeded\n");
  });

  it("appends the exact prompt the agent got, keeping the existing description", async () => {
    const prompt = "/poteto-mode feature: Add alpha.\nwrite the test first.\nuse ```code``` freely.";
    const record = launch("alpha", "bc-a", prompt);
    const dir = await project([record]);
    const { github, agents, alphaPull } = setup();
    await run(["status"], dir, { agents, github });
    expect(alphaPull.body).toBe(`Adds alpha.\n\nMade by Cursor.\n\n${promptSection(record)}`);
    expect(alphaPull.body).toContain(`\n${prompt}\n`);
    expect(alphaPull.body).toContain("````text\n");
  });

  it("comments once on edited, deleted and renamed test files, ignoring new tests and other files", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const { github, agents, alphaPull } = setup([
      { filename: "tests/e2e/notes.test.ts", status: "modified" },
      { filename: "app/utils/misc.test.ts", status: "removed" },
      { filename: "tests/new-name.spec.ts", status: "renamed", previousFilename: "tests/old-name.spec.ts" },
      { filename: "tests/e2e/count.test.ts", status: "added" },
      { filename: "app/routes/notes.tsx", status: "modified" },
    ]);
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(alphaPull.comments).toHaveLength(1);
    expect(alphaPull.comments[0]!.body).toBe(
      [
        TEST_FILES_MARKER,
        "**proofline:** this PR changes existing test files. The ticket said to leave existing tests alone unless it needed to change them, and to say why.",
        "",
        "- `tests/e2e/notes.test.ts` (edited)",
        "- `app/utils/misc.test.ts` (deleted)",
        "- `tests/old-name.spec.ts` → `tests/new-name.spec.ts` (renamed)",
      ].join("\n"),
    );
    expect(stdout).toContain("  alpha: commented on 3 changed test file(s)\n");
  });

  it("posts no comment when no existing test file changed", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const { github, agents, alphaPull } = setup([{ filename: "tests/e2e/count.test.ts", status: "added" }]);
    await run(["status"], dir, { agents, github });
    expect(alphaPull.comments).toEqual([]);
  });

  it("never duplicates labels, the prompt section or the comment across runs", async () => {
    const dir = await project([launch("alpha", "bc-a"), launch("beta", "bc-b")]);
    const { github, agents, alphaPull, betaPull } = setup([{ filename: "tests/a.test.ts", status: "modified" }]);
    await run(["status"], dir, { agents, github });
    const afterFirst = { writes: github.writes.length, body: alphaPull.body };

    const second = await run(["status"], dir, { agents, github });
    await run(["status"], dir, { agents, github });
    expect(github.writes).toHaveLength(afterFirst.writes);
    expect(alphaPull.body).toBe(afterFirst.body);
    expect(alphaPull.body.split(PROMPT_START)).toHaveLength(2);
    expect(alphaPull.labels).toEqual(["feature"]);
    expect(betaPull.labels).toEqual(["security", "seeded"]);
    expect(alphaPull.comments).toHaveLength(1);
    expect(second.stdout.split("\n\n")[1] ?? "").not.toMatch(/labelled|added the prompt|commented/);
  });

  it("updates its one comment in place when more test files change later", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const { github, agents, alphaPull } = setup([{ filename: "tests/a.test.ts", status: "modified" }]);
    await run(["status"], dir, { agents, github });
    alphaPull.files.push({ filename: "tests/b.test.ts", status: "removed" });
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(alphaPull.comments).toHaveLength(1);
    expect(alphaPull.comments[0]!.body).toContain("`tests/b.test.ts` (deleted)");
    expect(stdout).toContain("updated the test-file comment (2 file(s))");
  });

  it("finds its comment among others and leaves those alone", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const { github, agents, alphaPull } = setup([{ filename: "tests/a.test.ts", status: "modified" }]);
    alphaPull.comments.push({ id: 900, body: "LGTM" });
    await run(["status"], dir, { agents, github });
    alphaPull.comments.push({ id: 901, body: "nit: rename this" });
    await run(["status"], dir, { agents, github });
    expect(alphaPull.comments.map((c) => c.body.includes(TEST_FILES_MARKER))).toEqual([false, true, false]);
  });

  it("doesn't re-add a label someone already put on the PR", async () => {
    const dir = await project([launch("beta", "bc-b")]);
    const { github, agents, betaPull } = setup();
    betaPull.labels.push("seeded");
    await run(["status"], dir, { agents, github });
    expect(github.writes.filter((w) => w.startsWith("addLabels"))).toEqual(["addLabels acme/app#2 security"]);
  });

  it("replaces a stale prompt section instead of adding a second one, keeping text after it", async () => {
    const record = launch("alpha", "bc-a", "the new prompt");
    const dir = await project([record]);
    const { github, agents, alphaPull } = setup();
    alphaPull.body = `Intro.\n\n${PROMPT_START}\nold stuff\n${PROMPT_END}\n\nReviewer notes.`;
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(alphaPull.body).toBe(`Intro.\n\n${promptSection(record)}\n\nReviewer notes.`);
    expect(stdout).toContain("updated the prompt in the PR description");
  });

  it("doesn't rewrite a description GitHub returns with CRLF line endings", async () => {
    const record = launch("alpha", "bc-a", "line one\nline two");
    const dir = await project([record]);
    const { github, agents, alphaPull } = setup();
    alphaPull.body = `Adds alpha.\r\n\r\n${promptSection(record).replace(/\n/g, "\r\n")}`;
    await run(["status"], dir, { agents, github });
    expect(github.writes.filter((w) => w.startsWith("setPullBody"))).toEqual([]);
  });

  it("still adds the prompt for a ticket no longer in tasks.yaml, but no labels", async () => {
    const dir = await project([launch("alpha", "bc-a")], "repo: acme/app\ntickets:\n  - {id: other, type: bug, title: T, description: D, done: X}\n");
    const { github, agents, alphaPull } = setup();
    await run(["status"], dir, { agents, github });
    expect(alphaPull.labels).toEqual([]);
    expect(alphaPull.body).toContain(PROMPT_START);
  });
});

describe("failures", () => {
  it("reports a failed Cursor lookup in the table and keeps going", async () => {
    const dir = await project(ALL);
    const github = new FakeGitHub();
    const agents = new FakeAgents({
      "bc-a": new Error("socket hang up"),
      "bc-b": { state: "running" },
      "bc-g": { state: "finished" },
    });
    const { code, stdout, stderr } = await run(["status"], dir, { agents, github });
    expect(code).toBe(1);
    expect(stdout).toContain("alpha   feature   lookup failed  -");
    expect(stdout).toContain("beta    security  running        no PR yet");
    expect(stderr).toContain("error: alpha: Cursor lookup for bc-a failed: socket hang up");
  });

  it("reports a GitHub error for one ticket and keeps going", async () => {
    const dir = await project([launch("alpha", "bc-a"), launch("beta", "bc-b")]);
    const github = new FakeGitHub();
    const betaPull = github.addPull({ number: 2, headRef: "b" });
    const agents = new FakeAgents({
      "bc-a": { state: "finished", prUrl: "https://github.com/acme/app/pull/404" },
      "bc-b": { state: "finished", branch: "b" },
    });
    // A prUrl with no branch and a getPull that blows up for alpha only.
    const getPull = github.getPull.bind(github);
    github.getPull = async (repo, n) => {
      if (n === 404) throw new Error("GitHub GET /repos/acme/app/pulls/404 failed: 502 Bad Gateway");
      return getPull(repo, n);
    };
    const { code, stderr } = await run(["status"], dir, { agents, github });
    expect(code).toBe(1);
    expect(stderr).toContain("error: alpha: GitHub: GitHub GET /repos/acme/app/pulls/404 failed: 502");
    expect(betaPull.labels).toEqual(["security", "seeded"]);
  });
});

describe("auth", () => {
  const agents = () => new FakeAgents({ "bc-a": { state: "running" } });

  it("uses `gh auth token` by default", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const { code, githubTokens } = await run(["status"], dir, { agents: agents(), ghToken: "from-gh\n" });
    expect(code).toBe(0);
    expect(githubTokens).toEqual(["from-gh"]);
  });

  it("lets GITHUB_TOKEN override gh", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const env = { CURSOR_API_KEY: "k", GITHUB_TOKEN: "from-env" };
    const { githubTokens } = await run(["status"], dir, { agents: agents(), env, ghToken: "from-gh" });
    expect(githubTokens).toEqual(["from-env"]);
  });

  it("fails with a `gh auth login` hint when there is no token at all", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const env = { CURSOR_API_KEY: "k", GITHUB_TOKEN: " " };
    const result = await run(["status"], dir, { agents: agents(), env, ghToken: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("run `gh auth login`");
    expect(result.githubTokens).toEqual([]);
    const noGh = await run(["status"], dir, { agents: agents(), ghToken: undefined });
    expect(noGh.code).toBe(1);
    expect(noGh.stderr).toContain("run `gh auth login`");
  });

  it("stops with a `gh auth login` hint when GitHub rejects the token", async () => {
    const dir = await project([launch("alpha", "bc-a"), launch("beta", "bc-b")]);
    const github = new FakeGitHub();
    github.rejectToken = true;
    const agentsWithBranches = new FakeAgents({
      "bc-a": { state: "finished", branch: "a" },
      "bc-b": { state: "finished", branch: "b" },
    });
    const { code, stdout, stderr } = await run(["status"], dir, { agents: agentsWithBranches, github });
    expect(code).toBe(1);
    expect(stderr).toBe(
      "error: GitHub rejected the token (401 on GET /repos/acme/app) (token from gh auth token); run `gh auth login`, or set GITHUB_TOKEN\n",
    );
    expect(stdout).toBe("");
    expect(agentsWithBranches.lookups).toEqual(["bc-a"]);
  });

  it("needs the Cursor key", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const { code, stderr } = await run(["status"], dir, { env: {} });
    expect(code).toBe(1);
    expect(stderr).toContain("CURSOR_API_KEY is not set");
  });

  it("rejects run-only flags", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const { code, stderr } = await run(["status", "--force"], dir);
    expect(code).toBe(2);
    expect(stderr).toContain("--force only applies to `proofline run`");
  });
});
