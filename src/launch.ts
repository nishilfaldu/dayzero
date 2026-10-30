import type { Launcher } from "./launcher.js";
import type { RenderedPrompt } from "./render.js";
import { type LaunchRecord, type RunState, launchedTicketIds } from "./state.js";
import type { ModelChoice } from "./types.js";

export interface Selection {
  toLaunch: RenderedPrompt[];
  /** Already launched and not asked for again. */
  skipped: RenderedPrompt[];
}

/**
 * Without flags, launch only tickets with no recorded launch.
 * `only` names tickets to launch even if they already ran; `force` relaunches everything.
 */
export function selectTickets(
  prompts: RenderedPrompt[],
  state: RunState,
  { only, force }: { only: string[]; force: boolean },
): Selection {
  if (only.length > 0) {
    return { toLaunch: prompts.filter((p) => only.includes(p.ticket.id)), skipped: [] };
  }
  if (force) return { toLaunch: prompts, skipped: [] };
  const launched = launchedTicketIds(state);
  return {
    toLaunch: prompts.filter((p) => !launched.has(p.ticket.id)),
    skipped: prompts.filter((p) => launched.has(p.ticket.id)),
  };
}

export interface LaunchOutcome {
  launched: LaunchRecord[];
  failed: { ticketId: string; reason: string }[];
}

/**
 * Launches tickets one at a time. A failure is reported and the rest still launch.
 * Each success is saved before the next launch starts, so an interrupted run loses nothing.
 */
export async function launchTickets(
  prompts: RenderedPrompt[],
  options: {
    repo: string;
    model: ModelChoice | undefined;
    state: RunState;
    launcher: Launcher;
    now: () => Date;
    save: (state: RunState) => Promise<void>;
    onLaunched?: (record: LaunchRecord) => void;
    onFailed?: (ticketId: string, reason: string) => void;
  },
): Promise<LaunchOutcome> {
  const outcome: LaunchOutcome = { launched: [], failed: [] };
  let state = options.state;
  for (const { ticket, prompt } of prompts) {
    let record: LaunchRecord;
    try {
      const launchedAt = options.now().toISOString();
      const agent = await options.launcher.launch({
        repo: options.repo,
        startingRef: "main",
        prompt,
        ...(options.model && { model: options.model }),
      });
      record = {
        ticketId: ticket.id,
        type: ticket.type,
        agentId: agent.agentId,
        agentUrl: agent.agentUrl,
        runId: agent.runId,
        launchedAt,
        repo: options.repo,
        model: options.model?.id ?? null,
        prompt,
      };
    } catch (err) {
      const reason = describeError(err);
      outcome.failed.push({ ticketId: ticket.id, reason });
      options.onFailed?.(ticket.id, reason);
      continue;
    }
    state = { ...state, launches: [...state.launches, record] };
    await options.save(state);
    outcome.launched.push(record);
    options.onLaunched?.(record);
  }
  return outcome;
}

/** Codes the SDK attaches that add nothing to the message. */
const GENERIC_CODES = new Set(["error", "unknown"]);

/** "RateLimitError: balance used up [usage_limit_exceeded]" from an SDK error, or the message of anything else. */
export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const code = (err as { code?: unknown }).code;
  const name = err.name && err.name !== "Error" ? `${err.name}: ` : "";
  const informative = typeof code === "string" && code && !GENERIC_CODES.has(code) && !err.message.includes(code);
  const suffix = informative ? ` [${code}]` : "";
  return `${name}${err.message}${suffix}`;
}
