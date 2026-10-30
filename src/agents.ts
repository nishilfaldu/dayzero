export type AgentState = "running" | "finished" | "error" | "cancelled";

export interface AgentSnapshot {
  /** The agent's newest run, which may be a follow-up started outside proofline. */
  state: AgentState;
  /** Error text from the newest run, if it failed. */
  error?: string;
  /** Branch and PR as Cursor reports them; either may be missing, and neither is checked against GitHub. */
  branch?: string;
  prUrl?: string;
  /** When the newest run ended, if it has and Cursor reports its start and duration. */
  finishedAt?: Date;
}

export interface AgentReader {
  /** Undefined when Cursor has no such agent (deleted, or a different account's key). */
  snapshot(agentId: string): Promise<AgentSnapshot | undefined>;
}

interface SdkRun {
  readonly status: AgentState;
  readonly error?: { message: string; code?: string };
  readonly git?: { branches: { repoUrl: string; branch?: string; prUrl?: string }[] };
  /** Epoch milliseconds. */
  readonly createdAt?: number;
  readonly durationMs?: number;
}

/** The slice of @cursor/sdk this file uses, so tests can pass a fake. */
export interface CursorRunsSdk {
  Agent: {
    listRuns(
      agentId: string,
      options: { runtime: "cloud"; apiKey: string; limit: number },
    ): Promise<{ items: SdkRun[] }>;
  };
}

const RUNS_TO_SCAN = 20;

export function createCursorReader(apiKey: string, loadSdk: () => Promise<CursorRunsSdk> = loadCursorSdk): AgentReader {
  return {
    async snapshot(agentId) {
      const { Agent } = await loadSdk();
      let runs: SdkRun[];
      try {
        runs = (await Agent.listRuns(agentId, { runtime: "cloud", apiKey, limit: RUNS_TO_SCAN })).items;
      } catch (err) {
        if ((err as Error).name === "AgentNotFoundError") return undefined;
        throw err;
      }
      const [newest] = runs;
      if (!newest) return undefined;

      // Runs come newest first. Later runs can lack git info the first one had, so take the newest that has it.
      const branches = runs.flatMap((run) => run.git?.branches ?? []);
      const branch = branches.find((b) => b.branch)?.branch;
      const prUrl = branches.find((b) => b.prUrl)?.prUrl;
      const error = newest.status === "error" && newest.error ? describeRunError(newest.error) : undefined;
      const ended = newest.status !== "running" && newest.createdAt !== undefined && newest.durationMs !== undefined;
      return {
        state: newest.status,
        ...(error && { error }),
        ...(branch && { branch }),
        ...(prUrl && { prUrl }),
        ...(ended && { finishedAt: new Date(newest.createdAt! + newest.durationMs!) }),
      };
    },
  };
}

function describeRunError({ message, code }: { message: string; code?: string }): string {
  return code && !message.includes(code) ? `${message} [${code}]` : message;
}

async function loadCursorSdk(): Promise<CursorRunsSdk> {
  const sdk: CursorRunsSdk = await import("@cursor/sdk");
  return sdk;
}
