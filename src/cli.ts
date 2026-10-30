import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type AgentReader, createCursorReader } from "./agents.js";
import { ConfigError, loadConfig, loadTasks } from "./config.js";
import { API_KEY_VAR, resolveApiKey } from "./env.js";
import {
  type GitHub,
  GitHubAuthError,
  LOGIN_HINT,
  createGitHubClient,
  resolveGitHubToken,
  runGhAuthToken,
} from "./github.js";
import { launchTickets, selectTickets } from "./launch.js";
import { type Launcher, createCursorLauncher } from "./launcher.js";
import { loadTemplate, renderAll, type RenderedPrompt } from "./render.js";
import { type RunState, STATE_PATH, readState, writeState } from "./state.js";
import { PR_GRACE_MS, type TicketStatus, applyPrGrace, checkLaunch, latestLaunches, recordedType } from "./status.js";
import type { ProoflineConfig, Tasks } from "./types.js";

export const WATCH_INTERVAL_MS = 60_000;

export const USAGE = `usage: proofline run [--dry-run] [--only <id>]... [--force] [--tasks <file>] [--config <file>]
       proofline status [--watch] [--tasks <file>]

run      Reads tasks.yaml and proofline.yaml, validates them, and starts one Cursor
         cloud agent per ticket on the tasks.yaml repo, from main. Launches are
         recorded in ${STATE_PATH}; tickets already recorded there are skipped.
status   For each ticket's latest launch, shows the agent's state and its PR. Once
         the PR is on GitHub, labels it, adds the prompt to its description, and
         comments if it changes existing test files. Safe to run repeatedly.

options:
  --dry-run         print each ticket's exact prompt; launch nothing, need no API key
  --only <id>       launch just this ticket, even if it was launched before (repeatable)
  --force           relaunch every ticket, including ones already launched
  --watch           status: re-check every ${WATCH_INTERVAL_MS / 1000}s until no agent is running and each
                    finished one has a PR or finished ${PR_GRACE_MS / 60_000}+ min ago
  --tasks <file>    tickets file (default: tasks.yaml)
  --config <file>   model, repro and evidence config (default: proofline.yaml)
  -h, --help        show this help

${API_KEY_VAR} is read from the environment, or else from .env.local.
status gets its GitHub token from \`gh auth token\`.`;

export interface Io {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  createLauncher: (apiKey: string) => Launcher;
  createAgentReader: (apiKey: string) => AgentReader;
  createGitHub: (token: string) => GitHub;
  ghAuthToken: () => Promise<string | undefined>;
  now: () => Date;
  sleep: (ms: number) => Promise<void>;
}

export const processIo: Io = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  createLauncher: (apiKey) => createCursorLauncher(apiKey),
  createAgentReader: (apiKey) => createCursorReader(apiKey),
  createGitHub: (token) => createGitHubClient(token),
  ghAuthToken: () => runGhAuthToken(),
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Runs the CLI and returns the exit code: 0 ok, 1 invalid input or a failed launch or lookup, 2 bad usage. */
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
  const command = positionals.length === 1 ? positionals[0] : undefined;
  if (command === "status") {
    const runOnly = (["dry-run", "only", "force", "config"] as const).filter((flag) => values[flag] !== undefined);
    if (runOnly.length > 0) {
      io.stderr(`error: ${runOnly.map((f) => `--${f}`).join(", ")} only applies to \`proofline run\`\n\n${USAGE}\n`);
      return 2;
    }
    return status(values.tasks ?? "tasks.yaml", values.watch ?? false, io);
  }
  if (command !== "run") {
    io.stderr(`${USAGE}\n`);
    return 2;
  }
  if (values.watch) {
    io.stderr(`error: --watch only applies to \`proofline status\`\n\n${USAGE}\n`);
    return 2;
  }

  const tasksLabel = values.tasks ?? "tasks.yaml";
  const configLabel = values.config ?? "proofline.yaml";
  let inputs: { tasks: Tasks; config: ProoflineConfig };
  let prompts: RenderedPrompt[];
  try {
    const loaded = await loadInputs(io.cwd, tasksLabel, configLabel);
    inputs = loaded;
    prompts = renderAll(loaded.template, loaded.tasks, loaded.config, tasksLabel);
  } catch (err) {
    return reportConfigError(err, io);
  }

  const only = values.only ?? [];
  const unknown = only.filter((id) => !prompts.some((p) => p.ticket.id === id));
  if (unknown.length > 0) {
    io.stderr(unknown.map((id) => `error: --only: no ticket with id "${id}" in ${tasksLabel}\n`).join(""));
    return 2;
  }

  if (values["dry-run"]) {
    const shown = only.length > 0 ? prompts.filter((p) => only.includes(p.ticket.id)) : prompts;
    io.stdout(shown.map(({ ticket, prompt }) => `===== ${ticket.id} (${ticket.type}) =====\n${prompt}\n`).join("\n"));
    io.stderr(`\ndry run: ${shown.length} prompt(s) for ${inputs.tasks.repo}; nothing was launched\n`);
    return 0;
  }

  return launch(prompts, inputs, { only, force: values.force ?? false }, io);
}

