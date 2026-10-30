import { readFile } from "node:fs/promises";
import { parseDocument } from "yaml";
import {
  TICKET_TYPES,
  isTicketType,
  type ModelChoice,
  type ProoflineConfig,
  type Tasks,
  type Ticket,
} from "./types.js";

/** One or more problems with the user's files. Each problem is a full, self-contained message. */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join("\n"));
    this.name = "ConfigError";
  }
}

const TASKS_KEYS = ["repo", "tickets"];
const TICKET_KEYS = ["id", "type", "title", "description", "done", "evidence"];
const CONFIG_KEYS = ["model", "repro", "evidence"];
const MODEL_KEYS = ["id", "params"];
const EVIDENCE_KEYS = ["always", "by_type"];
const TYPE_LIST = TICKET_TYPES.join(", ");

export async function loadTasks(path: string, label = "tasks.yaml"): Promise<Tasks> {
  return validateTasks(await readYaml(path, label), label);
}

export async function loadConfig(path: string, label = "proofline.yaml"): Promise<ProoflineConfig> {
  return validateConfig(await readYaml(path, label), label);
}

export async function readYaml(path: string, label: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError([`${label}: file not found at ${path}`]);
    }
    throw err;
  }
  return parseYaml(text, label);
}

export function parseYaml(text: string, label: string): unknown {
  const doc = parseDocument(text);
  if (doc.errors.length > 0) {
    throw new ConfigError(doc.errors.map((e) => `${label}: invalid YAML: ${e.message}`));
  }
  return doc.toJS();
}

