import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ConfigError } from "./config.js";

export { INIT_ID } from "./types.js";

export const INIT_TEMPLATE_PATH = fileURLToPath(new URL("../prompts/init.md", import.meta.url));

const PLACEHOLDER_PATTERN = /\{([a-z_]+)\}/g;

export async function loadInitTemplate(path = INIT_TEMPLATE_PATH, label = "prompts/init.md"): Promise<string> {
  const template = await readFile(path, "utf8");
  const problems = checkInitTemplate(template, label);
  if (problems.length > 0) throw new ConfigError(problems);
  return template;
}

/** The init prompt only knows {repo}; anything else would reach the agent as literal braces. */
export function checkInitTemplate(template: string, label = "prompts/init.md"): string[] {
  return [...template.matchAll(PLACEHOLDER_PATTERN)]
    .filter(([, name]) => name !== "repo")
    .map(([match]) => `${label}: unknown placeholder ${match} (only {repo} is filled in)`);
}

export function renderInitPrompt(template: string, repo: string): string {
  return template.trimEnd().replace(PLACEHOLDER_PATTERN, (match, name: string) => (name === "repo" ? repo : match));
}
