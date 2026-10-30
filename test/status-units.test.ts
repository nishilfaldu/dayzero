import { describe, expect, it } from "vitest";
import { type CursorRunsSdk, createCursorReader } from "../src/agents.js";
import { GitHubAuthError, createGitHubClient, parsePullUrl, resolveGitHubToken } from "../src/github.js";
import {
  PROMPT_END,
  PROMPT_START,
  isTestPath,
  latestLaunches,
  touchesExistingTest,
  upsertPromptSection,
} from "../src/status.js";

describe("isTestPath", () => {
  it.each([
    "tests/e2e/notes.test.ts",
    "app/utils/misc.test.ts",
    "app/components/button.spec.tsx",
    "src/__tests__/thing.ts",
    "pkg/server_test.go",
    "test_models.py",
    "spec/models/user_spec.rb",
    "app/__snapshots__/a.snap",
    "e2e/login.ts",
    "Tests/Upper.test.ts",
  ])("treats %s as a test", (path) => {
    expect(isTestPath(path)).toBe(true);
  });

  it.each(["app/routes/notes.tsx", "app/latest.ts", "docs/testing.md", "contest-results.ts", "README.md"])(
    "doesn't treat %s as a test",
    (path) => {
      expect(isTestPath(path)).toBe(false);
    },
  );
});

describe("touchesExistingTest", () => {
  it("counts edits, deletions and renames of tests, not additions or copies", () => {
    expect(touchesExistingTest({ filename: "a.test.ts", status: "modified" })).toBe(true);
    expect(touchesExistingTest({ filename: "a.test.ts", status: "changed" })).toBe(true);
    expect(touchesExistingTest({ filename: "a.test.ts", status: "removed" })).toBe(true);
    expect(touchesExistingTest({ filename: "b.ts", status: "renamed", previousFilename: "a.test.ts" })).toBe(true);
    expect(touchesExistingTest({ filename: "a.test.ts", status: "added" })).toBe(false);
    expect(touchesExistingTest({ filename: "b.test.ts", status: "copied" })).toBe(false);
    expect(touchesExistingTest({ filename: "b.test.ts", status: "renamed", previousFilename: "a.ts" })).toBe(false);
  });
});

describe("upsertPromptSection", () => {
  const section = `${PROMPT_START}\nnew\n${PROMPT_END}`;

  it("appends to an empty or non-empty body", () => {
    expect(upsertPromptSection("", section)).toBe(section);
    expect(upsertPromptSection("Body.\n\n", section)).toBe(`Body.\n\n${section}`);
  });

  it("replaces an existing section", () => {
    expect(upsertPromptSection(`A\n${PROMPT_START}\nold\n${PROMPT_END}\nB`, section)).toBe(`A\n${section}\nB`);
  });

  it("replaces through the end when the closing marker was deleted", () => {
    expect(upsertPromptSection(`A\n${PROMPT_START}\nold and cut off`, section)).toBe(`A\n${section}`);
  });

  it("is stable: applying it twice changes nothing", () => {
    const once = upsertPromptSection("Body.", section);
    expect(upsertPromptSection(once, section)).toBe(once);
  });
});

describe("latestLaunches", () => {
  it("keeps the last launch per ticket, in first-launched order", () => {
    const l = (ticketId: string, agentId: string) => ({ ticketId, agentId }) as never;
    const latest = latestLaunches({ launches: [l("a", "1"), l("b", "2"), l("a", "3")] });
    expect(latest.map((x: { agentId: string }) => x.agentId)).toEqual(["3", "2"]);
  });
});

describe("parsePullUrl", () => {
  it("reads repo and number", () => {
    expect(parsePullUrl("https://github.com/acme/app/pull/12")).toEqual({ repo: "acme/app", number: 12 });
    expect(parsePullUrl("github.com/acme/my.app/pull/3/files")).toEqual({ repo: "acme/my.app", number: 3 });
    expect(parsePullUrl("https://gitlab.com/acme/app/pull/1")).toBeUndefined();
  });
});

