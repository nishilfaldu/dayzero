import { describe, expect, it } from "vitest";
import { ConfigError, parseYaml, validateConfig, validateTasks } from "../src/config.js";

function problemsOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (err) {
    if (err instanceof ConfigError) return err.problems;
    throw err;
  }
  throw new Error("expected a ConfigError");
}

const validTicket = {
  id: "sec-1",
  type: "security",
  title: "IDOR on notes",
  description: "Anyone can edit any note.",
  done: "editing someone else's note returns 403",
};

function tasksWith(...tickets: unknown[]) {
  return { repo: "nishilfaldu/epic-stack", tickets };
}

describe("validateTasks", () => {
  it("accepts a valid file and keeps seeded and evidence", () => {
    const tasks = validateTasks(tasksWith({ ...validTicket, seeded: "removed check", evidence: ["video"] }));
    expect(tasks.tickets[0]).toEqual({ ...validTicket, seeded: "removed check", evidence: ["video"] });
  });

  it("names the ticket id and field for a bad type", () => {
    expect(problemsOf(() => validateTasks(tasksWith({ ...validTicket, type: "secuirty" })))).toEqual([
      'tasks.yaml: ticket "sec-1": field "type" must be one of feature, bug, concurrency, perf, migration, security (got "secuirty")',
    ]);
  });

  it.each(["title", "description", "done", "type"])("names the ticket id and field when %s is missing", (field) => {
    const { [field as keyof typeof validTicket]: _, ...rest } = validTicket;
    expect(problemsOf(() => validateTasks(tasksWith(rest)))).toEqual([
      `tasks.yaml: ticket "sec-1": field "${field}" is required`,
    ]);
  });

  it("names the ticket id and field for an empty or non-string value", () => {
    const problems = problemsOf(() => validateTasks(tasksWith({ ...validTicket, title: "  ", done: 42 })));
    expect(problems).toEqual([
      'tasks.yaml: ticket "sec-1": field "title" must not be empty',
      'tasks.yaml: ticket "sec-1": field "done" must be a string (got 42)',
    ]);
  });

  it("names the ticket id and the exact evidence item", () => {
    expect(problemsOf(() => validateTasks(tasksWith({ ...validTicket, evidence: ["ok", 3] })))).toEqual([
      'tasks.yaml: ticket "sec-1": field "evidence[1]" must be a non-empty string (got 3)',
    ]);
  });

  it("names the ticket id and field for an unknown key", () => {
    expect(problemsOf(() => validateTasks(tasksWith({ ...validTicket, evidance: ["x"] })))).toEqual([
      expect.stringMatching(/^tasks\.yaml: ticket "sec-1": field "evidance" is not recognised/),
    ]);
  });

  it("rejects a seeded value that is not a string or boolean", () => {
    expect(problemsOf(() => validateTasks(tasksWith({ ...validTicket, seeded: ["a"] })))).toEqual([
      'tasks.yaml: ticket "sec-1": field "seeded" must be a string or true/false (got ["a"])',
    ]);
  });

  it("falls back to the ticket's position when it has no usable id", () => {
    const { id: _, ...noId } = validTicket;
    expect(problemsOf(() => validateTasks(tasksWith(validTicket, noId)))).toEqual([
      'tasks.yaml: ticket #2: field "id" is required',
    ]);
  });

  it("rejects duplicate ids", () => {
    const problems = problemsOf(() => validateTasks(tasksWith(validTicket, { ...validTicket, type: "bug" })));
    expect(problems).toEqual(['tasks.yaml: ticket "sec-1": field "id" is used by more than one ticket (#1, #2)']);
  });

  it("reports every problem in one go", () => {
    const problems = problemsOf(() =>
      validateTasks({ repo: "not a repo", tickets: [{ ...validTicket, type: "x" }, { ...validTicket, id: "b", done: "" }] }),
    );
    expect(problems).toHaveLength(3);
    expect(problems[0]).toMatch(/field "repo" must look like "owner\/name"/);
  });

  it("requires a non-empty tickets list", () => {
    expect(problemsOf(() => validateTasks({ repo: "a/b", tickets: [] }))).toEqual([
      'tasks.yaml: field "tickets" must have at least one ticket',
    ]);
    expect(problemsOf(() => validateTasks({ repo: "a/b" }))).toEqual(['tasks.yaml: field "tickets" is required']);
  });
});

