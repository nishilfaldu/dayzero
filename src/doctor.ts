import { ConfigError, loadConfig, loadTasks } from "./config.js";
import { API_KEY_VAR, resolveApiKey } from "./env.js";
import { LOGIN_HINT, resolveGitHubToken } from "./github.js";

export const MIN_NODE = [22, 13] as const;

export interface DoctorDeps {
  nodeVersion: string;
  ghAuthToken: () => Promise<string | undefined>;
  fetch: typeof fetch;
  /** URLs of the GitHub repos the key's Cursor account has connected. */
  listCursorRepos: (apiKey: string) => Promise<string[]>;
}

export const processDoctorDeps: DoctorDeps = {
  nodeVersion: process.versions.node,
  ghAuthToken: () => import("./github.js").then((m) => m.runGhAuthToken()),
  fetch: (...args) => fetch(...args),
  listCursorRepos: async (apiKey) => {
    const { Cursor } = await import("@cursor/sdk");
    return (await Cursor.repositories.list({ apiKey })).map((r) => r.url);
  },
};

export interface Check {
  ok: boolean;
  label: string;
  /** What to do when the check fails. */
  fix?: string;
}

/** Runs every check it can; later checks that need an earlier one's result are skipped when it failed. */
export async function runChecks(
  cwd: string,
  env: NodeJS.ProcessEnv,
  tasksPath: string,
  tasksLabel: string,
  configPath: string,
  configLabel: string,
  deps: DoctorDeps,
): Promise<Check[]> {
  const checks: Check[] = [];

  const [major = 0, minor = 0] = deps.nodeVersion.split(".").map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  checks.push({
    ok: nodeOk,
    label: `Node ${deps.nodeVersion}`,
    ...(!nodeOk && { fix: `install Node ${MIN_NODE.join(".")} or later (@cursor/sdk needs it)` }),
  });

  let repo: string | undefined;
  for (const [load, path, label] of [
    [loadTasks, tasksPath, tasksLabel],
    [loadConfig, configPath, configLabel],
  ] as const) {
    try {
      const loaded = await load(path, label);
      if ("repo" in loaded) repo = loaded.repo;
      checks.push({ ok: true, label: `${label} is valid` });
    } catch (err) {
      if (!(err instanceof ConfigError)) throw err;
      checks.push({ ok: false, label: `${label} is invalid`, fix: err.problems.join("; ") });
    }
  }

  const token = await resolveGitHubToken(deps.ghAuthToken);
  checks.push({ ok: token !== undefined, label: "GitHub token from `gh auth token`", ...(!token && { fix: LOGIN_HINT }) });
  if (token && repo) {
    const res = await deps.fetch(`https://api.github.com/repos/${repo}`, {
      headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
    });
    checks.push({
      ok: res.ok,
      label: `GitHub can see ${repo}`,
      ...(!res.ok && { fix: `GitHub answered ${res.status}; check the repo name in ${tasksLabel} and that your gh account can open it` }),
    });
  }

  const apiKey = await resolveApiKey(cwd, env);
  checks.push({
    ok: apiKey !== undefined,
    label: `${API_KEY_VAR}${apiKey ? ` (from ${apiKey.source})` : ""}`,
    ...(!apiKey && { fix: `set ${API_KEY_VAR} in the environment or in .env.local` }),
  });
  if (apiKey && repo) {
    const target = repo;
    try {
      const urls = await deps.listCursorRepos(apiKey.key);
      const connected = urls.some((url) => sameRepo(url, target));
      checks.push({
        ok: connected,
        label: `Cursor can reach ${repo}`,
        ...(!connected && { fix: "connect the repo to Cursor (cursor.com/dashboard, GitHub integration) so cloud agents can open PRs on it" }),
      });
    } catch (err) {
      checks.push({ ok: false, label: `Cursor can reach ${repo}`, fix: `couldn't list Cursor's repos: ${(err as Error).message}` });
    }
  }
  return checks;
}

function sameRepo(url: string, repo: string): boolean {
  const name = url.trim().replace(/\.git$/, "").replace(/\/$/, "").split("github.com/")[1];
  return name?.toLowerCase() === repo.toLowerCase();
}