async function launch(
  prompts: RenderedPrompt[],
  { tasks, config }: { tasks: Tasks; config: ProoflineConfig },
  flags: { only: string[]; force: boolean },
  io: Io,
): Promise<number> {
  let state: RunState;
  try {
    state = await readState(io.cwd);
  } catch (err) {
    return reportConfigError(err, io);
  }

  const { toLaunch, skipped } = selectTickets(prompts, state, flags);
  const skippedLine =
    skipped.length > 0
      ? `skipped ${skipped.length} already launched (relaunch with --only <id> or --force): ${skipped.map((p) => p.ticket.id).join(", ")}\n`
      : "";
  if (toLaunch.length === 0) {
    io.stdout(`nothing to launch.\n${skippedLine}`);
    return 0;
  }

  const apiKey = await resolveApiKey(io.cwd, io.env);
  if (!apiKey) {
    io.stderr(`error: ${API_KEY_VAR} is not set in the environment or in .env.local; nothing was launched\n`);
    return 1;
  }

  const model = config.model ? config.model.id : "the SDK default model";
  io.stdout(`launching ${toLaunch.length} agent(s) on ${tasks.repo} from main with ${model}\n`);
  const outcome = await launchTickets(toLaunch, {
    repo: tasks.repo,
    model: config.model,
    state,
    launcher: io.createLauncher(apiKey.key),
    now: io.now,
    save: (next) => writeState(io.cwd, next),
    onLaunched: (r) => io.stdout(`  launched ${r.ticketId}: ${r.agentUrl}\n`),
    onFailed: (id, reason) => io.stdout(`  failed   ${id}: ${reason}\n`),
  });

  const summary = [
    `\nlaunched ${outcome.launched.length} of ${toLaunch.length}${outcome.launched.length > 0 ? `; recorded in ${STATE_PATH}` : ""}\n`,
    skippedLine,
    outcome.failed.length > 0
      ? `failed ${outcome.failed.length}:\n${outcome.failed.map((f) => `  ${f.ticketId}: ${f.reason}\n`).join("")}`
      : "",
  ];
  io.stdout(summary.join(""));
  return outcome.failed.length > 0 ? 1 : 0;
}

type StatusClients = { agents: AgentReader; github: GitHub };

/** Agent states that can still change, so --watch keeps going while any ticket has one. */
const NOT_DONE = new Set(["running", "lookup failed"]);