describe("validateConfig", () => {
  const repro = { default: "repro first." };

  it("accepts a valid file and defaults missing lists", () => {
    expect(validateConfig({ repro, evidence: { always: ["log"] } })).toEqual({
      repro: { default: "repro first.", overrides: {} },
      evidence: { always: ["log"], by_type: {} },
    });
  });

  it("names the field for an unknown ticket type in by_type", () => {
    expect(problemsOf(() => validateConfig({ repro, evidence: { by_type: { securty: ["x"] } } }))).toEqual([
      expect.stringMatching(/^proofline\.yaml: field "evidence\.by_type\.securty" is not a ticket type/),
    ]);
  });

  it("names the field for a non-list or bad item", () => {
    expect(problemsOf(() => validateConfig({ repro, evidence: { always: "log", by_type: { bug: [""] } } }))).toEqual([
      'proofline.yaml: field "evidence.always" must be a list of strings (got "log")',
      'proofline.yaml: field "evidence.by_type.bug[0]" must be a non-empty string (got "")',
    ]);
  });

  it("requires evidence", () => {
    expect(problemsOf(() => validateConfig({ repro }))).toEqual(['proofline.yaml: field "evidence" is required']);
  });
});

describe("validateConfig repro", () => {
  const evidence = { always: ["log"] };

  it("keeps the default and every per-type override", () => {
    const config = validateConfig({
      evidence,
      repro: { default: "repro first.", feature: "write the failing e2e test first.", perf: "benchmark first." },
    });
    expect(config.repro).toEqual({
      default: "repro first.",
      overrides: { feature: "write the failing e2e test first.", perf: "benchmark first." },
    });
  });

  it("requires the repro section", () => {
    expect(problemsOf(() => validateConfig({ evidence }))).toEqual([
      expect.stringMatching(/^proofline\.yaml: field "repro" is required/),
    ]);
  });

  it("requires a default line, even when there are overrides", () => {
    expect(problemsOf(() => validateConfig({ evidence, repro: { feature: "write the e2e test first." } }))).toEqual([
      'proofline.yaml: field "repro.default" is required',
    ]);
  });

  it("rejects an empty or non-string default", () => {
    expect(problemsOf(() => validateConfig({ evidence, repro: { default: " " } }))).toEqual([
      'proofline.yaml: field "repro.default" must not be empty',
    ]);
    expect(problemsOf(() => validateConfig({ evidence, repro: { default: ["a"] } }))).toEqual([
      'proofline.yaml: field "repro.default" must be a string (got ["a"])',
    ]);
  });

  it("rejects an override for a type that doesn't exist", () => {
    expect(problemsOf(() => validateConfig({ evidence, repro: { default: "d", feat: "x" } }))).toEqual([
      expect.stringMatching(/^proofline\.yaml: field "repro\.feat" is not a ticket type/),
    ]);
  });

  it("rejects an empty or non-string override", () => {
    expect(problemsOf(() => validateConfig({ evidence, repro: { default: "d", bug: "", perf: 3 } }))).toEqual([
      'proofline.yaml: field "repro.bug" must not be empty',
      'proofline.yaml: field "repro.perf" must be a string (got 3)',
    ]);
  });

  it("rejects a repro that isn't a mapping", () => {
    expect(problemsOf(() => validateConfig({ evidence, repro: "repro first." }))).toEqual([
      expect.stringMatching(/^proofline\.yaml: field "repro" must be a mapping/),
    ]);
  });
});

describe("parseYaml", () => {
  it("reports YAML syntax errors with the file name and position", () => {
    const problems = problemsOf(() => parseYaml("repo: a/b\ntickets:\n  - id: x\n   type: bug\n", "tasks.yaml"));
    expect(problems[0]).toMatch(/^tasks\.yaml: invalid YAML: .*line 4/);
  });

  it("rejects duplicate keys", () => {
    expect(problemsOf(() => parseYaml("repo: a/b\nrepo: c/d\n", "tasks.yaml"))[0]).toMatch(/unique/i);
  });
});
