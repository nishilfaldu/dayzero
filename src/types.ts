export const TICKET_TYPES = ["feature", "bug", "concurrency", "perf", "migration", "security"] as const;

export type TicketType = (typeof TICKET_TYPES)[number];

/** The run.json id of the `proofline init` launch, and its row in `status`. Reserved: no ticket can use it. */
export const INIT_ID = "init";

export interface Ticket {
  id: string;
  type: TicketType;
  title: string;
  description: string;
  done: string;
  evidence?: string[];
}

export interface Tasks {
  repo: string;
  tickets: Ticket[];
}

/** A Cursor model selection; params are model-specific knobs such as `effort: low`. */
export interface ModelChoice {
  id: string;
  params: { id: string; value: string }[];
}

export interface ProoflineConfig {
  /** Omitted means the SDK's server-side default model. */
  model?: ModelChoice;
  evidence: {
    always: string[];
    by_type: Partial<Record<TicketType, string[]>>;
  };
  repro: {
    default: string;
    overrides: Partial<Record<TicketType, string>>;
  };
}

export function isTicketType(value: unknown): value is TicketType {
  return (TICKET_TYPES as readonly unknown[]).includes(value);
}