describe("resolveGitHubToken", () => {
  it("prefers GITHUB_TOKEN, then gh, else undefined", async () => {
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "e" }, async () => "g")).toEqual({ token: "e", source: "GITHUB_TOKEN" });
    expect(await resolveGitHubToken({}, async () => "g\n")).toEqual({ token: "g", source: "gh auth token" });
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "" }, async () => undefined)).toBeUndefined();
  });
});

describe("createGitHubClient", () => {
  function fakeFetch(routes: Record<string, { status?: number; body?: unknown; bodies?: unknown[] }>) {
    const calls: { method: string; url: string; auth: string | null; body?: unknown }[] = [];
    const pages: Record<string, number> = {};
    const fetchImpl = (async (url: string, init: RequestInit) => {
      const method = init.method ?? "GET";
      const headers = new Headers(init.headers);
      calls.push({
        method,
        url,
        auth: headers.get("Authorization"),
        ...(init.body !== undefined && { body: JSON.parse(String(init.body)) }),
      });
      const key = `${method} ${url.replace("https://api.github.com", "").replace(/[?&]per_page=\d+&page=\d+/, "")}`;
      const route = routes[key] ?? { status: 404, body: { message: "Not Found" } };
      let body = route.body;
      if (route.bodies) {
        pages[key] = (pages[key] ?? 0) + 1;
        body = route.bodies[pages[key]! - 1] ?? [];
      }
      return new Response(JSON.stringify(body ?? {}), { status: route.status ?? 200 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  const apiPull = (number: number, ref: string, state = "open") => ({
    number,
    html_url: `https://github.com/acme/app/pull/${number}`,
    state,
    merged_at: null,
    body: null,
    head: { ref },
    base: { repo: { full_name: "acme/app" } },
    labels: [{ name: "x" }],
  });

  it("sends the token and maps a pull", async () => {
    const { fetchImpl, calls } = fakeFetch({ "GET /repos/acme/app/pulls/3": { body: apiPull(3, "cursor/a") } });
    const pull = await createGitHubClient("tok", fetchImpl).getPull("acme/app", 3);
    expect(pull).toEqual({
      number: 3,
      url: "https://github.com/acme/app/pull/3",
      repo: "acme/app",
      state: "open",
      merged: false,
      headRef: "cursor/a",
      body: "",
      labels: ["x"],
    });
    expect(calls[0]!.auth).toBe("Bearer tok");
  });

  it("maps 404 to not-found for pulls and branches, and encodes branch slashes per segment", async () => {
    const { fetchImpl, calls } = fakeFetch({ "GET /repos/acme/app/git/ref/heads/cursor/a%20b": { body: {} } });
    const github = createGitHubClient("t", fetchImpl);
    expect(await github.getPull("acme/app", 9)).toBeUndefined();
    expect(await github.branchExists("acme/app", "cursor/a b")).toBe(true);
    expect(await github.branchExists("acme/app", "cursor/missing")).toBe(false);
    expect(calls[1]!.url).toBe("https://api.github.com/repos/acme/app/git/ref/heads/cursor/a%20b");
  });

  it("throws GitHubAuthError on 401", async () => {
    const { fetchImpl } = fakeFetch({ "GET /repos/acme/app/pulls/1": { status: 401, body: { message: "Bad credentials" } } });
    await expect(createGitHubClient("t", fetchImpl).getPull("acme/app", 1)).rejects.toBeInstanceOf(GitHubAuthError);
  });

  it("throws a readable error on other failures", async () => {
    const { fetchImpl } = fakeFetch({ "POST /repos/acme/app/issues/1/labels": { status: 403, body: { message: "Resource not accessible" } } });
    await expect(createGitHubClient("t", fetchImpl).addLabels("acme/app", 1, ["bug"])).rejects.toThrow(
      "GitHub POST /repos/acme/app/issues/1/labels failed: 403 Resource not accessible",
    );
  });

  it("finds a branch's PR by owner:branch, preferring an open one", async () => {
    const { fetchImpl, calls } = fakeFetch({
      "GET /repos/acme/app/pulls?state=all&head=acme%3Acursor%2Fa": { body: [apiPull(2, "cursor/a", "closed"), apiPull(1, "cursor/a")] },
    });
    const pull = await createGitHubClient("t", fetchImpl).findPullForBranch("acme/app", "cursor/a");
    expect(pull?.number).toBe(1);
    expect(calls[0]!.url).toContain("head=acme%3Acursor%2Fa");
  });

  it("pages through PR files", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ filename: `f${i}.ts`, status: "modified" }));
    const page2 = [{ filename: "b.ts", status: "renamed", previous_filename: "a.test.ts" }];
    const { fetchImpl, calls } = fakeFetch({ "GET /repos/acme/app/pulls/1/files": { bodies: [page1, page2] } });
    const files = await createGitHubClient("t", fetchImpl).listPullFiles("acme/app", 1);
    expect(files).toHaveLength(101);
    expect(files[100]).toEqual({ filename: "b.ts", status: "renamed", previousFilename: "a.test.ts" });
    expect(calls).toHaveLength(2);
  });

  it("creates a missing label, tolerating a race where it already exists", async () => {
    const { fetchImpl, calls } = fakeFetch({ "POST /repos/acme/app/labels": { status: 422, body: { message: "already_exists" } } });
    await createGitHubClient("t", fetchImpl).ensureLabel("acme/app", "seeded", "b60205");
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/app/labels/seeded",
      "POST https://api.github.com/repos/acme/app/labels",
    ]);
    expect(calls[1]!.body).toEqual({ name: "seeded", color: "b60205" });
  });

  it("skips creating a label that exists", async () => {
    const { fetchImpl, calls } = fakeFetch({ "GET /repos/acme/app/labels/bug": { body: { name: "bug" } } });
    await createGitHubClient("t", fetchImpl).ensureLabel("acme/app", "bug", "ededed");
    expect(calls).toHaveLength(1);
  });
});

