import { execFile } from "node:child_process";
import { promisify } from "node:util";

export interface PullRequest {
  number: number;
  url: string;
  /** owner/name the PR is opened against. */
  repo: string;
  state: "open" | "closed";
  merged: boolean;
  headRef: string;
  body: string;
  labels: string[];
}

export interface PullFile {
  filename: string;
  /** added, removed, modified, renamed, copied, changed or unchanged. */
  status: string;
  previousFilename?: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface GitHub {
  getPull(repo: string, number: number): Promise<PullRequest | undefined>;
  /** The open PR from `branch` if there is one, else the newest closed one. */
  findPullForBranch(repo: string, branch: string): Promise<PullRequest | undefined>;
  branchExists(repo: string, branch: string): Promise<boolean>;
  listPullFiles(repo: string, number: number): Promise<PullFile[]>;
  ensureLabel(repo: string, name: string, color: string): Promise<void>;
  addLabels(repo: string, number: number, labels: string[]): Promise<void>;
  setPullBody(repo: string, number: number, body: string): Promise<void>;
  listComments(repo: string, number: number): Promise<IssueComment[]>;
  createComment(repo: string, number: number, body: string): Promise<void>;
  updateComment(repo: string, commentId: number, body: string): Promise<void>;
}

export const LOGIN_HINT = "run `gh auth login`, or set GITHUB_TOKEN";

/** GitHub rejected the token. Stops the whole command, since every later call would fail the same way. */
export class GitHubAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitHubAuthError";
  }
}

export interface GitHubToken {
  token: string;
  source: "GITHUB_TOKEN" | "gh auth token";
}

/** GITHUB_TOKEN from the environment wins; otherwise ask the gh CLI. Undefined if neither has one. */
export async function resolveGitHubToken(
  env: NodeJS.ProcessEnv,
  ghAuthToken: () => Promise<string | undefined> = runGhAuthToken,
): Promise<GitHubToken | undefined> {
  const fromEnv = env.GITHUB_TOKEN?.trim();
  if (fromEnv) return { token: fromEnv, source: "GITHUB_TOKEN" };
  const fromGh = (await ghAuthToken())?.trim();
  return fromGh ? { token: fromGh, source: "gh auth token" } : undefined;
}

export async function runGhAuthToken(): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("gh", ["auth", "token"], { timeout: 10_000 });
    return stdout;
  } catch {
    // gh missing, not logged in, or timed out: all mean "no token from gh".
    return undefined;
  }
}

const API = "https://api.github.com";
const PER_PAGE = 100;
const MAX_PAGES = 30;

export function createGitHubClient(token: string, fetchImpl: typeof fetch = fetch): GitHub {
  async function request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetchImpl(`${API}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body !== undefined && { "Content-Type": "application/json" }),
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (response.status === 401) {
      throw new GitHubAuthError(`GitHub rejected the token (401 on ${method} ${path})`);
    }
    return response;
  }

  async function json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await request(method, path, body);
    if (!response.ok) throw await httpError(method, path, response);
    return (await response.json()) as T;
  }

  /** GET that maps 404 to undefined. */
  async function find<T>(path: string): Promise<T | undefined> {
    const response = await request("GET", path);
    if (response.status === 404) return undefined;
    if (!response.ok) throw await httpError("GET", path, response);
    return (await response.json()) as T;
  }

  async function all<T>(path: string): Promise<T[]> {
    const items: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= MAX_PAGES; page++) {
      const batch = await json<T[]>("GET", `${path}${sep}per_page=${PER_PAGE}&page=${page}`);
      items.push(...batch);
      if (batch.length < PER_PAGE) break;
    }
    return items;
  }

  return {
    async getPull(repo, number) {
      const pull = await find<ApiPull>(`/repos/${repoPath(repo)}/pulls/${number}`);
      return pull && toPull(pull);
    },
    async findPullForBranch(repo, branch) {
      const owner = repo.split("/")[0]!;
      const head = encodeURIComponent(`${owner}:${branch}`);
      const pulls = (await json<ApiPull[]>("GET", `/repos/${repoPath(repo)}/pulls?state=all&head=${head}`)).map(toPull);
      return pulls.find((p) => p.state === "open") ?? pulls[0];
    },
    async branchExists(repo, branch) {
      const ref = branch.split("/").map(encodeURIComponent).join("/");
      return (await find(`/repos/${repoPath(repo)}/git/ref/heads/${ref}`)) !== undefined;
    },
    async listPullFiles(repo, number) {
      const files = await all<ApiPullFile>(`/repos/${repoPath(repo)}/pulls/${number}/files`);
      return files.map((f) => ({
        filename: f.filename,
        status: f.status,
        ...(f.previous_filename && { previousFilename: f.previous_filename }),
      }));
    },
    async ensureLabel(repo, name, color) {
      if (await find(`/repos/${repoPath(repo)}/labels/${encodeURIComponent(name)}`)) return;
      const response = await request("POST", `/repos/${repoPath(repo)}/labels`, { name, color });
      // 422 means another run created it in between; that's fine.
      if (!response.ok && response.status !== 422) throw await httpError("POST", "labels", response);
    },
    async addLabels(repo, number, labels) {
      await json("POST", `/repos/${repoPath(repo)}/issues/${number}/labels`, { labels });
    },
    async setPullBody(repo, number, body) {
      await json("PATCH", `/repos/${repoPath(repo)}/pulls/${number}`, { body });
    },
    async listComments(repo, number) {
      const comments = await all<{ id: number; body?: string | null }>(
        `/repos/${repoPath(repo)}/issues/${number}/comments`,
      );
      return comments.map((c) => ({ id: c.id, body: c.body ?? "" }));
    },
    async createComment(repo, number, body) {
      await json("POST", `/repos/${repoPath(repo)}/issues/${number}/comments`, { body });
    },
    async updateComment(repo, commentId, body) {
      await json("PATCH", `/repos/${repoPath(repo)}/issues/comments/${commentId}`, { body });
    },
  };
}

/** github.com/<owner>/<name>/pull/<n>, with or without scheme. */
export function parsePullUrl(url: string): { repo: string; number: number } | undefined {
  const match = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\b/.exec(url.trim());
  return match ? { repo: match[1]!, number: Number(match[2]) } : undefined;
}

interface ApiPull {
  number: number;
  html_url: string;
  state: "open" | "closed";
  merged_at: string | null;
  body: string | null;
  head: { ref: string };
  base: { repo: { full_name: string } };
  labels: { name: string }[];
}

interface ApiPullFile {
  filename: string;
  status: string;
  previous_filename?: string;
}

function toPull(pull: ApiPull): PullRequest {
  return {
    number: pull.number,
    url: pull.html_url,
    repo: pull.base.repo.full_name,
    state: pull.state,
    merged: pull.merged_at !== null,
    headRef: pull.head.ref,
    body: pull.body ?? "",
    labels: pull.labels.map((l) => l.name),
  };
}

function repoPath(repo: string): string {
  return repo.split("/").map(encodeURIComponent).join("/");
}

async function httpError(method: string, path: string, response: Response): Promise<Error> {
  let detail = "";
  try {
    detail = ((await response.json()) as { message?: string }).message ?? "";
  } catch {
    // Body wasn't JSON; the status is enough.
  }
  return new Error(`GitHub ${method} ${path.split("?")[0]} failed: ${response.status}${detail ? ` ${detail}` : ""}`);
}
