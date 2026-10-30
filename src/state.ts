import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError } from "./config.js";
import type { TicketType } from "./types.js";

export const STATE_PATH = join(".proofline", "run.json");

/** One successful launch. Relaunches append a new record; nothing is ever overwritten. */
export interface LaunchRecord {
  ticketId: string;
  /** The ticket's type at launch. Missing from records written before types were recorded. */
  type?: TicketType;
  agentId: string;
  agentUrl: string;
  runId: string;
  launchedAt: string;
  repo: string;
  /** The model id requested, or null for the SDK default. */
  model: string | null;
  prompt: string;
}

export interface RunState {
  launches: LaunchRecord[];
}

export async function readState(cwd: string): Promise<RunState> {
  const path = join(cwd, STATE_PATH);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { launches: [] };
    throw err;
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new ConfigError([`${STATE_PATH}: not valid JSON (${(err as Error).message}); fix or move it aside`]);
  }
  if (typeof data !== "object" || data === null || !Array.isArray((data as RunState).launches)) {
    throw new ConfigError([`${STATE_PATH}: expected an object with a "launches" list; fix or move it aside`]);
  }
  return data as RunState;
}

/** Writes via a temp file and rename so an interrupted write never leaves half a file. */
export async function writeState(cwd: string, state: RunState): Promise<void> {
  const path = join(cwd, STATE_PATH);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`);
  await rename(tmp, path);
}

export function launchedTicketIds(state: RunState): Set<string> {
  return new Set(state.launches.map((launch) => launch.ticketId));
}