export function validateTasks(data: unknown, label = "tasks.yaml"): Tasks {
  const problems: string[] = [];
  const at = (field: string) => `${label}: field "${field}"`;

  if (!isRecord(data)) {
    throw new ConfigError([`${label}: expected a mapping with "repo" and "tickets" (got ${show(data)})`]);
  }
  unknownKeys(data, TASKS_KEYS, at, problems);

  const repo = text(data, "repo", at, problems);
  if (repo !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    problems.push(`${at("repo")} must look like "owner/name" (got ${show(repo)})`);
  }

  const tickets: Ticket[] = [];
  const raw = data.tickets;
  if (raw === undefined || raw === null) {
    problems.push(`${at("tickets")} is required`);
  } else if (!Array.isArray(raw)) {
    problems.push(`${at("tickets")} must be a list (got ${show(raw)})`);
  } else if (raw.length === 0) {
    problems.push(`${at("tickets")} must have at least one ticket`);
  } else {
    raw.forEach((item, i) => {
      const ticket = validateTicket(item, i, label, problems);
      if (ticket) tickets.push(ticket);
    });
    duplicateIds(raw, label, problems);
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { repo: repo!, tickets };
}

function validateTicket(item: unknown, index: number, label: string, problems: string[]): Ticket | undefined {
  // Name the ticket by its id when it has a usable one, otherwise by position.
  const id = isRecord(item) && typeof item.id === "string" && item.id.trim() ? item.id : undefined;
  const who = id !== undefined ? `ticket "${id}"` : `ticket #${index + 1}`;
  const at = (field: string) => `${label}: ${who}: field "${field}"`;

  if (!isRecord(item)) {
    problems.push(`${label}: ${who} must be a mapping (got ${show(item)})`);
    return undefined;
  }
  const before = problems.length;
  unknownKeys(item, TICKET_KEYS, at, problems);

  text(item, "id", at, problems);
  const type = item.type;
  if (type === undefined || type === null) {
    problems.push(`${at("type")} is required`);
  } else if (!isTicketType(type)) {
    problems.push(`${at("type")} must be one of ${TYPE_LIST} (got ${show(type)})`);
  }
  const title = text(item, "title", at, problems);
  const description = text(item, "description", at, problems);
  const done = text(item, "done", at, problems);
  const evidence = item.evidence === undefined ? undefined : textList(item.evidence, "evidence", at, problems);

  if (problems.length > before) return undefined;
  return {
    id: id!,
    type: type as Ticket["type"],
    title: title!,
    description: description!,
    done: done!,
    ...(evidence !== undefined && { evidence }),
  };
}

function duplicateIds(raw: unknown[], label: string, problems: string[]): void {
  const positions = new Map<string, number[]>();
  raw.forEach((item, i) => {
    if (isRecord(item) && typeof item.id === "string" && item.id.trim()) {
      positions.set(item.id, [...(positions.get(item.id) ?? []), i + 1]);
    }
  });
  for (const [id, at] of positions) {
    if (at.length > 1) {
      problems.push(`${label}: ticket "${id}": field "id" is used by more than one ticket (#${at.join(", #")})`);
    }
  }
}

export function validateConfig(data: unknown, label = "proofline.yaml"): ProoflineConfig {
  const problems: string[] = [];
  const at = (field: string) => `${label}: field "${field}"`;

  if (!isRecord(data)) {
    throw new ConfigError([`${label}: expected a mapping with "repro" and "evidence" keys (got ${show(data)})`]);
  }
  unknownKeys(data, CONFIG_KEYS, at, problems);

  const config: ProoflineConfig = {
    evidence: { always: [], by_type: {} },
    repro: { default: "", overrides: {} },
  };

  // model: either a model id, or { id, params } where params maps knob -> value.
  const model = data.model;
  if (typeof model === "string") {
    if (model.trim()) config.model = { id: model.trim(), params: [] };
    else problems.push(`${at("model")} must not be empty`);
  } else if (isRecord(model)) {
    const modelAt = (field: string) => at(`model.${field}`);
    unknownKeys(model, MODEL_KEYS, modelAt, problems);
    const id = text(model, "id", modelAt, problems);
    const params: ModelChoice["params"] = [];
    if (model.params !== undefined && !isRecord(model.params)) {
      problems.push(`${modelAt("params")} must be a mapping of parameter to value (got ${show(model.params)})`);
    } else {
      for (const [param, value] of Object.entries(model.params ?? {})) {
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
          params.push({ id: param, value: String(value) });
        } else {
          problems.push(`${modelAt(`params.${param}`)} must be a string, number or true/false (got ${show(value)})`);
        }
      }
    }
    if (id !== undefined) config.model = { id: id.trim(), params };
  } else if (model !== undefined) {
    problems.push(`${at("model")} must be a model id or a mapping with "id" and "params" (got ${show(model)})`);
  }

  // repro: a required `default` line plus optional overrides keyed by ticket type.
  const repro = data.repro;
  if (repro === undefined || repro === null) {
    problems.push(`${at("repro")} is required (a mapping with at least a "default" line)`);
  } else if (!isRecord(repro)) {
    problems.push(`${at("repro")} must be a mapping with a "default" line (got ${show(repro)})`);
  } else {
    const reproAt = (field: string) => at(`repro.${field}`);
    config.repro.default = text(repro, "default", reproAt, problems) ?? "";
    for (const type of Object.keys(repro)) {
      if (type === "default") continue;
      if (!isTicketType(type)) {
        problems.push(`${reproAt(type)} is not a ticket type (expected "default" or one of ${TYPE_LIST})`);
        continue;
      }
      const line = text(repro, type, reproAt, problems);
      if (line !== undefined) config.repro.overrides[type] = line;
    }
  }

  const evidence = data.evidence;
  if (evidence === undefined || evidence === null) {
    problems.push(`${at("evidence")} is required`);
  } else if (!isRecord(evidence)) {
    problems.push(`${at("evidence")} must be a mapping with "always" and "by_type" (got ${show(evidence)})`);
  } else {
    unknownKeys(evidence, EVIDENCE_KEYS, (f) => at(`evidence.${f}`), problems);

    if (evidence.always !== undefined) {
      config.evidence.always = textList(evidence.always, "evidence.always", at, problems) ?? [];
    }

    const byType = evidence.by_type;
    if (byType !== undefined && !isRecord(byType)) {
      problems.push(`${at("evidence.by_type")} must be a mapping of ticket type to list (got ${show(byType)})`);
    } else if (byType !== undefined) {
      for (const [type, list] of Object.entries(byType)) {
        const field = `evidence.by_type.${type}`;
        if (!isTicketType(type)) {
          problems.push(`${at(field)} is not a ticket type (expected one of ${TYPE_LIST})`);
          continue;
        }
        const items = textList(list, field, at, problems);
        if (items) config.evidence.by_type[type] = items;
      }
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return config;
}

function text(
  obj: Record<string, unknown>,
  field: string,
  at: (field: string) => string,
  problems: string[],
): string | undefined {
  const value = obj[field];
  if (value === undefined || value === null) {
    problems.push(`${at(field)} is required`);
  } else if (typeof value !== "string") {
    problems.push(`${at(field)} must be a string (got ${show(value)})`);
  } else if (!value.trim()) {
    problems.push(`${at(field)} must not be empty`);
  } else {
    return value;
  }
  return undefined;
}

function textList(
  value: unknown,
  field: string,
  at: (field: string) => string,
  problems: string[],
): string[] | undefined {
  if (!Array.isArray(value)) {
    problems.push(`${at(field)} must be a list of strings (got ${show(value)})`);
    return undefined;
  }
  const before = problems.length;
  value.forEach((item, i) => {
    if (typeof item !== "string" || !item.trim()) {
      problems.push(`${at(`${field}[${i}]`)} must be a non-empty string (got ${show(item)})`);
    }
  });
  return problems.length > before ? undefined : (value as string[]);
}

function unknownKeys(
  obj: Record<string, unknown>,
  allowed: string[],
  at: (field: string) => string,
  problems: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) {
      problems.push(`${at(key)} is not recognised (expected one of ${allowed.join(", ")})`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function show(value: unknown): string {
  const s = value === undefined ? "nothing" : JSON.stringify(value);
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}
