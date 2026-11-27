import { dirname } from "node:path";

export interface UpdateResult {
  status: number;
  stdout: string;
}

/** Runs a command in the checkout; npm's output goes straight to the terminal. */
export type UpdateRun = (command: string, args: string[]) => UpdateResult;

export interface UpdateOptions {
  /** The checkout the service runs from. */
  root: string;
  git: string;
  /** How to run npm 11: npm itself, or an older npm running npm 11. */
  npm: string[];
  /** The node and CLI the service runs, which run the new build's Hermes sync. */
  node: string;
  cli: string;
  /** Whether a factory Hermes root is set up, so a change to what it installs needs a sync. */
  hermes: boolean;
  run: UpdateRun;
  restart: () => void;
  log: (line: string) => void;
}

/** The files `hermes sync` installs, or code that decides what it installs. */
const HERMES_SYNC_PATHS = ["templates/hermes", "src/hermes"];

const short = (sha: string): string => sha.slice(0, 7);

/**
 * Brings the checkout the service runs from up to origin/main: fast-forward,
 * `npm ci`, `npm run build`, a Hermes sync when what it installs changed, and
 * a restart. It refuses, changing nothing, when the checkout has uncommitted
 * changes, is not on main, or cannot fast-forward. When the install or the
 * build fails it does not restart, so the running service keeps its old build.
 * Returns the exit code.
 */
export function update(options: UpdateOptions): number {
  const { git, run, log } = options;
  const gitOut = (...args: string[]): UpdateResult => run(git, args);
  const refuse = (why: string): number => {
    log(`Not updated: ${why}`);
    return 1;
  };

  if (gitOut("status", "--porcelain", "--untracked-files=no").stdout.trim() !== "") {
    return refuse(
      `${options.root} has uncommitted changes. Commit or discard them, then run update again.`,
    );
  }
  const branch = gitOut("symbolic-ref", "--short", "HEAD");
  if (branch.status !== 0) return refuse(`${options.root} is not on a branch.`);
  if (branch.stdout.trim() !== "main") {
    return refuse(`${options.root} is on branch ${branch.stdout.trim()}, not main.`);
  }
  if (gitOut("fetch", "--quiet", "origin", "main").status !== 0) {
    return refuse("could not fetch main from origin.");
  }
  const old = gitOut("rev-parse", "HEAD").stdout.trim();
  const target = gitOut("rev-parse", "origin/main").stdout.trim();
  if (old === target) {
    log(`Already up to date at ${short(old)}.`);
    return 0;
  }
  if (gitOut("merge-base", "--is-ancestor", "HEAD", "origin/main").status !== 0) {
    return refuse(
      `${options.root} cannot fast-forward to origin/main: it has commits origin/main does not.`,
    );
  }
  const commits = gitOut("rev-list", "--count", `${old}..${target}`).stdout.trim();
  if (gitOut("merge", "--ff-only", "origin/main").status !== 0) {
    return refuse("the fast-forward to origin/main failed.");
  }
  log(`Fast-forwarded ${short(old)} to ${short(target)} (${commits} commits).`);

  const stuck = (step: string): number => {
    log(
      `${step} failed, so Hephaestus did not restart: the service still runs the old build from ${short(old)}. The checkout is at ${short(target)}. Fix the problem and run update again, or go back with \`git -C ${options.root} reset --hard ${old}\` and \`npm ci\` and \`npm run build\` there.`,
    );
    return 1;
  };
  const [npm = "npm", ...npmArgs] = options.npm;
  if (run(npm, [...npmArgs, "ci"]).status !== 0) return stuck("npm ci");
  if (run(npm, [...npmArgs, "run", "build"]).status !== 0) return stuck("The build");

  let synced = true;
  if (options.hermes) {
    const changed = gitOut("diff", "--name-only", old, target, "--", ...HERMES_SYNC_PATHS);
    if (changed.stdout.trim() !== "") {
      log("What the factory Hermes root installs changed, so it is synced.");
      synced = run(options.node, [options.cli, "hermes", "sync"]).status === 0;
    }
  }
  options.restart();
  log(`Restarted the service on ${short(target)}.`);
  if (!synced) {
    log(
      `The Hermes sync failed; the new build runs anyway. Run \`node ${options.cli} hermes sync\` again.`,
    );
    return 1;
  }
  return 0;
}

/** Undoes the quoting `quoteArgument` in service.ts applies to an ExecStart argument. */
function unquote(argument: string): string {
  return argument
    .slice(1, -1)
    .replace(/\\(.)|%%/g, (match, escaped: string | undefined) => escaped ?? "%");
}

/** The node and CLI paths a Hephaestus unit's ExecStart runs, or undefined when it has none. */
export function serviceProgram(unit: string): { node: string; cli: string } | undefined {
  const line = unit.split("\n").find((text) => text.startsWith("ExecStart=:"));
  if (line === undefined) return undefined;
  const args = line.slice("ExecStart=:".length).match(/"(?:\\.|[^"\\])*"/g);
  const [node, cli] = args ?? [];
  if (node === undefined || cli === undefined) return undefined;
  return { node: unquote(node), cli: unquote(cli) };
}

/** The checkout a CLI path in it belongs to: `dist/cli.js` sits at its root. */
export function checkoutOf(cli: string): string {
  return dirname(dirname(cli));
}
