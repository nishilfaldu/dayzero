export const TICKET_TYPES = ["feature", "bug", "concurrency", "perf", "migration", "security"] as const;

export type TicketType = (typeof TICKET_TYPES)[number];

export interface Ticket {
  id: string;
  type: TicketType;
  title: string;
  description: string;
  done: string;
  /** How the bug was planted, for later verification. Never shown to the agent. */
  seeded?: string | boolean;
  evidence?: string[];
}

export interface Tasks {
  repo: string;
  tickets: Ticket[];
}

export interface ProoflineConfig {
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
