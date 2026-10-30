import type { ModelChoice } from "./types.js";

export interface LaunchRequest {
  /** owner/name on GitHub. */
  repo: string;
  /** Branch the agent starts from. */
  startingRef: string;
  prompt: string;
  model?: ModelChoice;
}

export interface LaunchedAgent {
  agentId: string;
  runId: string;
  agentUrl: string;
}

/** Starts one cloud agent and returns once its first run is accepted, without waiting for it to finish. */
export interface Launcher {
  launch(request: LaunchRequest): Promise<LaunchedAgent>;
}

/** The slice of @cursor/sdk this file uses, so tests can pass a fake. */
export interface CursorSdk {
  Agent: {
    create(options: {
      apiKey: string;
      model?: { id: string; params?: { id: string; value: string }[] };
      cloud: { repos: { url: string; startingRef: string }[]; autoCreatePR: boolean };
    }): Promise<{
      readonly agentId: string;
      send(message: string): Promise<{ readonly id: string }>;
      close(): void;
    }>;
  };
}

export function agentUrl(agentId: string): string {
  return `https://cursor.com/agents/${agentId}`;
}

export function createCursorLauncher(apiKey: string, loadSdk: () => Promise<CursorSdk> = loadCursorSdk): Launcher {
  return {
    async launch({ repo, startingRef, prompt, model }) {
      const { Agent } = await loadSdk();
      const agent = await Agent.create({
        apiKey,
        ...(model && { model: { id: model.id, ...(model.params.length > 0 && { params: model.params }) } }),
        cloud: {
          repos: [{ url: `https://github.com/${repo}`, startingRef }],
          autoCreatePR: true,
        },
      });
      try {
        // The cloud agent only exists server-side once send() succeeds.
        const run = await agent.send(prompt);
        return { agentId: agent.agentId, runId: run.id, agentUrl: agentUrl(agent.agentId) };
      } finally {
        // Stops our local event stream only; the cloud run keeps going.
        agent.close();
      }
    },
  };
}

/** Loaded on first launch so --dry-run never pulls in the SDK. */
async function loadCursorSdk(): Promise<CursorSdk> {
  const sdk: CursorSdk = await import("@cursor/sdk");
  return sdk;
}