describe("createCursorReader", () => {
  function sdk(runs: unknown[] | Error) {
    const calls: unknown[] = [];
    const fake: CursorRunsSdk = {
      Agent: {
        async listRuns(agentId, options) {
          calls.push({ agentId, ...options });
          if (runs instanceof Error) throw runs;
          return { items: runs as never };
        },
      },
    };
    return { fake, calls };
  }

  it("reports the newest run's state, and branch/PR from the newest run that has them", async () => {
    const { fake, calls } = sdk([
      { status: "cancelled", git: { branches: [{ repoUrl: "github.com/acme/app" }] } },
      { status: "error", git: { branches: [{ repoUrl: "github.com/acme/app", branch: "cursor/a", prUrl: "https://github.com/acme/app/pull/1" }] } },
    ]);
    const snapshot = await createCursorReader("key", async () => fake).snapshot("bc-1");
    expect(snapshot).toEqual({ state: "cancelled", branch: "cursor/a", prUrl: "https://github.com/acme/app/pull/1" });
    expect(calls).toEqual([{ agentId: "bc-1", runtime: "cloud", apiKey: "key", limit: 20 }]);
  });

  it("includes the newest run's error", async () => {
    const { fake } = sdk([{ status: "error", error: { message: "boom", code: "internal" } }]);
    expect(await createCursorReader("k", async () => fake).snapshot("bc-1")).toEqual({ state: "error", error: "boom [internal]" });
  });

  it("returns undefined for an unknown agent or one with no runs", async () => {
    const notFound = Object.assign(new Error("no such agent"), { name: "AgentNotFoundError" });
    expect(await createCursorReader("k", async () => sdk(notFound).fake).snapshot("bc-x")).toBeUndefined();
    expect(await createCursorReader("k", async () => sdk([]).fake).snapshot("bc-x")).toBeUndefined();
  });

  it("passes other errors through", async () => {
    const { fake } = sdk(new Error("network down"));
    await expect(createCursorReader("k", async () => fake).snapshot("bc-1")).rejects.toThrow("network down");
  });
});
