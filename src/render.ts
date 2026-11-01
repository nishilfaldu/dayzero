import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./config.js";
import { mergeEvidence } from "./evidence.js";
import type { DayzeroConfig, Tasks, Ticket } from "./types.js";

export const DEFAULT_TEMPLATE_PATH = fileURLToPath(new URL("../prompts/ticket.md", import.meta.url));

const PLACEHOLDERS = ["type", "title", "description", "repro", "done", "evidence", "repo"] as const;
type Placeholder = (typeof PLACEHOLDERS)[number];
const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g;

export interface RenderedPrompt {
  ticket: Ticket;
  prompt: string;
}

export async function loadTemplate(path = DEFAULT_TEMPLATE_PATH, label = "prompts/ticket.md"): Promise<string> {
  const template = await readFile(path, "utf8");
  const problems = checkTemplate(template, label);
  if (problems.length > 0) throw new ConfigError(problems);
  return template;
}

export function checkTemplate(template: string, label = "prompts/ticket.md"): string[] {
  const problems: string[] = [];
  for (const [, name] of template.matchAll(PLACEHOLDER_PATTERN)) {
    if (!(PLACEHOLDERS as readonly string[]).includes(name!)) {
      problems.push(`${label}: unknown placeholder {${name}} (expected one of ${PLACEHOLDERS.map((p) => `{${p}}`).join(", ")})`);
    }
  }
  if (!template.includes("{repro}")) {
    problems.push(`${label}: missing the {repro} placeholder, so dayzero.yaml's repro lines would never be used`);
  }
  return problems;
}

/** The ticket type's override from dayzero.yaml if it has one, else the default. */
export function reproFor(ticket: Ticket, config: DayzeroConfig): string {
  return config.repro.overrides[ticket.type] ?? config.repro.default;
}

export interface PromptInputs {
  repo: string;
  repro: string;
  evidence: string[];
}

export function renderPrompt(template: string, ticket: Ticket, { repo, repro, evidence }: PromptInputs): string {
  const values: Record<Placeholder, string> = {
    type: ticket.type,
    title: flatten(ticket.title),
    description: flatten(ticket.description),
    repro: flatten(repro),
    done: flatten(ticket.done),
    evidence: evidence.map(flatten).join("; "),
    repo,
  };
  // One pass over the template only, so text inside ticket values is never treated as a placeholder.
  return template
    .trimEnd()
    .replace(PLACEHOLDER_PATTERN, (match, name: string) => (name in values ? values[name as Placeholder] : match));
}

export function renderAll(template: string, tasks: Tasks, config: DayzeroConfig, label = "tasks.yaml"): RenderedPrompt[] {
  const problems: string[] = [];
  const rendered: RenderedPrompt[] = [];
  for (const ticket of tasks.tickets) {
    const evidence = mergeEvidence(ticket, config);
    if (evidence.length === 0) {
      problems.push(
        `${label}: ticket "${ticket.id}": field "evidence" ends up empty; add it to the ticket or to evidence.always / evidence.by_type.${ticket.type} in dayzero.yaml`,
      );
      continue;
    }
    rendered.push({
      ticket,
      prompt: renderPrompt(template, ticket, { repo: tasks.repo, repro: reproFor(ticket, config), evidence }),
    });
  }
  if (problems.length > 0) throw new ConfigError(problems);
  return rendered;
}

/** Ticket text is free-form YAML; collapse line breaks so the /poteto-mode command stays on one line. */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
