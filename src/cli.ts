import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { type AgentReader, createCursorReader } from "./agents.js";
import { ConfigError, loadConfig, loadTasks } from "./config.js";
import { type DoctorDeps, processDoctorDeps, runChecks } from "./doctor.js";
import { API_KEY_VAR, resolveApiKey } from "./env.js";
import {
  type GitHub,
  GitHubAuthError,
  LOGIN_HINT,
  createGitHubClient,
  resolveGitHubToken,
  runGhAuthToken,
} from "./github.js";
import { INIT_ID, checkInitMerged, loadInitTemplate, renderInitPrompt } from "./init.js";
import { describeError, launchAgents, selectTickets, ticketItems } from "./launch.js";
import { type Launcher, createCursorLauncher } from "./launcher.js";
import { loadTemplate, renderAll, type RenderedPrompt } from "./render.js";
import { IGNORED, scaffold } from "./scaffold.js";
import { type RunState, STATE_PATH, initLaunches, readState, writeState } from "./state.js";
import {
  ERROR_GRACE_MS,
  PR_GRACE_MS,
  type TicketStatus,
  applyErrorGrace,
  applyPrGrace,
  checkLaunch,
  latestLaunches,
  recordedType,
} from "./status.js";
import type { DayzeroConfig, Tasks } from "./types.js";

export const WATCH_INTERVAL_MS = 60_000;

export const USAGE = `usage: dayzero new [--force]
       dayzero doctor [--tasks <file>] [--config <file>]
       dayzero init [--dry-run] [--force] [--tasks <file>] [--config <file>]
       dayzero run [--dry-run] [--only <id>]... [--force] [--skip-init-check] [--tasks <file>] [--config <file>]
       dayzero status [--watch] [--tasks <file>]

new      Writes starter tasks.yaml and dayzero.yaml here, with the repo taken from
         the git origin when it is on GitHub, and adds ${IGNORED.join(" and ")} to
         .gitignore. Keeps existing files unless --force.
doctor   Checks Node, both files, the GitHub token and repo, ${API_KEY_VAR}, and that
         Cursor can reach the repo. Exits 1 if anything fails.
init     Starts one cloud agent on the tasks.yaml repo, from main, with prompts/init.md:
         it sets the repo up (pstack, verification skills, AGENTS.md, cloud
         environment) in one PR. Recorded in ${STATE_PATH} as "${INIT_ID}"; refuses to
         launch a second one unless --force.
run      Reads tasks.yaml and dayzero.yaml, validates them, and starts one Cursor
         cloud agent per ticket on the tasks.yaml repo, from main. Launches are
         recorded in ${STATE_PATH}; tickets already recorded there are skipped.
         Refuses to launch until a recorded init's PR is merged into main, since
         agents start from main and would otherwise miss what init set up.
status   For each ticket's latest launch, and init's, shows the agent's state and its
         PR. Once the PR is on GitHub, labels it with the ticket type, adds the
         prompt to its description, and comments if it changes existing test files.
         Safe to run repeatedly.

options:
  --dry-run         print the exact prompt(s); launch nothing, need no API key
  --only <id>       run: launch just this ticket, even if it was launched before (repeatable)
  --force           run: relaunch every ticket; init: launch even if one is recorded;
                    new: overwrite existing tasks.yaml and dayzero.yaml
  --skip-init-check run: launch without checking that init's PR is merged into main
  --watch           status: re-check every ${WATCH_INTERVAL_MS / 1000}s until no agent is running, each
                    finished one has a PR or finished ${PR_GRACE_MS / 60_000}+ min ago, and each one
                    in error failed ${ERROR_GRACE_MS / 60_000}+ min ago (Cursor can resume a failed run)
  --tasks <file>    tickets file (default: tasks.yaml)
  --config <file>   model, repro and evidence config (default: dayzero.yaml)
  -h, --help        show this help

${API_KEY_VAR} is read from the environment, or else from .env.local.
run and status get their GitHub token from \`gh auth token\`.`;

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
  if (command === "new" || command === "doctor") {
    const allowed = command === "new" ? ["force"] : ["tasks", "config"];
    const extra = (["dry-run", "only", "force", "skip-init-check", "watch", "tasks", "config"] as const).filter(
      (flag) => values[flag] !== undefined && !allowed.includes(flag),
    );
    if (extra.length > 0) {
      io.stderr(`error: ${extra.map((f) => `--${f}`).join(", ")} doesn't apply to \`dayzero ${command}\`\n\n${USAGE}\n`);
      return 2;
    }
    if (command === "new") return newProject(values.force ?? false, io);
    return doctor(values.tasks ?? "tasks.yaml", values.config ?? "dayzero.yaml", io);
  }
  if (command === "status") {
    const runOnly = (["dry-run", "only", "force", "skip-init-check", "config"] as const).filter((flag) => values[flag] !== undefined);
    if (runOnly.length > 0) {
      io.stderr(`error: ${runOnly.map((f) => `--${f}`).join(", ")} only applies to \`dayzero run\`\n\n${USAGE}\n`);
      return 2;
    }
    return status(values.tasks ?? "tasks.yaml", values.watch ?? false, io);
  }
  if (command !== "run" && command !== "init") {
    const problem =
      positionals.length === 0
        ? ""
        : positionals.length > 1
          ? `error: expected one command, got ${positionals.length}: ${positionals.join(" ")}\n\n`
          : `error: unknown command "${positionals[0]}"\n\n`;
    io.stderr(`${problem}${USAGE}\n`);
    return 2;
  }
  const misplaced = [
    ...(values.watch ? ["--watch only applies to `dayzero status`"] : []),
    ...(command === "init" && values.only ? ["--only only applies to `dayzero run`"] : []),
    ...(command === "init" && values["skip-init-check"] ? ["--skip-init-check only applies to `dayzero run`"] : []),
  ];
  if (misplaced.length > 0) {
    io.stderr(`${misplaced.map((m) => `error: ${m}\n`).join("")}\n${USAGE}\n`);
    return 2;
  }

  const tasksLabel = values.tasks ?? "tasks.yaml";
  const configLabel = values.config ?? "dayzero.yaml";
  if (command === "init") {
    return init({ dryRun: values["dry-run"] ?? false, force: values.force ?? false }, tasksLabel, configLabel, io);
  }

  let inputs: { tasks: Tasks; config: DayzeroConfig };
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

  return launch(prompts, inputs, { only, force: values.force ?? false, skipInitCheck: values["skip-init-check"] ?? false }, io);
}

