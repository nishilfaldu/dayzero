import { writeFileSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { LaunchRecord } from "../src/state.js";
import type { TicketType } from "../src/types.js";
import { PROMPT_END, PROMPT_START, TEST_FILES_MARKER, promptSection } from "../src/status.js";
import { TASKS, run, tempDir } from "./fake.js";
import { FakeAgents, FakeGitHub } from "./fake-status.js";

/** A record as `proofline run` writes it now; pass `type: null` for one from before types were recorded. */
function launch(
  ticketId: string,
  agentId: string,
  prompt = `prompt for ${ticketId}`,
  type: TicketType | null | undefined = TYPES[ticketId],
): LaunchRecord {
  return {
    ticketId,
    ...(type && { type }),
    agentId,
    agentUrl: `https://cursor.com/agents/${agentId}`,
    runId: `run-${agentId}`,
    launchedAt: "2026-10-30T12:00:00.000Z",
    repo: "acme/app",
    model: null,
    prompt,
  };
}

const TYPES: Record<string, TicketType> = { alpha: "feature", beta: "security", gamma: "bug" };

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
    expect(stdout).toContain("  delta: type unknown (not recorded at launch, and not in tasks.yaml), so no label is added\n");
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

  it("labels the PR with the ticket type, creating the label if the repo lacks it", async () => {
    const dir = await project([launch("alpha", "bc-a"), launch("beta", "bc-b")]);
    const { github, agents, alphaPull, betaPull } = setup();
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(alphaPull.labels).toEqual(["feature"]);
    expect(betaPull.labels).toEqual(["security"]);
    expect(github.writes).toContain("createLabel acme/app security #ededed");
    expect(stdout).toContain("  beta: labelled security\n");
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
    expect(betaPull.labels).toEqual(["security"]);
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
    betaPull.labels.push("security");
    await run(["status"], dir, { agents, github });
    expect(github.writes.filter((w) => w.includes("abel"))).toEqual([]);
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

  it("still adds the prompt for an untyped old record whose ticket left tasks.yaml, but no label", async () => {
    const otherTasks = "repo: acme/app\ntickets:\n  - {id: other, type: bug, title: T, description: D, done: X}\n";
    const dir = await project([launch("alpha", "bc-a", "p", null)], otherTasks);
    const { github, agents, alphaPull } = setup();
    const { stdout } = await run(["status"], dir, { agents, github });
    expect(alphaPull.labels).toEqual([]);
    expect(alphaPull.body).toContain(PROMPT_START);
    expect(stdout).toContain("alpha   ?     finished");
  });
});

describe("ticket type", () => {
  const agents = () => new FakeAgents({ "bc-a": { state: "finished", branch: "a" } });

  it("uses the type recorded at launch, even when tasks.yaml now says otherwise", async () => {
    const retyped = TASKS.replace("{id: alpha, type: feature", "{id: alpha, type: perf");
    const dir = await project([launch("alpha", "bc-a")], retyped);
    const github = new FakeGitHub();
    const pull = github.addPull({ number: 1, headRef: "a" });
    const { stdout } = await run(["status"], dir, { agents: agents(), github });
    expect(stdout).toContain("alpha   feature  finished");
    expect(pull.labels).toEqual(["feature"]);
  });

  it("doesn't need tasks.yaml when every record has a type", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    await rm(join(dir, "tasks.yaml"));
    const github = new FakeGitHub();
    const pull = github.addPull({ number: 1, headRef: "a" });
    const { code } = await run(["status"], dir, { agents: agents(), github });
    expect(code).toBe(0);
    expect(pull.labels).toEqual(["feature"]);
  });

  it("falls back to tasks.yaml for records written before types were recorded", async () => {
    const dir = await project([launch("alpha", "bc-a", "p", null)]);
    const github = new FakeGitHub();
    const pull = github.addPull({ number: 1, headRef: "a" });
    const { stdout } = await run(["status"], dir, { agents: agents(), github });
    expect(stdout).toContain("alpha   feature  finished");
    expect(pull.labels).toEqual(["feature"]);
  });

  it("treats a hand-edited, invalid type like a missing one", async () => {
    const record = { ...launch("alpha", "bc-a"), type: "chore" } as unknown as LaunchRecord;
    const dir = await project([record]);
    const github = new FakeGitHub();
    const pull = github.addPull({ number: 1, headRef: "a" });
    await run(["status"], dir, { agents: agents(), github });
    expect(pull.labels).toEqual(["feature"]);
  });

  it("reports a broken tasks.yaml only when an old record needs it", async () => {
    const typed = await project([launch("alpha", "bc-a")], "not: [valid");
    expect((await run(["status"], typed, { agents: agents() })).code).toBe(0);
    const untyped = await project([launch("alpha", "bc-a", "p", null)], "not: [valid");
    const { code, stderr } = await run(["status"], untyped, { agents: agents() });
    expect(code).toBe(1);
    expect(stderr).toContain("tasks.yaml: invalid YAML");
  });
});

