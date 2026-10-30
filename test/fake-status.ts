import type { AgentReader, AgentSnapshot } from "../src/agents.js";
import { GitHubAuthError, type GitHub, type IssueComment, type PullFile, type PullRequest } from "../src/github.js";

/** Snapshots by agent id; an Error entry makes the lookup throw, a missing entry means "not found". */
export class FakeAgents implements AgentReader {
  readonly lookups: string[] = [];
  constructor(public agents: Record<string, AgentSnapshot | Error>) {}

  async snapshot(agentId: string): Promise<AgentSnapshot | undefined> {
    this.lookups.push(agentId);
    const entry = this.agents[agentId];
    if (entry instanceof Error) throw entry;
    return entry;
  }
}

interface FakePull extends PullRequest {
  files: PullFile[];
  comments: IssueComment[];
}

/** An in-memory GitHub that applies writes, so a second status run sees the first one's changes. */
export class FakeGitHub implements GitHub {
  readonly pulls: FakePull[] = [];
  readonly branches = new Set<string>();
  readonly labels = new Set<string>();
  /** Every write, in order, e.g. "addLabels acme/app#7 feature". */
  readonly writes: string[] = [];
  rejectToken = false;
  private nextComment = 1;

  addPull(pull: Partial<FakePull> & { number: number; headRef: string }): FakePull {
    const full: FakePull = {
      url: `https://github.com/acme/app/pull/${pull.number}`,
      repo: "acme/app",
      state: "open",
      merged: false,
      baseRef: "main",
      body: "",
      labels: [],
      files: [],
      comments: [],
      ...pull,
    };
    this.pulls.push(full);
    this.branches.add(`${full.repo}:${full.headRef}`);
    return full;
  }

  private check(): void {
    if (this.rejectToken) throw new GitHubAuthError("GitHub rejected the token (401 on GET /repos/acme/app)");
  }

  private pull(repo: string, number: number): FakePull {
    const pull = this.pulls.find((p) => p.repo === repo && p.number === number);
    if (!pull) throw new Error(`no PR ${repo}#${number}`);
    return pull;
  }

  private copy(pull: FakePull): PullRequest {
    const { files: _f, comments: _c, ...rest } = pull;
    return { ...rest, labels: [...rest.labels] };
  }

  async getPull(repo: string, number: number) {
    this.check();
    const pull = this.pulls.find((p) => p.repo === repo && p.number === number);
    return pull && this.copy(pull);
  }

  async findPullForBranch(repo: string, branch: string) {
    this.check();
    const pulls = this.pulls.filter((p) => p.repo === repo && p.headRef === branch).reverse();
    const pull = pulls.find((p) => p.state === "open") ?? pulls[0];
    return pull && this.copy(pull);
  }

  async branchExists(repo: string, branch: string) {
    this.check();
    return this.branches.has(`${repo}:${branch}`);
  }

  async listPullFiles(repo: string, number: number) {
    this.check();
    return [...this.pull(repo, number).files];
  }

  async ensureLabel(repo: string, name: string, color: string) {
    this.check();
    if (this.labels.has(`${repo}:${name}`)) return;
    this.labels.add(`${repo}:${name}`);
    this.writes.push(`createLabel ${repo} ${name} #${color}`);
  }

  async addLabels(repo: string, number: number, labels: string[]) {
    this.check();
    const pull = this.pull(repo, number);
    for (const label of labels) if (!pull.labels.includes(label)) pull.labels.push(label);
    this.writes.push(`addLabels ${repo}#${number} ${labels.join(",")}`);
  }

  async setPullBody(repo: string, number: number, body: string) {
    this.check();
    this.pull(repo, number).body = body;
    this.writes.push(`setPullBody ${repo}#${number}`);
  }

  async listComments(repo: string, number: number) {
    this.check();
    return this.pull(repo, number).comments.map((c) => ({ ...c }));
  }

  async createComment(repo: string, number: number, body: string) {
    this.check();
    this.pull(repo, number).comments.push({ id: this.nextComment++, body });
    this.writes.push(`createComment ${repo}#${number}`);
  }

  async updateComment(repo: string, commentId: number, body: string) {
    this.check();
    const comment = this.pulls.flatMap((p) => p.comments).find((c) => c.id === commentId);
    if (!comment) throw new Error(`no comment ${commentId}`);
    comment.body = body;
    this.writes.push(`updateComment ${repo} ${commentId}`);
  }
}
