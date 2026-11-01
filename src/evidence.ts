import type { DayzeroConfig, Ticket } from "./types.js";

/**
 * always + by_type[type] + the ticket's own evidence, in that order.
 * Duplicates (compared after trimming) keep their first position.
 */
export function mergeEvidence(ticket: Ticket, config: DayzeroConfig): string[] {
  const all = [
    ...config.evidence.always,
    ...(config.evidence.by_type[ticket.type] ?? []),
    ...(ticket.evidence ?? []),
  ];
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const item of all) {
    const key = item.trim();
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(key);
    }
  }
  return merged;
}
