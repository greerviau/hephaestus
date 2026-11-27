import { dirname } from "node:path";

export interface UpdateResult {
  status: number;
  stdout: string;
  stderr?: string;
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
  /** Restarts the service and resolves whether its dashboard answered. */
  restart: () => Promise<boolean>;
  log: (line: string) => void;
}

/** The files `hermes sync` installs, and code that decides what it writes. */
const HERMES_SYNC_PATHS = ["templates/hermes", "src/hermes", "src/config/shipped.ts"];

const short = (sha: string): string => sha.slice(0, 7);

/** A command line for the owner to paste, with each argument quoted only when it must be. */
export function shellCommand(args: string[]): string {
  return args
    .map((arg) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, "'\\''")}'`))
    .join(" ");
}

/**
 * Brings the checkout the service runs from up to origin/main: fast-forward,
 * `npm ci`, `npm run build`, a Hermes sync when what it installs changed, and
 * a restart. It refuses, changing nothing, when the checkout has uncommitted
 * changes, is not on main, cannot fetch, or cannot fast-forward. When the
 * install or the build fails, or the new build does not start, it resets the
 * checkout to the old commit and rebuilds it, so the service keeps, or gets
 * back, the build it had, and a later run tries again. Returns the exit code.
 */
export async function update(options: UpdateOptions): Promise<number> {
  const { git, run, log, root } = options;
  const gitOut = (...args: string[]): UpdateResult => run(git, args);
  const refuse = (why: string): number => {
    log(`Not updated: ${why}`);
    return 1;
  };

  if (gitOut("status", "--porcelain", "--untracked-files=no").stdout.trim() !== "") {
    return refuse(
      `${root} has uncommitted changes. Commit or discard them, then run update again.`,
    );
  }
  const branch = gitOut("symbolic-ref", "--short", "HEAD");
  if (branch.status !== 0) return refuse(`${root} is not on a branch.`);
  if (branch.stdout.trim() !== "main") {
    return refuse(`${root} is on branch ${branch.stdout.trim()}, not main.`);
  }
  const fetched = gitOut("fetch", "--quiet", "origin", "main");
  if (fetched.status !== 0) {
    const cause = fetched.stderr?.trim() ?? "";
    return refuse(`could not fetch main from origin${cause === "" ? "." : `: ${cause}`}`);
  }
  const old = gitOut("rev-parse", "HEAD").stdout.trim();
  const target = gitOut("rev-parse", "origin/main").stdout.trim();
  if (old === target) {
    log(`Already up to date at ${short(old)}.`);
    return 0;
  }
  if (gitOut("merge-base", "--is-ancestor", "HEAD", "origin/main").status !== 0) {
    return refuse(
      `${root} cannot fast-forward to origin/main: it has commits origin/main does not.`,
    );
  }
  const commits = gitOut("rev-list", "--count", `${old}..${target}`).stdout.trim();
  if (gitOut("merge", "--ff-only", "origin/main").status !== 0) {
    return refuse("the fast-forward to origin/main failed.");
  }
  log(`Fast-forwarded ${short(old)} to ${short(target)} (${commits} commits).`);

  const [npm = "npm", ...npmArgs] = options.npm;
  const build = (): string | undefined => {
    if (run(npm, [...npmArgs, "ci"]).status !== 0) return "npm ci";
    if (run(npm, [...npmArgs, "run", "build"]).status !== 0) return "The build";
    return undefined;
  };
  const sync = (): boolean => run(options.node, [options.cli, "hermes", "sync"]).status === 0;
  const syncCommand = shellCommand([options.node, options.cli, "hermes", "sync"]);
  let synced = false;
  /** Puts the old commit back and rebuilds it; says whether that worked. */
  const rollBack = (): boolean => {
    log(`Rolling back to ${short(old)}.`);
    if (gitOut("reset", "--quiet", "--hard", old).status !== 0 || build() !== undefined) {
      log(
        `Hephaestus could not rebuild ${short(old)} either. The running service is unaffected until it restarts. Run update again once the problem is fixed, or rebuild by hand with \`cd ${shellCommand([root])} && npm ci && npm run build\`.`,
      );
      return false;
    }
    if (synced && !sync()) log(`The Hermes sync of ${short(old)} failed; run \`${syncCommand}\`.`);
    return true;
  };

  const failed = build();
  if (failed !== undefined) {
    log(`${failed} failed, so Hephaestus did not restart the service.`);
    if (rollBack()) {
      log(
        `It rolled back to ${short(old)}, which the service still runs. Run update again once the problem is fixed.`,
      );
    }
    return 1;
  }

  let syncFailed = false;
  if (options.hermes) {
    const changed = gitOut("diff", "--name-only", old, target, "--", ...HERMES_SYNC_PATHS);
    if (changed.stdout.trim() !== "") {
      log("What the factory Hermes root installs changed, so it is synced.");
      synced = true;
      syncFailed = !sync();
    }
  }
  if (!(await options.restart())) {
    log(`The new build ${short(target)} did not start.`);
    if (rollBack()) {
      const back = await options.restart();
      log(
        back
          ? `It rolled back to ${short(old)} and restarted the service on it.`
          : `It rolled back to ${short(old)}, but the service did not start on it either. See journalctl --user -u hephaestus.`,
      );
    }
    return 1;
  }
  log(`Restarted the service on ${short(target)}.`);
  if (syncFailed) {
    log(`The Hermes sync failed; the new build runs anyway. Run \`${syncCommand}\` again.`);
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
