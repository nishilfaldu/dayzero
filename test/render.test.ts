import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError } from "../src/config.js";
import { checkTemplate, loadTemplate, renderAll, renderPrompt, reproFor } from "../src/render.js";
import { TICKET_TYPES } from "../src/types.js";
import { DEFAULT_REPRO, FEATURE_REPRO, PERF_REPRO, SEEDED, config, ticket } from "./fixtures.js";

const template = await loadTemplate();
const repo = "nishilfaldu/epic-stack";
const inputs = { repo, repro: DEFAULT_REPRO, evidence: ["x"] };

describe("renderPrompt with prompts/ticket.md", () => {
  it("renders the exact prompt for a bug ticket", () => {
    const prompt = renderPrompt(template, ticket(), { ...inputs, evidence: ["decision log", "failing test on main"] });
    expect(prompt).toBe(
      [
        "/poteto-mode bug: Login fails. Login returns 500 for valid users.",
        "repro it on main first; if it doesn't repro, stop and say so.",
        "done means valid users can log in. the pr shows decision log; failing test on main.",
        "fresh branch off main on nishilfaldu/epic-stack. don't touch existing tests unless the ticket needs it, and say why.",
        "keep a decision log and commit it. don't ask me before committing or opening the pr.",
        "if you're truly stuck, stop and write up why.",
      ].join("\n"),
    );
  });

  it("puts the given repro line where {repro} is", () => {
    const prompt = renderPrompt(template, ticket(), { ...inputs, repro: "do the thing first." });
    expect(prompt.split("\n")[1]).toBe("do the thing first.");
  });

  it("collapses line breaks in ticket text so the command stays on one line", () => {
    const prompt = renderPrompt(template, ticket({ description: "first line\nsecond line\n\n  third" }), inputs);
    expect(prompt.split("\n")[0]).toBe("/poteto-mode bug: Login fails. first line second line third");
  });

  it("does not expand placeholders that appear inside ticket text", () => {
    const prompt = renderPrompt(template, ticket({ title: "Rename {repo} label" }), inputs);
    expect(prompt).toContain("Rename {repo} label.");
  });
});

describe("reproFor", () => {
  it("uses the type's override when there is one", () => {
    expect(reproFor(ticket({ type: "feature" }), config)).toBe(FEATURE_REPRO);
    expect(reproFor(ticket({ type: "perf" }), config)).toBe(PERF_REPRO);
  });

  it.each(TICKET_TYPES.filter((t) => t !== "feature" && t !== "perf"))(
    "falls back to the default for %s tickets",
    (type) => {
      expect(reproFor(ticket({ type }), config)).toBe(DEFAULT_REPRO);
    },
  );

  it("uses the default for every type when there are no overrides", () => {
    const noOverrides = { ...config, repro: { default: "only line.", overrides: {} } };
    for (const type of TICKET_TYPES) expect(reproFor(ticket({ type }), noOverrides)).toBe("only line.");
  });
});

describe("renderAll", () => {
  it("gives each ticket its type's repro line", () => {
    const tickets = TICKET_TYPES.map((type) => ticket({ id: type, type }));
    const lines = renderAll(template, { repo, tickets }, config).map((r) => [r.ticket.type, r.prompt.split("\n")[1]]);
    expect(Object.fromEntries(lines)).toEqual({
      feature: FEATURE_REPRO,
      bug: DEFAULT_REPRO,
      concurrency: DEFAULT_REPRO,
      perf: PERF_REPRO,
      migration: DEFAULT_REPRO,
      security: DEFAULT_REPRO,
    });
  });

  it("merges evidence per ticket", () => {
    const [rendered] = renderAll(
      template,
      { repo, tickets: [ticket({ type: "security", evidence: ["exploit rejected"] })] },
      config,
    );
    expect(rendered!.prompt).toContain("the pr shows decision log; test output; failing test on main; exploit rejected.");
  });

  it.each(TICKET_TYPES)("never includes seeded for %s tickets", (type) => {
    for (const seeded of [SEEDED, true]) {
      const [rendered] = renderAll(template, { repo, tickets: [ticket({ type, seeded })] }, config);
      expect(rendered!.prompt).not.toContain(SEEDED);
      expect(rendered!.prompt).not.toMatch(/seeded/i);
    }
  });

  it("fails naming the ticket id and field when a ticket ends up with no evidence", () => {
    const empty = { ...config, evidence: { always: [], by_type: {} } };
    expect(() => renderAll(template, { repo, tickets: [ticket({ id: "lonely" })] }, empty)).toThrow(
      /ticket "lonely": field "evidence"/,
    );
  });
});

describe("checkTemplate", () => {
  it("accepts prompts/ticket.md", () => {
    expect(checkTemplate(template)).toEqual([]);
  });

  it("rejects unknown placeholders, including {seeded}", () => {
    expect(checkTemplate(`${template}\nnote: {seeded}`)).toEqual([
      expect.stringContaining("unknown placeholder {seeded}"),
    ]);
  });

  it("rejects a template without {repro}", () => {
    const edited = template.replace("{repro}", "repro it on main first.");
    expect(checkTemplate(edited)).toEqual([expect.stringContaining("missing the {repro} placeholder")]);
  });

  it("is enforced by loadTemplate", async () => {
    const dir = await mkdtemp(join(tmpdir(), "proofline-"));
    await writeFile(join(dir, "ticket.md"), "hello {who}\n");
    await expect(loadTemplate(join(dir, "ticket.md"))).rejects.toBeInstanceOf(ConfigError);
  });
});
