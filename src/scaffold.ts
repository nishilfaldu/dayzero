import { execFile } from "node:child_process";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const TEMPLATES_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
export const SCAFFOLD_FILES = ["tasks.yaml", "dayzero.yaml"] as const;
/** Written to the target folder's .gitignore: launch records and the API key never belong in a repo. */
export const IGNORED = [".dayzero/", ".env.local"];
export const REPO_PLACEHOLDER = "OWNER/REPO";

export interface ScaffoldResult {
  written: string[];
  kept: string[];
  ignored: string[];
  /** The origin remote's owner/name, when it is a GitHub URL. */
  repo?: string;
}

/** owner/name from a GitHub remote URL (ssh or https), else undefined. */
export function parseGitHubRemote(url: string): string | undefined {
  const match = url.trim().match(/github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

export async function originRepo(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", cwd, "remote", "get-url", "origin"], { timeout: 10_000 });
    return parseGitHubRemote(stdout);
  } catch {
    // Not a git checkout, or no origin: the user fills the repo in by hand.
    return undefined;
  }
}

/**
 * Writes starter tasks.yaml and dayzero.yaml into `cwd` and adds IGNORED to its .gitignore.
 * Existing files are kept unless `force`.
 */
export async function scaffold(
  cwd: string,
  force: boolean,
  detectRepo: (cwd: string) => Promise<string | undefined> = originRepo,
): Promise<ScaffoldResult> {
  const repo = await detectRepo(cwd);
  const written: string[] = [];
  const kept: string[] = [];
  for (const name of SCAFFOLD_FILES) {
    const target = join(cwd, name);
    if (!force && (await exists(target))) {
      kept.push(name);
      continue;
    }
    let text = await readFile(join(TEMPLATES_DIR, name), "utf8");
    if (repo) text = text.replace(REPO_PLACEHOLDER, repo);
    await writeFile(target, text);
    written.push(name);
  }
  const ignored = await addToGitignore(cwd, IGNORED);
  return { written, kept, ignored, ...(repo && { repo }) };
}

/** Appends the entries .gitignore doesn't list yet; returns the ones it added. */
async function addToGitignore(cwd: string, entries: string[]): Promise<string[]> {
  const path = join(cwd, ".gitignore");
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const present = new Set(text.split(/\r?\n/).map((line) => line.trim()));
  const missing = entries.filter((entry) => !present.has(entry) && !present.has(entry.replace(/\/$/, "")));
  if (missing.length === 0) return [];
  const separator = text === "" || text.endsWith("\n") ? "" : "\n";
  await writeFile(path, `${text}${separator}${missing.join("\n")}\n`);
  return missing;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
