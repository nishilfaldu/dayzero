import type { AgentReader, AgentSnapshot } from "./agents.js";
import { GitHubAuthError, type GitHub, type PullFile, type PullRequest, parsePullUrl } from "./github.js";
import { describeError } from "./launch.js";
import type { LaunchRecord, RunState } from "./state.js";
import { type TicketType, isTicketType } from "./types.js";

export interface TicketStatus {
  ticketId: string;
  /** Ticket type from tasks.yaml, or "?" when the ticket is no longer there. */
  type: string;
  agent: string;
  pr: string;
  /** What this run changed on the PR. */
  changes: string[];
  /** Things worth reading that aren't failures, e.g. the agent's error message. */
  notes: string[];
  /** Lookups or writes that failed; the command exits 1 if any ticket has one. */
  problems: string[];
}

export const PROMPT_START = "<!-- proofline:prompt -->";
export const PROMPT_END = "<!-- /proofline:prompt -->";
export const TEST_FILES_MARKER = "<!-- proofline:test-files -->";
const LABEL_COLOR = "ededed";

/** The newest launch per ticket, in the order tickets were first launched. */
export function latestLaunches(state: RunState): LaunchRecord[] {
  const latest = new Map<string, LaunchRecord>();
  for (const launch of state.launches) {
    latest.delete(launch.ticketId);
    latest.set(launch.ticketId, launch);
  }
  const firstSeen = [...new Set(state.launches.map((l) => l.ticketId))];
  return firstSeen.map((id) => latest.get(id)!);
}

/** The type recorded at launch; records from before types were recorded have none. */
export function recordedType(launch: LaunchRecord): TicketType | undefined {
  return isTicketType(launch.type) ? launch.type : undefined;
}

/** `type` is the recorded type, or for old records the ticket's type in tasks.yaml, if it's still there. */
export async function checkLaunch(
  launch: LaunchRecord,
  type: TicketType | undefined,
  clients: { agents: AgentReader; github: GitHub },
): Promise<TicketStatus> {
  const status: TicketStatus = {
    ticketId: launch.ticketId,
    type: type ?? "?",
    agent: "?",
    pr: "-",
    changes: [],
    notes: [],
    problems: [],
  };
  if (!type) status.notes.push("type unknown (not recorded at launch, and not in tasks.yaml), so no label is added");

  let snapshot: AgentSnapshot | undefined;
  try {
    snapshot = await clients.agents.snapshot(launch.agentId);
  } catch (err) {
    status.agent = "lookup failed";
    status.problems.push(`Cursor lookup for ${launch.agentId} failed: ${describeError(err)}`);
    return status;
  }
  if (!snapshot) {
    status.agent = "not found";
    status.notes.push(`Cursor has no agent ${launch.agentId}`);
    return status;
  }
  status.agent = snapshot.state;
  if (snapshot.error) status.notes.push(`agent error: ${snapshot.error}`);

  try {
    const pull = await findPull(launch.repo, snapshot, clients.github, status);
    if (!pull) {
      status.pr = await describeMissingPull(launch.repo, snapshot, clients.github);
      return status;
    }
    status.pr = `${pull.url}${pull.merged ? " (merged)" : pull.state === "closed" ? " (closed)" : ""}`;
    await syncPull(pull, launch, type, clients.github, status);
  } catch (err) {
    if (err instanceof GitHubAuthError) throw err;
    status.problems.push(`GitHub: ${describeError(err)}`);
  }
  return status;
}

/**
 * Cursor's prUrl is used only if GitHub has that PR, against this repo, from the agent's branch.
 * Otherwise look for a PR from the branch directly.
 */
async function findPull(
  repo: string,
  snapshot: AgentSnapshot,
  github: GitHub,
  status: TicketStatus,
): Promise<PullRequest | undefined> {
  if (snapshot.prUrl) {
    const ref = parsePullUrl(snapshot.prUrl);
    const pull = ref && (await github.getPull(ref.repo, ref.number));
    const sameRepo = pull && pull.repo.toLowerCase() === repo.toLowerCase();
    const sameBranch = pull && (!snapshot.branch || pull.headRef === snapshot.branch);
    if (pull && sameRepo && sameBranch) return pull;
    status.notes.push(
      pull
        ? `Cursor's PR link ${snapshot.prUrl} is for ${pull.repo} branch ${pull.headRef}, not ${repo}${snapshot.branch ? ` branch ${snapshot.branch}` : ""}; ignored`
        : `Cursor's PR link ${snapshot.prUrl} doesn't exist on GitHub; ignored`,
    );
  }
  return snapshot.branch ? github.findPullForBranch(repo, snapshot.branch) : undefined;
}