async function status(tasksLabel: string, watch: boolean, io: Io): Promise<number> {
  try {
    if ((await readState(io.cwd)).launches.length === 0) {
      io.stdout(`nothing launched yet (${STATE_PATH} has no launches); run \`proofline run\` first\n`);
      return 0;
    }
  } catch (err) {
    return reportConfigError(err, io);
  }

  const apiKey = await resolveApiKey(io.cwd, io.env);
  if (!apiKey) {
    io.stderr(`error: ${API_KEY_VAR} is not set in the environment or in .env.local\n`);
    return 1;
  }
  const token = await resolveGitHubToken(io.ghAuthToken);
  if (!token) {
    io.stderr(`error: no GitHub token: \`gh auth token\` gave none; ${LOGIN_HINT}\n`);
    return 1;
  }
  const clients: StatusClients = { agents: io.createAgentReader(apiKey.key), github: io.createGitHub(token) };
  const firstSeenFinished = new Map<string, number>();

  for (let check = 1; ; check++) {
    let statuses: TicketStatus[];
    try {
      // Re-read every check, so --watch picks up launches made while it runs.
      statuses = await checkAll(await readState(io.cwd), tasksLabel, io.cwd, clients);
    } catch (err) {
      if (!(err instanceof GitHubAuthError)) return reportConfigError(err, io);
      io.stderr(`error: ${err.message}; ${LOGIN_HINT}\n`);
      return 1;
    }

    const now = io.now();
    const awaitingPr = watch ? applyPrGrace(statuses, now, firstSeenFinished) : [];
    if (watch) io.stdout(`${check > 1 ? "\n" : ""}[${now.toISOString()}] check ${check}\n`);
    io.stdout(table([["TICKET", "TYPE", "AGENT", "PR"], ...statuses.map((s) => [s.ticketId, s.type, s.agent, s.pr])]));
    const details = statuses.flatMap((s) => [...s.changes, ...s.notes].map((line) => `  ${s.ticketId}: ${line}\n`));
    if (details.length > 0) io.stdout(`\n${details.join("")}`);
    const problems = statuses.flatMap((s) => s.problems.map((p) => `error: ${s.ticketId}: ${p}\n`));
    if (problems.length > 0) io.stderr(`\n${problems.join("")}`);

    const running = statuses.filter((s) => NOT_DONE.has(s.agent)).map((s) => s.ticketId);
    if (!watch || running.length + awaitingPr.length === 0) {
      if (watch) io.stdout("\nnothing left to wait for; done watching\n");
      return problems.length > 0 ? 1 : 0;
    }
    const waitingOn = [
      ...(running.length > 0 ? [`still running: ${running.join(", ")}`] : []),
      ...(awaitingPr.length > 0 ? [`waiting for a PR: ${awaitingPr.join(", ")}`] : []),
    ];
    io.stdout(`\n${waitingOn.join("; ")}; checking again in ${WATCH_INTERVAL_MS / 1000}s\n`);
    await io.sleep(WATCH_INTERVAL_MS);
  }
}

/** Uses each launch's recorded type; tasks.yaml is read only if an older record lacks one. */
async function checkAll(
  state: RunState,
  tasksLabel: string,
  cwd: string,
  clients: StatusClients,
): Promise<TicketStatus[]> {
  const launches = latestLaunches(state);
  const fallback = launches.some((l) => !recordedType(l))
    ? new Map((await loadTasks(resolve(cwd, tasksLabel), tasksLabel)).tickets.map((t) => [t.id, t.type]))
    : undefined;
  const statuses: TicketStatus[] = [];
  for (const launch of launches) {
    statuses.push(await checkLaunch(launch, recordedType(launch) ?? fallback?.get(launch.ticketId), clients));
  }
  return statuses;
}

/** Left-aligned columns, two spaces apart; the last column isn't padded. */
function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, col) => Math.max(...rows.map((row) => row[col]!.length)));
  return rows
    .map((row) => row.map((cell, col) => (col === row.length - 1 ? cell : cell.padEnd(widths[col]!))).join("  "))
    .join("\n")
    .concat("\n");
}

function reportConfigError(err: unknown, io: Io): number {
  if (!(err instanceof ConfigError)) throw err;
  io.stderr(err.problems.map((p) => `error: ${p}\n`).join(""));
  return 1;
}

function parseCliArgs(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      "dry-run": { type: "boolean" },
      only: { type: "string", multiple: true },
      force: { type: "boolean" },
      watch: { type: "boolean" },
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
