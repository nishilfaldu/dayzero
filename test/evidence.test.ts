import { describe, expect, it } from "vitest";
import { mergeEvidence } from "../src/evidence.js";
import { config, ticket } from "./fixtures.js";

describe("mergeEvidence", () => {
  it("is always + by_type[type] + the ticket's own evidence, in that order", () => {
    expect(mergeEvidence(ticket({ type: "bug", evidence: ["screenshot"] }), config)).toEqual([
      "decision log",
      "test output",
      "failing test on main",
      "screenshot",
    ]);
  });

  it("drops duplicates across all three sources, keeping the first position", () => {
    const t = ticket({ type: "security", evidence: ["exploit rejected", "decision log", "new item", "new item"] });
    expect(mergeEvidence(t, config)).toEqual([
      "decision log",
      "test output",
      "failing test on main",
      "exploit rejected",
      "new item",
    ]);
  });

  it("treats items that differ only in surrounding whitespace as duplicates", () => {
    expect(mergeEvidence(ticket({ evidence: ["  decision log "] }), config)).toEqual([
      "decision log",
      "test output",
      "failing test on main",
    ]);
  });

  it("works for a type with no by_type entry and a ticket with no evidence", () => {
    expect(mergeEvidence(ticket({ type: "perf" }), config)).toEqual(["decision log", "test output"]);
  });
});