async function describeMissingPull(repo: string, snapshot: AgentSnapshot, github: GitHub): Promise<string> {
  const { state, branch } = snapshot;
  if (branch) {
    if (await github.branchExists(repo, branch)) return `no PR yet (branch ${branch} is on GitHub)`;
    return state === "running" ? `no PR yet (branch ${branch} not pushed yet)` : `branch ${branch} never reached GitHub`;
  }
  if (state === "running") return "no PR yet";
  if (state === "finished") return "no PR (agent finished without a branch)";
  return `no PR (agent ${state === "error" ? "failed" : state})`;
}

async function syncPull(
  pull: PullRequest,
  launch: LaunchRecord,
  type: TicketType | undefined,
  github: GitHub,
  status: TicketStatus,
): Promise<void> {
  if (type && !pull.labels.includes(type)) {
    await github.ensureLabel(pull.repo, type, LABEL_COLOR);
    await github.addLabels(pull.repo, pull.number, [type]);
    status.changes.push(`labelled ${type}`);
  }

  const body = upsertPromptSection(pull.body, promptSection(launch));
  if (body !== normalize(pull.body)) {
    await github.setPullBody(pull.repo, pull.number, body);
    status.changes.push(normalize(pull.body).includes(PROMPT_START) ? "updated the prompt in the PR description" : "added the prompt to the PR description");
  }

  const touched = (await github.listPullFiles(pull.repo, pull.number)).filter(touchesExistingTest);
  if (touched.length === 0) return;
  const comment = testFilesComment(touched);
  const existing = (await github.listComments(pull.repo, pull.number)).find((c) => c.body.includes(TEST_FILES_MARKER));
  if (!existing) {
    await github.createComment(pull.repo, pull.number, comment);
    status.changes.push(`commented on ${touched.length} changed test file(s)`);
  } else if (normalize(existing.body) !== comment) {
    await github.updateComment(pull.repo, existing.id, comment);
    status.changes.push(`updated the test-file comment (${touched.length} file(s))`);
  }
}

export function promptSection(launch: LaunchRecord): string {
  const fence = "`".repeat(Math.max(3, longestBacktickRun(launch.prompt) + 1));
  return [
    PROMPT_START,
    "### Prompt sent by proofline",
    "",
    `Ticket \`${launch.ticketId}\`, agent [${launch.agentId}](${launch.agentUrl}), launched ${launch.launchedAt}:`,
    "",
    `${fence}text`,
    launch.prompt,
    fence,
    PROMPT_END,
  ].join("\n");
}

/** Replaces proofline's section if the body has one, else appends it. Never adds a second copy. */
export function upsertPromptSection(body: string, section: string): string {
  const text = normalize(body);
  const start = text.indexOf(PROMPT_START);
  if (start === -1) return text.trim() ? `${text.trimEnd()}\n\n${section}` : section;
  const end = text.indexOf(PROMPT_END, start);
  const after = end === -1 ? "" : text.slice(end + PROMPT_END.length);
  return `${text.slice(0, start)}${section}${after}`;
}

const TEST_DIRS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "__snapshots__"]);

/** Test directories, or names like foo.test.ts, foo_spec.rb, test_foo.py, foo_test.go. */
export function isTestPath(path: string): boolean {
  const parts = path.toLowerCase().split("/");
  const name = parts.pop()!;
  return parts.some((dir) => TEST_DIRS.has(dir)) || /(^|[._-])(test|spec)s?([._-]|$)/.test(name);
}

/** Edits, deletions and renames of files that were already tests. New test files don't count. */
export function touchesExistingTest(file: PullFile): boolean {
  if (file.status === "renamed") return isTestPath(file.previousFilename ?? file.filename);
  return (file.status === "modified" || file.status === "changed" || file.status === "removed") && isTestPath(file.filename);
}

export function testFilesComment(files: PullFile[]): string {
  const lines = files.map((f) => {
    if (f.status === "removed") return `- \`${f.filename}\` (deleted)`;
    if (f.status === "renamed") return `- \`${f.previousFilename}\` → \`${f.filename}\` (renamed)`;
    return `- \`${f.filename}\` (edited)`;
  });
  return [
    TEST_FILES_MARKER,
    "**proofline:** this PR changes existing test files. The ticket said to leave existing tests alone unless it needed to change them, and to say why.",
    "",
    ...lines,
  ].join("\n");
}

function longestBacktickRun(text: string): number {
  return Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
}

/** GitHub can hand back CRLF bodies after web edits; compare and write with LF only. */
function normalize(text: string): string {
  return text.replace(/\r\n/g, "\n");
}
