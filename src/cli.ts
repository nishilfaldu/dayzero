import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigError, loadConfig, loadTasks } from "./config.js";
import { loadTemplate, renderAll, type RenderedPrompt } from "./render.js";
import type { ProoflineConfig, Tasks } from "./types.js";

export const USAGE = `usage: proofline run --dry-run [--tasks <file>] [--config <file>]

Reads tasks.yaml and proofline.yaml, validates them, and prints the exact
prompt each ticket's cloud agent would get. Nothing is sent to Cursor or GitHub.

options:
  --dry-run         print the prompts instead of launching agents (required for now)
  --tasks <file>    tickets file (default: tasks.yaml)
  --config <file>   evidence config (default: proofline.yaml)
  -h, --help        show this help`;

export interface Io {
  cwd: string;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const processIo: Io = {
  cwd: process.cwd(),
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

/** Runs the CLI and returns the exit code: 0 ok, 1 invalid input, 2 bad usage. */
export async function main(argv: string[], io: Io = processIo): Promise<number> {
  let args: ReturnType<typeof parseCliArgs>;
  try {
    args = parseCliArgs(argv);
  } catch (err) {
    io.stderr(`error: ${(err as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = args;

  if (values.help) {
    io.stdout(`${USAGE}\n`);
    return 0;
  }
  if (positionals.length !== 1 || positionals[0] !== "run") {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  if (!values["dry-run"]) {
    io.stderr("error: only `proofline run --dry-run` works so far; launching agents comes in a later part\n");
    return 2;
  }

  const tasksLabel = values.tasks ?? "tasks.yaml";
  const configLabel = values.config ?? "proofline.yaml";
  let tasks: Tasks;
  let prompts: RenderedPrompt[];
  try {
    const inputs = await loadInputs(io.cwd, tasksLabel, configLabel);
    tasks = inputs.tasks;
    prompts = renderAll(inputs.template, inputs.tasks, inputs.config, tasksLabel);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    io.stderr(err.problems.map((p) => `error: ${p}\n`).join(""));
    return 1;
  }

  io.stdout(prompts.map(({ ticket, prompt }) => `===== ${ticket.id} (${ticket.type}) =====\n${prompt}\n`).join("\n"));
  io.stderr(`\ndry run: ${prompts.length} prompt(s) for ${tasks.repo}; nothing was launched\n`);
  return 0;
}

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      tasks: { type: "string" },
      config: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
  });
}

/** Loads all three inputs before failing, so one run reports every problem. */
async function loadInputs(
  cwd: string,
  tasksLabel: string,
  configLabel: string,
): Promise<{ tasks: Tasks; config: ProoflineConfig; template: string }> {
  const [tasks, config, template] = await Promise.allSettled([
    loadTasks(resolve(cwd, tasksLabel), tasksLabel),
    loadConfig(resolve(cwd, configLabel), configLabel),
    loadTemplate(),
  ]);
  if (tasks.status === "fulfilled" && config.status === "fulfilled" && template.status === "fulfilled") {
    return { tasks: tasks.value, config: config.value, template: template.value };
  }
  const problems = [tasks, config, template].flatMap((result) => {
    if (result.status === "fulfilled") return [];
    if (result.reason instanceof ConfigError) return result.reason.problems;
    throw result.reason;
  });
  throw new ConfigError(problems);
}
