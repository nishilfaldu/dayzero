import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";

export const API_KEY_VAR = "CURSOR_API_KEY";

export interface ApiKey {
  key: string;
  source: "environment" | ".env.local";
}

/** CURSOR_API_KEY from the environment, else from .env.local in `cwd`. Undefined if neither has one. */
export async function resolveApiKey(cwd: string, env: NodeJS.ProcessEnv): Promise<ApiKey | undefined> {
  const fromEnv = env[API_KEY_VAR]?.trim();
  if (fromEnv) return { key: fromEnv, source: "environment" };

  let text: string;
  try {
    text = await readFile(join(cwd, ".env.local"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
  const fromFile = parseEnv(text)[API_KEY_VAR]?.trim();
  return fromFile ? { key: fromFile, source: ".env.local" } : undefined;
}