describe("--watch", () => {
  it("re-checks every 60s, printing the table each time, until no agent is running", async () => {
    const dir = await project(ALL);
    const agents = new FakeAgents({
      "bc-a": { state: "running" },
      "bc-b": { state: "running" },
      "bc-g": { state: "finished" },
    });
    const onSleep = (_ms: number, count: number) => {
      if (count === 1) agents.agents["bc-a"] = { state: "finished" };
      if (count === 2) agents.agents["bc-b"] = { state: "error" };
    };
    const { code, stdout, sleeps } = await run(["status", "--watch"], dir, { agents, onSleep });
    expect(code).toBe(0);
    expect(sleeps).toEqual([60_000, 60_000]);
    expect(stdout.match(/^TICKET {2}TYPE/gm)).toHaveLength(3);
    expect(stdout).toContain("[2026-10-30T12:00:00.000Z] check 1\n");
    expect(stdout).toContain("[2026-10-30T12:00:00.000Z] check 3\n");
    expect(stdout).toContain("still running: alpha, beta; checking again in 60s\n");
    expect(stdout).toContain("still running: beta; checking again in 60s\n");
    expect(stdout.endsWith("no agent is still running; done watching\n")).toBe(true);
  });

  it("stops after one check when nothing is running", async () => {
    const dir = await project(ALL);
    const agents = new FakeAgents({ "bc-a": { state: "finished" }, "bc-b": { state: "cancelled" } });
    const { code, stdout, sleeps } = await run(["status", "--watch"], dir, { agents });
    expect(code).toBe(0);
    expect(sleeps).toEqual([]);
    expect(stdout).toContain("gamma   bug       not found");
    expect(stdout).toContain("done watching");
  });

  it("keeps watching through a failed lookup, and exits 0 once it recovers", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const agents = new FakeAgents({ "bc-a": new Error("socket hang up") });
    const onSleep = () => {
      agents.agents["bc-a"] = { state: "finished" };
    };
    const { code, sleeps, stderr } = await run(["status", "--watch"], dir, { agents, onSleep });
    expect(sleeps).toHaveLength(1);
    expect(stderr).toContain("socket hang up");
    expect(code).toBe(0);
  });

  it("picks up launches made while it watches", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const agents = new FakeAgents({ "bc-a": { state: "running" }, "bc-b": { state: "running" } });
    const onSleep = (_ms: number, count: number) => {
      if (count === 1) {
        writeFileSync(join(dir, ".proofline", "run.json"), JSON.stringify({ launches: [launch("alpha", "bc-a"), launch("beta", "bc-b")] }));
        agents.agents["bc-a"] = { state: "finished" };
      }
      if (count === 2) agents.agents["bc-b"] = { state: "finished" };
    };
    const { stdout, sleeps } = await run(["status", "--watch"], dir, { agents, onSleep });
    expect(sleeps).toHaveLength(2);
    expect(stdout).toContain("still running: beta;");
  });

  it("updates a PR that appears mid-watch once, not on every check", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const github = new FakeGitHub();
    const agents = new FakeAgents({ "bc-a": { state: "running", branch: "a" } });
    const onSleep = (_ms: number, count: number) => {
      if (count === 1) github.addPull({ number: 1, headRef: "a" });
      if (count === 3) agents.agents["bc-a"] = { state: "finished", branch: "a" };
    };
    const { sleeps, stdout } = await run(["status", "--watch"], dir, { agents, github, onSleep });
    expect(sleeps).toHaveLength(3);
    expect(github.writes).toEqual(["createLabel acme/app feature #ededed", "addLabels acme/app#1 feature", "setPullBody acme/app#1"]);
    expect(stdout.match(/labelled feature/g)).toHaveLength(1);
  });

  it("stops at once if GitHub rejects the token", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const github = new FakeGitHub();
    const agents = new FakeAgents({ "bc-a": { state: "running", branch: "a" } });
    const onSleep = () => {
      github.rejectToken = true;
    };
    const { code, sleeps, stderr } = await run(["status", "--watch"], dir, { agents, github, onSleep });
    expect(code).toBe(1);
    expect(sleeps).toHaveLength(1);
    expect(stderr).toContain("run `gh auth login`");
  });

  it("is rejected by run", async () => {
    const dir = await project([]);
    const { code, stderr } = await run(["run", "--watch"], dir);
    expect(code).toBe(2);
    expect(stderr).toContain("--watch only applies to `proofline status`");
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
    expect(betaPull.labels).toEqual(["security"]);
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

  it("ignores GITHUB_TOKEN in the environment", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const env = { CURSOR_API_KEY: "k", GITHUB_TOKEN: "from-env" };
    const { githubTokens } = await run(["status"], dir, { agents: agents(), env, ghToken: "from-gh" });
    expect(githubTokens).toEqual(["from-gh"]);
    const noGh = await run(["status"], dir, { agents: agents(), env, ghToken: undefined });
    expect(noGh.code).toBe(1);
    expect(noGh.githubTokens).toEqual([]);
  });

  it("fails with a `gh auth login` hint when gh has no token", async () => {
    const dir = await project([launch("alpha", "bc-a")]);
    const result = await run(["status"], dir, { agents: agents(), ghToken: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toBe("error: no GitHub token: `gh auth token` gave none; run `gh auth login`\n");
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
      "error: GitHub rejected the token (401 on GET /repos/acme/app); run `gh auth login`\n",
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
