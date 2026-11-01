import type { DayzeroConfig, Ticket } from "../src/types.js";

export function ticket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: "t-1",
    type: "bug",
    title: "Login fails",
    description: "Login returns 500 for valid users.",
    done: "valid users can log in",
    ...overrides,
  };
}

export const DEFAULT_REPRO = "repro it on main first; if it doesn't repro, stop and say so.";
export const FEATURE_REPRO = "write the failing e2e test first.";
export const PERF_REPRO = "benchmark main first.";

export const config: DayzeroConfig = {
  repro: {
    default: DEFAULT_REPRO,
    overrides: { feature: FEATURE_REPRO, perf: PERF_REPRO },
  },
  evidence: {
    always: ["decision log", "test output"],
    by_type: {
      bug: ["failing test on main"],
      security: ["failing test on main", "exploit rejected"],
      feature: ["e2e test"],
    },
  },
};
