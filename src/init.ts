import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AgentReader } from "./agents.js";
import { ConfigError } from "./config.js";
import type { GitHub, PullRequest } from "./github.js";
import { STARTING_REF } from "./launch.js";
import { type RunState, initLaunches } from "./state.js";
import { findPull } from "./status.js";

export { INIT_ID } from "./types.js";

export const INIT_TEMPLATE_PATH = fileURLToPath(new URL("../prompts/init.md", import.meta.url));

const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g;

export async function loadInitTemplate(path = INIT_TEMPLATE_PATH, label = "prompts/init.md"): Promise<string> {
  const template = await readFile(path, "utf8");
  const problems = checkInitTemplate(template, label);
  if (problems.length > 0) throw new ConfigError(problems);
  return template;
}

/** The init prompt only knows {repo}; anything else would reach the agent as literal braces. */
export function checkInitTemplate(template: string, label = "prompts/init.md"): string[] {
  return [...template.matchAll(PLACEHOLDER_PATTERN)]
    .filter(([, name]) => name !== "repo")
    .map(([match]) => `${label}: unknown placeholder ${match} (only {repo} is filled in)`);
}

export function renderInitPrompt(template: string, repo: string): string {
  return template.trimEnd().replace(PLACEHOLDER_PATTERN, (match, name: string) => (name === "repo" ? repo : match));
}

export type InitCheck = { ready: true; pull: PullRequest } | { ready: false; reason: string };

/**
 * Ticket agents start from main, so they only get what init set up once its PR is merged there.
 * Ready if any init recorded for `repo` has a PR merged into main; otherwise the reason is about the newest one.
 */
export async function checkInitMerged(
  state: RunState,
  repo: string,
  clients: { agents: AgentReader; github: GitHub },
): Promise<InitCheck> {
  const inits = initLaunches(state).filter((launch) => launch.repo.toLowerCase() === repo.toLowerCase());
  if (inits.length === 0) return { ready: false, reason: `no \`dayzero init\` is recorded for ${repo}` };

  const reasons: string[] = [];
  for (const launch of inits.reverse()) {
    const snapshot = await clients.agents.snapshot(launch.agentId);
    if (!snapshot) {
      reasons.push(`Cursor has no init agent ${launch.agentId}`);
      continue;
    }
    const pull = await findPull(launch.repo, snapshot, clients.github, []);
    if (pull?.merged && pull.baseRef === STARTING_REF) return { ready: true, pull };
    if (pull?.merged) reasons.push(`init's PR ${pull.url} was merged into ${pull.baseRef}, not ${STARTING_REF}`);
    else if (pull) reasons.push(`init's PR ${pull.url} isn't merged yet`);
    else if (snapshot.state === "running") reasons.push(`the init agent is still running and has no PR yet (${launch.agentUrl})`);
    else reasons.push(`the init agent has no PR (agent ${snapshot.state}: ${launch.agentUrl})`);
  }
  return { ready: false, reason: reasons[0]! };
}