async function launch(
  prompts: RenderedPrompt[],
  { tasks, config }: { tasks: Tasks; config: DayzeroConfig },
  flags: { only: string[]; force: boolean; skipInitCheck: boolean },
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

  if (flags.skipInitCheck) {
    io.stderr("warning: --skip-init-check: not checking that init's PR is merged into main; agents may start without what init sets up\n");
  } else {
    const ready = await initReady(state, tasks.repo, apiKey.key, io);
    if (ready !== 0) return ready;
  }

  const model = config.model ? config.model.id : "the SDK default model";
  io.stdout(`launching ${toLaunch.length} agent(s) on ${tasks.repo} from main with ${model}\n`);
  const outcome = await launchAgents(ticketItems(toLaunch), {
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

/**
 * 0 when a recorded init's PR is merged into main; otherwise says why on stderr and returns 1.
 * Ticket agents start from main, so before that merge they'd miss pstack, the skills and AGENTS.md.
 */
async function initReady(state: RunState, repo: string, apiKey: string, io: Io): Promise<number> {
  const token = await resolveGitHubToken(io.ghAuthToken);
  if (!token) {
    io.stderr(`error: no GitHub token to check init's PR: \`gh auth token\` gave none; ${LOGIN_HINT}\nnothing was launched\n`);
    return 1;
  }
  let check: Awaited<ReturnType<typeof checkInitMerged>>;
  try {
    check = await checkInitMerged(state, repo, { agents: io.createAgentReader(apiKey), github: io.createGitHub(token) });
  } catch (err) {
    const reason = err instanceof GitHubAuthError ? `${err.message}; ${LOGIN_HINT}` : describeError(err);
    io.stderr(`error: couldn't check init's PR: ${reason}\nnothing was launched\n`);
    return 1;
  }
  if (!check.ready) {
    io.stderr(
      `error: ${check.reason}. Agents start from main, so they'd miss pstack, the verification skills, AGENTS.md and the environment setup until init's PR is merged there.\n` +
        "nothing was launched; run `dayzero init` if you haven't, merge its PR, then run again (or pass --skip-init-check to launch anyway)\n",
    );
    return 1;
  }
  io.stdout(`init is set up: ${check.pull.url} is merged into main\n`);
  return 0;
}

/** Launches the one setup agent, recorded as "init". Same repo, branch, model and recording as `run`. */
async function init(
  flags: { dryRun: boolean; force: boolean },
  tasksLabel: string,
  configLabel: string,
  io: Io,
): Promise<number> {
  let repo: string;
  let config: DayzeroConfig;
  let prompt: string;
  try {
    const loaded = await loadInputs(io.cwd, tasksLabel, configLabel, () => loadInitTemplate());
    repo = loaded.tasks.repo;
    config = loaded.config;
    prompt = renderInitPrompt(loaded.template, repo);
  } catch (err) {
    return reportConfigError(err, io);
  }

  if (flags.dryRun) {
    io.stdout(`===== ${INIT_ID} =====\n${prompt}\n`);
    io.stderr(`\ndry run: init prompt for ${repo}; nothing was launched\n`);
    return 0;
  }

  let state: RunState;
  try {
    state = await readState(io.cwd);
  } catch (err) {
    return reportConfigError(err, io);
  }
  const previous = initLaunches(state).at(-1);
  if (previous && !flags.force) {
    io.stderr(
      `error: init was already launched at ${previous.launchedAt}: ${previous.agentUrl}\nnothing was launched; run \`dayzero init --force\` to launch another\n`,
    );
    return 1;
  }

  const apiKey = await resolveApiKey(io.cwd, io.env);
  if (!apiKey) {
    io.stderr(`error: ${API_KEY_VAR} is not set in the environment or in .env.local; nothing was launched\n`);
    return 1;
  }

  const model = config.model ? config.model.id : "the SDK default model";
  io.stdout(`launching the init agent on ${repo} from main with ${model}\n`);
  const outcome = await launchAgents([{ id: INIT_ID, kind: "init", prompt }], {
    repo,
    model: config.model,
    state,
    launcher: io.createLauncher(apiKey.key),
    now: io.now,
    save: (next) => writeState(io.cwd, next),
    onLaunched: (r) => io.stdout(`  launched ${r.ticketId}: ${r.agentUrl}\n`),
    onFailed: (id, reason) => io.stdout(`  failed   ${id}: ${reason}\n`),
  });
  if (outcome.failed.length > 0) return 1;
  io.stdout(`\nrecorded in ${STATE_PATH}; follow it with \`dayzero status --watch\`\n`);
  return 0;
}

type StatusClients = { agents: AgentReader; github: GitHub };

/** Agent states that can still change, so --watch keeps going while any ticket has one. */
const NOT_DONE = new Set(["running", "lookup failed"]);

async function status(tasksLabel: string, watch: boolean, io: Io): Promise<number> {
  try {
    if ((await readState(io.cwd)).launches.length === 0) {
      io.stdout(`nothing launched yet (${STATE_PATH} has no launches); run \`dayzero run\` first\n`);
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
  const firstSeenFailed = new Map<string, number>();

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
    const mayResume = watch ? applyErrorGrace(statuses, now, firstSeenFailed) : [];
    if (watch) io.stdout(`${check > 1 ? "\n" : ""}[${now.toISOString()}] check ${check}\n`);
    io.stdout(table([["TICKET", "TYPE", "AGENT", "PR"], ...statuses.map((s) => [s.ticketId, s.type, s.agent, s.pr])]));
    const details = statuses.flatMap((s) => [...s.changes, ...s.notes].map((line) => `  ${s.ticketId}: ${line}\n`));
    if (details.length > 0) io.stdout(`\n${details.join("")}`);
    const problems = statuses.flatMap((s) => s.problems.map((p) => `error: ${s.ticketId}: ${p}\n`));
    if (problems.length > 0) io.stderr(`\n${problems.join("")}`);

    const running = statuses.filter((s) => NOT_DONE.has(s.agent)).map((s) => s.ticketId);
    if (!watch || running.length + awaitingPr.length + mayResume.length === 0) {
      if (watch) io.stdout("\nnothing left to wait for; done watching\n");
      return problems.length > 0 ? 1 : 0;
    }
    const waitingOn = [
      ...(running.length > 0 ? [`still running: ${running.join(", ")}`] : []),
      ...(awaitingPr.length > 0 ? [`waiting for a PR: ${awaitingPr.join(", ")}`] : []),
      ...(mayResume.length > 0 ? [`re-checking after an error: ${mayResume.join(", ")}`] : []),
    ];
    io.stdout(`\n${waitingOn.join("; ")}; checking again in ${WATCH_INTERVAL_MS / 1000}s\n`);
    await io.sleep(WATCH_INTERVAL_MS);
  }
}

/** Uses each launch's recorded type; tasks.yaml is read only if an older ticket record lacks one. */
async function checkAll(
  state: RunState,
  tasksLabel: string,
  cwd: string,
  clients: StatusClients,
): Promise<TicketStatus[]> {
  const launches = latestLaunches(state);
  const fallback = launches.some((l) => l.kind !== "init" && !recordedType(l))
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

async function newProject(force: boolean, io: Io, detectRepo?: (cwd: string) => Promise<string | undefined>): Promise<number> {
  const result = await scaffold(io.cwd, force, detectRepo);
  for (const name of result.written) io.stdout(`wrote ${name}\n`);
  for (const name of result.kept) io.stdout(`kept ${name} (already here; --force overwrites it)\n`);
  if (result.ignored.length > 0) io.stdout(`added ${result.ignored.join(", ")} to .gitignore\n`);
  if (result.written.includes("tasks.yaml")) {
    io.stdout(
      result.repo
        ? `repo: ${result.repo} (from git origin)\n`
        : `repo: set it in tasks.yaml; no GitHub origin was found here\n`,
    );
  }
  io.stdout(`next: write your tickets in tasks.yaml, add ${API_KEY_VAR} to .env.local, then run \`dayzero doctor\`\n`);
  return 0;
}

async function doctor(tasksLabel: string, configLabel: string, io: Io, deps: DoctorDeps = processDoctorDeps): Promise<number> {
  const checks = await runChecks(
    io.cwd,
    io.env,
    resolve(io.cwd, tasksLabel),
    tasksLabel,
    resolve(io.cwd, configLabel),
    configLabel,
    { ...deps, ghAuthToken: io.ghAuthToken },
  );
  for (const check of checks) {
    io.stdout(`${check.ok ? "ok  " : "FAIL"}  ${check.label}${check.fix ? `\n      ${check.fix}` : ""}\n`);
  }
  const failed = checks.filter((c) => !c.ok).length;
  io.stdout(failed === 0 ? "ready: run `dayzero init`\n" : `${failed} check(s) failed\n`);
  return failed === 0 ? 0 : 1;
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
      "skip-init-check": { type: "boolean" },
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
  loadPromptTemplate: () => Promise<string> = loadTemplate,
): Promise<{ tasks: Tasks; config: DayzeroConfig; template: string }> {
  const [tasks, config, template] = await Promise.allSettled([
    loadTasks(resolve(cwd, tasksLabel), tasksLabel),
    loadConfig(resolve(cwd, configLabel), configLabel),
    loadPromptTemplate(),
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
