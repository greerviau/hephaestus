#!/usr/bin/env node
import { SelfUpdate } from "./self-update.js";
import { spawnSync } from "node:child_process";
import {
  checkoutOf,
  lockUpdate,
  serviceProgram,
  shellCommand,
  update,
  updateLocked,
} from "./update.js";
import { VersionCheck, gitIn } from "./version-check.js";
import { offerStarterSkills } from "./config/starter-skills.js";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_PORT, installPrefix, readConfig } from "./config.js";
import { resolveRoots } from "./baseline.js";
import { scheduleBackups } from "./config/backup.js";
import { importSkill } from "./config/defaults.js";
import { ConfigStore } from "./config/store.js";
import { AlreadyInstalledError, install, installedUnitPath, uninstall } from "./install.js";
import { FactoryModel, spawnLogin } from "./hermes/factory-model.js";
import { hermesModel } from "./hermes/model.js";
import { PLUGIN_NAME } from "./hermes/plugin.js";
import { Messaging, proposalAlerts } from "./messaging.js";
import { RequestThreads } from "./request-threads.js";
import { GATEWAY_SERVICE_NAME, resolvePaths } from "./paths.js";
import { readPassword } from "./prompt.js";
import { waitForDashboard } from "./ready.js";
import { createDashboardServer } from "./server.js";
import { SystemdUserService, runCommand } from "./service.js";
import { hermesRunner } from "./hermes/cli.js";
import { openStore } from "./store.js";
import { T3Adapter } from "./t3/adapter.js";
import {
  T3Credentials,
  mintPairingCode,
  revokeSessions,
  t3Runner,
  signIn,
  t3ClientName,
} from "./t3/auth.js";
import { T3Connection } from "./t3/connection.js";
import { ThreadEvents } from "./t3/events.js";
import { ThreadFollower } from "./t3/follower.js";
import { cachedEnvironments, findExecutable, resolveT3Origin } from "./t3/origin.js";
import { workersRoutes } from "./web/workers.js";
import { dashboardRoutes } from "./web/dashboard.js";
import { BackgroundDeploys } from "./web/deploys.js";
import type { FactoryPages } from "./web/factory.js";
import { shellSource } from "./web/shell.js";
import { analytics } from "./factory/analytics.js";
import { SecretsFile } from "./config/secrets.js";
import { getMeta, setMeta } from "./meta.js";
import { ConfigRepo } from "./workers/config-repo.js";
import { workerAlerts } from "./workers/alerts.js";
import { WorkerManager, taskReason } from "./workers/manager.js";
import { FactoryThreads } from "./t3/threads.js";
import { finalMessage } from "./workers/scripts.js";
import type { Database } from "better-sqlite3";
import type { Paths } from "./paths.js";
import type { Config } from "./config.js";
import { ROLE_NAMES } from "./config/document.js";
import type { ConfigVersion } from "./config/store.js";
import { CardStore } from "./factory/cards.js";
import { GitHub } from "./factory/github.js";
import { Intake } from "./factory/intake.js";
import { FactoryMcp } from "./factory/mcp.js";
import { Pipeline } from "./factory/pipeline.js";
import { FactoryBoard } from "./hermes/board.js";
import { chatCacheDirs } from "./hermes/cache.js";
import { applyShippedInstructions, mcpTokenSecret, syncFactoryHermes } from "./hermes/setup.js";

const USAGE = `Usage:
  hephaestus install [--port <port>] [--skill <folder>]...
                                       Create ~/.hephaestus, set the dashboard password, start the service.
                                       Each --skill folder (one with a SKILL.md) goes into the first
                                       config version. Reads the password from stdin when stdin is not
                                       a terminal.
  hephaestus hermes sync [--hermes <path>]
                                       Set up or update the factory Hermes root, board, and profiles from
                                       the current config version, and start the factory gateway.
  hephaestus uninstall [--skip-workers]
                                       Remove the factory setup from each worker, the services, and
                                       ~/.hephaestus, then report baseline changes. Stops without
                                       removing anything if a worker cannot be cleaned up, unless
                                       --skip-workers is given.
  hephaestus update                    Bring the checkout the service runs from up to origin/main: fast-forward,
                                       npm ci, npm run build, a Hermes sync when needed, and a restart.
                                       Refuses when the checkout has uncommitted changes or cannot
                                       fast-forward, and does not restart when the build fails.
  hephaestus serve                     Run the dashboard in the foreground (the service runs this).`;

const CONFIG_REPO_KEY = "config_repo";
/** The npm that `npm ci` needs for this lockfile, run through an older npm when that is all there is. */
const NPM_PIN = "npm@11.6.2";

/** How to run npm 11 next to `node`: that npm itself, or an older one running npm 11. */
function npmFor(node: string): string[] {
  const local = join(dirname(node), "npm");
  const npm = existsSync(local) ? local : "npm";
  const version = spawnSync(npm, ["--version"], { encoding: "utf8", env: pathWith(node) });
  const major = Number(/^(\d+)\./.exec(version.stdout)?.[1] ?? 0);
  return major >= 11 ? [npm] : [npm, "exec", "--yes", `--package=${NPM_PIN}`, "--", "npm"];
}

/** The environment with `node`'s folder first on PATH, so npm's scripts find the same node. */
function pathWith(node: string): NodeJS.ProcessEnv {
  return { ...process.env, PATH: `${dirname(node)}:${process.env.PATH ?? ""}` };
}

/** A signed-in connection to this host's T3, through its outside MCP server. */
function t3Client(paths: Paths, config: Config): { connection: T3Connection; t3: T3Adapter } {
  const clientName = t3ClientName(config.instanceId);
  const runT3 = t3Runner(config.t3Path, config.t3Home);
  // Resolved on every connect, so a T3 restart on another port is picked up.
  const origin = (): string => resolveT3Origin(process.env, paths.home, config.t3Home);
  const credentials = new T3Credentials(new SecretsFile(paths.secrets), async () => {
    // Each sign-in replaces the last one, so old sessions do not pile up in T3.
    await revokeSessions(runT3, clientName);
    return signIn(origin(), clientName, await mintPairingCode(runT3, clientName));
  });
  const connection = new T3Connection(() => `${origin()}/mcp`, credentials);
  return { connection, t3: new T3Adapter(connection) };
}

const CLEANUP_WAIT_MS = 5 * 60_000;

/**
 * Runs the cleanup thread on every worker Hephaestus set up and reports each
 * outcome. A worker that cannot be reached keeps its setup, and the report says so.
 */
/** Stops using the named workers, so the service deploys nothing there. */
function disableWorkers(paths: Paths, labels: string[]): void {
  const db = openStore(paths.state);
  try {
    const update = db.prepare("UPDATE workers SET enabled = 0 WHERE label = ?");
    for (const label of labels) update.run(label);
    if (labels.includes("all workers")) db.prepare("UPDATE workers SET enabled = 0").run();
  } finally {
    db.close();
  }
}

/** Returns the labels of the workers it could not clean up. */
async function cleanUpWorkers(paths: Paths, config: Config): Promise<string[]> {
  const failed: string[] = [];
  const db = openStore(paths.state);
  const { connection, t3 } = t3Client(paths, config);
  try {
    const events = new ThreadEvents(db);
    const manager = workerManager(db, paths, config, new ConfigStore(db), t3, events);
    // Every worker Hephaestus started anything on, even a first deploy that failed.
    const touched = new Set(
      (
        db.prepare("SELECT DISTINCT environment_id AS id FROM worker_tasks").all() as {
          id: string;
        }[]
      ).map((row) => row.id),
    );
    const workers = manager
      .workers()
      .filter(
        (worker) =>
          worker.enabled || worker.deployedVersion !== null || touched.has(worker.environmentId),
      );

    const waitFor = async (environmentId: string, threadId: string): Promise<string> => {
      const deadline = Date.now() + CLEANUP_WAIT_MS;
      let status = "running";
      while (Date.now() < deadline) {
        const wait = await t3.wait(environmentId, threadId, 60_000);
        status = wait.status;
        if (!wait.timedOut) break;
      }
      return status;
    };
    for (const worker of workers) {
      // A deploy or sign-in still running could set the worker up again after the cleanup,
      // so the cleanup waits for every Hephaestus setup thread T3 lists as active there,
      // including ones whose launch reply never reached Hephaestus.
      let active: string[];
      try {
        active = await t3.activeThreads(worker.environmentId, "Hephaestus:");
        for (const threadId of active) await waitFor(worker.environmentId, threadId);
        active = await t3.activeThreads(worker.environmentId, "Hephaestus:");
      } catch (error) {
        console.log(`Could not reach ${worker.label} to clean it up: ${String(error)}`);
        failed.push(worker.label);
        continue;
      }
      if (active.length > 0) {
        console.log(
          `Did not clean up ${worker.label}: ${String(active.length)} Hephaestus setup threads are still running there.`,
        );
        failed.push(worker.label);
        continue;
      }
      let task = await manager.startCleanup(worker.environmentId);
      const threadId = task.threadId;
      if (threadId !== null) {
        try {
          const status = await waitFor(worker.environmentId, threadId);
          const items = [];
          let after = -1;
          for (;;) {
            const page = await t3.read(worker.environmentId, threadId, after);
            items.push(...page.items);
            if (!page.hasMore || page.nextPosition <= after) break;
            after = page.nextPosition;
          }
          await manager.finish(task, status, finalMessage(items) ?? "");
        } catch (error) {
          console.log(`  ${worker.label}: could not follow the cleanup thread: ${String(error)}`);
        }
        task = manager.task(task.id) ?? task;
      }
      if (task.status !== "succeeded") failed.push(worker.label);
      console.log(
        task.status === "succeeded"
          ? `Removed the factory setup from ${worker.label}.`
          : `Could not remove the factory setup from ${worker.label}: ${taskReason(task, "the cleanup thread did not finish")}. Remove the hephaestus-claude and hephaestus-codex provider instances and ~/.hephaestus there by hand.`,
      );
    }
  } finally {
    await connection.close();
    db.close();
  }
  return failed;
}

/** Intake, the pipeline, and the MCP server for the factory profiles. */
function factoryEngine(
  db: Database,
  paths: Paths,
  config: Config,
  store: ConfigStore,
  t3: T3Adapter,
  events: ThreadEvents,
  workers: WorkerManager,
): { intake: Intake; pipeline: Pipeline; cards: CardStore; mcp: FactoryMcp; github: GitHub } {
  const ghPath = config.ghPath ?? findExecutable("gh", process.env.PATH) ?? "gh";
  const github = new GitHub(ghPath);
  const cards = new CardStore(db);
  const hermesPath = config.hermesPath;
  // The board exists once `hermes sync` or a deploy has set the factory root up.
  const board = (): FactoryBoard | undefined =>
    hermesPath !== undefined && existsSync(paths.hermes)
      ? new FactoryBoard({ root: paths.hermes, run: hermesRunner(hermesPath, paths.hermes) })
      : undefined;
  const deployed = (): ConfigVersion | undefined =>
    store.list().find((version) => version.state === "deployed");
  // Intake abandons through the pipeline, which is built next.
  const late: { pipeline?: Pipeline } = {};
  const intake = new Intake({
    db,
    cards,
    github,
    config: () => deployed()?.document,
    board,
    abandon: (cardId, reason) =>
      late.pipeline?.abandonUnstarted(cardId, reason) ?? Promise.resolve(),
  });
  const pipeline = new Pipeline({
    db,
    cards,
    github,
    workers,
    t3,
    threads: new FactoryThreads(t3, events),
    events,
    config: () => deployed(),
    install: config.instanceId,
    board,
  });
  late.pipeline = pipeline;
  const secrets = new SecretsFile(paths.secrets);
  const mcp = new FactoryMcp({
    db,
    cards,
    intake,
    pipeline,
    store,
    events,
    deploy: (id) => workers.deployVersion(id),
    tokens: () =>
      Object.fromEntries(ROLE_NAMES.map((role) => [role, secrets.get(mcpTokenSecret(role))])),
    // Hermes caches the files a chat sends under the profile's home.
    attachmentRoots: (role) => chatCacheDirs(join(paths.hermes, "profiles", role)),
  });
  return { intake, pipeline, cards, mcp, github };
}

/** The worker manager the service and uninstall share. */
function workerManager(
  db: Database,
  paths: Paths,
  config: Config,
  store: ConfigStore,
  t3: T3Adapter,
  events: ThreadEvents,
): WorkerManager {
  const gitPath = config.gitPath ?? findExecutable("git", process.env.PATH) ?? "git";
  const ghPath = config.ghPath ?? findExecutable("gh", process.env.PATH) ?? "gh";
  const hermesPath = config.hermesPath;
  return new WorkerManager({
    db,
    store,
    t3,
    threads: new FactoryThreads(t3, events),
    events,
    configRepo: () => {
      const slug = getMeta(db, CONFIG_REPO_KEY);
      return slug === undefined
        ? undefined
        : new ConfigRepo(
            // One clone per repo, so a new repo never gets another repo's history.
            join(paths.root, "config-repo", slug.replace("/", "__")),
            slug,
            gitPath,
            ghPath,
            `${installPrefix(config.instanceId)}-`,
          );
    },
    instances: (environmentId) => t3.instances(environmentId),
    activeThreads: (environmentId, title) => t3.activeThreads(environmentId, title),
    ...(hermesPath === undefined
      ? {}
      : {
          syncHermes: () => {
            const gatewayUnitPath = join(dirname(config.unitPath), GATEWAY_SERVICE_NAME);
            return syncFactoryHermes({
              paths,
              store,
              db,
              secrets: new SecretsFile(paths.secrets),
              hermesPath,
              run: hermesRunner(hermesPath, paths.hermes),
              service: new SystemdUserService(gatewayUnitPath),
              gatewayUnitPath,
              mcpUrl: `http://127.0.0.1:${String(config.port + 1)}/mcp`,
            });
          },
        }),
  });
}

/** Exit code when uninstall succeeded but owner config changed since install. */
const EXIT_DRIFT = 2;
/** Exit code when uninstall succeeded but the baseline was unusable, so drift is unknown. */
const EXIT_DRIFT_UNKNOWN = 3;

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const paths = resolvePaths();
  switch (command) {
    case "install": {
      const { values } = parseArgs({
        args: rest,
        options: { port: { type: "string" }, skill: { type: "string", multiple: true } },
      });
      const port = values.port === undefined ? DEFAULT_PORT : Number(values.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error(`Invalid port: ${String(values.port)}`);
      // Refuse, and read the skills, before asking for a password that would not be used.
      if (existsSync(paths.root)) throw new AlreadyInstalledError(paths.root);
      const skills = (values.skill ?? []).map((folder) => importSkill(resolve(folder)));
      const password = await readPassword("Dashboard password: ");
      await install({
        paths,
        service: new SystemdUserService(paths.unit),
        password,
        port,
        nodePath: process.execPath,
        cliPath: realpathSync(fileURLToPath(import.meta.url)),
        roots: resolveRoots(process.env, paths.home),
        ...t3PathOption(findExecutable("t3", process.env.PATH)),
        ...t3HomeOption(process.env.T3CODE_HOME),
        ...hermesPathOption(findExecutable("hermes", process.env.PATH)),
        ...optionalPath("gitPath", findExecutable("git", process.env.PATH)),
        ...optionalPath("ghPath", findExecutable("gh", process.env.PATH)),
        skills,
        waitForReady: (config) => waitForDashboard(config),
      });
      console.log(`Installed. The dashboard listens on port ${String(port)}.`);
      return 0;
    }
    case "uninstall": {
      const { values } = parseArgs({
        args: rest,
        options: { "skip-workers": { type: "boolean" } },
      });
      const installed = existsSync(paths.config) ? readConfig(paths.config) : undefined;
      if (installed !== undefined && existsSync(paths.state)) {
        // The service stops first, so it starts nothing on a worker while the cleanup runs.
        const service = new SystemdUserService(installedUnitPath(paths));
        service.stop();
        let failed: string[];
        try {
          failed = await cleanUpWorkers(paths, installed);
        } catch (error) {
          console.log(`Could not reach the workers to remove the factory setup: ${String(error)}`);
          failed = ["all workers"];
        }
        if (failed.length > 0 && values["skip-workers"] !== true) {
          // A cleanup that may still be running must not race a deploy from the restarted service.
          disableWorkers(paths, failed);
          service.start();
          console.log(
            `Uninstall stopped, and Hephaestus is running again, because the factory setup is still on ${failed.join(", ")}. Those workers are no longer used for factory work. Run uninstall again later, or pass --skip-workers to uninstall anyway and remove the hephaestus-claude and hephaestus-codex provider instances and ~/.hephaestus there by hand.`,
          );
          return 1;
        }
      }
      const { drift } = uninstall({
        paths,
        service: new SystemdUserService(installedUnitPath(paths)),
        extraServices: [
          new SystemdUserService(join(dirname(installedUnitPath(paths)), GATEWAY_SERVICE_NAME)),
        ],
      });
      console.log("Uninstalled.");
      if (installed !== undefined) {
        try {
          const revoked = await revokeSessions(
            t3Runner(installed.t3Path, installed.t3Home),
            t3ClientName(installed.instanceId),
          );
          console.log(
            `Revoked ${String(revoked.length)} T3 MCP session(s) that Hephaestus signed in.`,
          );
        } catch (error) {
          console.log(`Could not check for T3 MCP sessions to revoke: ${String(error)}`);
        }
      }
      if (drift === undefined) {
        console.log(
          "The install baseline was missing or unreadable, so changes to owner config are unknown.",
        );
        return EXIT_DRIFT_UNKNOWN;
      }
      if (drift.length === 0) {
        console.log("Owner config is unchanged since install.");
        return 0;
      }
      console.log("Owner config changed since install:");
      for (const change of drift)
        console.log(`  ${change.path}: ${change.before} -> ${change.after}`);
      return EXIT_DRIFT;
    }
    case "hermes": {
      const { positionals, values } = parseArgs({
        args: rest,
        allowPositionals: true,
        options: { hermes: { type: "string" } },
      });
      if (positionals[0] !== "sync") {
        console.error(USAGE);
        return 64;
      }
      const config = readConfig(paths.config);
      const hermesPath =
        values.hermes === undefined ? config.hermesPath : executablePath(values.hermes);
      if (hermesPath === undefined) {
        throw new Error("The hermes CLI was not on PATH at install. Pass --hermes <path>.");
      }
      const gatewayUnitPath = join(dirname(config.unitPath), GATEWAY_SERVICE_NAME);
      const db = openStore(paths.state);
      try {
        await syncFactoryHermes({
          paths,
          store: new ConfigStore(db),
          db,
          secrets: new SecretsFile(paths.secrets),
          hermesPath,
          run: hermesRunner(hermesPath, paths.hermes),
          service: new SystemdUserService(gatewayUnitPath),
          gatewayUnitPath,
          // The Hephaestus MCP server (issue #10) listens on the port after the dashboard's.
          mcpUrl: `http://127.0.0.1:${String(config.port + 1)}/mcp`,
        });
      } finally {
        db.close();
      }
      console.log(`The factory Hermes root at ${paths.hermes} matches the current config version.`);
      return 0;
    }
    case "update": {
      parseArgs({ args: rest, options: {} });
      const config = readConfig(paths.config);
      const unitPath = installedUnitPath(paths);
      const program = serviceProgram(readFileSync(unitPath, "utf8"));
      if (program === undefined)
        throw new Error(`${unitPath} has no ExecStart that Hephaestus wrote.`);
      const root = checkoutOf(program.cli);
      const git = config.gitPath ?? "git";
      const env = pathWith(program.node);
      let release: () => void;
      try {
        release = lockUpdate(paths.updateLock);
      } catch (error) {
        console.log(`Not updated: ${error instanceof Error ? error.message : String(error)}`);
        return 1;
      }
      try {
        return await update({
          root,
          git,
          npm: npmFor(program.node),
          node: program.node,
          cli: program.cli,
          hermes: config.hermesPath !== undefined && existsSync(join(paths.hermes, "profiles")),
          run: (command, args) => {
            // git's answers are read; npm's and the sync's output goes to the terminal as it runs.
            const quiet = command === git;
            const result = spawnSync(command, quiet ? ["-C", root, ...args] : args, {
              cwd: root,
              env,
              encoding: "utf8",
              stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
            });
            // A command that cannot start fails like one that ran and failed, so update can roll back.
            if (result.error) return { status: 127, stdout: "", stderr: result.error.message };
            // With inherited output there is nothing to read back.
            return {
              status: result.status ?? 1,
              stdout: typeof result.stdout === "string" ? result.stdout : "",
              stderr: typeof result.stderr === "string" ? result.stderr : "",
            };
          },
          restart: async () => {
            try {
              new SystemdUserService(unitPath).restart();
              await waitForDashboard(config, { timeoutMs: 30_000 });
              return true;
            } catch (error) {
              console.log(`The service did not come back: ${String(error)}`);
              return false;
            }
          },
          log: (line) => {
            console.log(line);
          },
        });
      } finally {
        release();
      }
    }
    case "serve": {
      parseArgs({ args: rest, options: {} });
      const config = readConfig(paths.config);
      const db = openStore(paths.state);
      const store = new ConfigStore(db);
      mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
      const stopBackups = scheduleBackups(store, paths.backups);
      const { connection, t3 } = t3Client(paths, config);
      const environments = cachedEnvironments(t3, 30_000);
      const events = new ThreadEvents(db);
      const following = new AbortController();
      const follower = new ThreadFollower(t3, events).run(following.signal);
      const workers = workerManager(db, paths, config, store, t3, events);
      const engine = factoryEngine(db, paths, config, store, t3, events, workers);
      // A build that ships new role instructions brings them to the factory Hermes root at once,
      // and a failed sync is tried again.
      const hermesPath = config.hermesPath;
      const applyShipped = (): void => {
        if (hermesPath === undefined) return;
        applyShippedInstructions({
          db,
          store,
          hermesRoot: paths.hermes,
          sync: () => workers.resyncHermes(),
        }).catch((error: unknown) => {
          console.error("Applying the shipped role instructions failed", error);
        });
      };
      // An update that ships new starter skills offers them on Proposals, and a draft that a
      // deploy left behind is offered again on the deployed version.
      const offerStarters = (): void => {
        try {
          offerStarterSkills({ db, store });
        } catch (error) {
          console.error("Offering the starter skills failed", error);
        }
      };
      applyShipped();
      offerStarters();
      // The commit this service runs, and whether origin/main has more, for the sidebar.
      const cliPath = realpathSync(fileURLToPath(import.meta.url));
      const updateCommand = shellCommand([process.execPath, cliPath, "update"]);
      const versionCheck = new VersionCheck({
        exec: gitIn(checkoutOf(cliPath), config.gitPath ?? "git"),
      });
      const checkVersion = (): void => {
        void versionCheck.refresh();
      };
      checkVersion();
      const mcpServer = engine.mcp.listen(config.port + 1);
      const engineTicks = [
        setInterval(() => {
          applyShipped();
          offerStarters();
          checkVersion();
        }, 5 * 60_000),
        setInterval(() => {
          engine.pipeline.tick().catch((error: unknown) => {
            console.error("Advancing cards failed", error);
          });
        }, 20_000),
        setInterval(() => {
          engine.intake.poll().catch((error: unknown) => {
            console.error("Reading factory project issues failed", error);
          });
        }, 120_000),
      ];
      const ticking = setInterval(() => {
        workers.tick().catch((error: unknown) => {
          console.error("Advancing worker tasks failed", error);
        });
      }, 5_000);
      const messaging =
        config.hermesPath === undefined
          ? undefined
          : new Messaging({
              root: paths.hermes,
              run: hermesRunner(config.hermesPath, paths.hermes),
              gateway: new SystemdUserService(join(dirname(config.unitPath), GATEWAY_SERVICE_NAME)),
              db,
              cards: engine.cards,
              dashboardUrl: () => dashboardUrl(config.host, config.port),
              extraAlerts: () => [
                ...proposalAlerts(store.list()),
                ...workerAlerts(workers.views()),
              ],
            });
      const factoryModel =
        messaging === undefined || config.hermesPath === undefined
          ? undefined
          : new FactoryModel({
              // A deploy installs the plugin, then creates the profiles it writes to.
              ready: () =>
                existsSync(join(paths.hermes, "plugins", PLUGIN_NAME, "__init__.py")) &&
                ROLE_NAMES.every((role) => existsSync(join(paths.hermes, "profiles", role))),
              run: hermesRunner(config.hermesPath, paths.hermes),
              restartGateway: () => messaging.restart(),
              startLogin: spawnLogin(config.hermesPath, paths.hermes),
            });
      const alerting = setInterval(() => {
        messaging?.sendAlerts().catch((error: unknown) => {
          console.error("Sending alerts failed", error);
        });
      }, 20_000);
      const requests =
        messaging === undefined
          ? undefined
          : new RequestThreads({
              db,
              install: config.instanceId,
              cards: engine.cards,
              messaging,
              github: engine.github,
              dashboardUrl: () => dashboardUrl(config.host, config.port),
            });
      let followingRequests: Promise<void> | undefined;
      const threading = setInterval(() => {
        // One pass at a time; a slow Discord read must not stack passes.
        followingRequests ??= (async () => {
          try {
            await requests?.link();
          } catch (error) {
            console.error("Finding request threads failed", error);
          }
          await requests?.progress();
        })()
          .catch((error: unknown) => {
            console.error("Posting request progress failed", error);
          })
          .finally(() => {
            followingRequests = undefined;
          });
      }, 30_000);
      const pages: FactoryPages = {
        // Update runs as a unit of its own, so it outlives this service's restart.
        updater: new SelfUpdate({
          run: runCommand,
          node: process.execPath,
          cli: cliPath,
          logPath: join(paths.root, "update.log"),
          path: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
        }),
        updating: () => updateLocked(paths.updateLock),
        version: () => {
          const state = versionCheck.state();
          return state === undefined ? undefined : { ...state, command: updateCommand };
        },
        cards: engine.cards,
        intake: engine.intake,
        pipeline: engine.pipeline,
        events,
        mcp: engine.mcp,
        store,
        analytics: (query) => analytics(db, query),
        workers,
        environments,
        deploys: new BackgroundDeploys((id) => workers.deployVersion(id)),
        github: engine.github,
        configRepo: () => getMeta(db, CONFIG_REPO_KEY),
        setConfigRepo: (slug) => {
          setMeta(db, CONFIG_REPO_KEY, slug);
        },
        hermesModel: () => hermesDefaultModel(paths.hermes),
        ...(messaging === undefined ? {} : { messaging }),
        ...(factoryModel === undefined ? {} : { model: factoryModel }),
      };
      const server = createDashboardServer({
        db,
        instanceId: config.instanceId,
        shell: shellSource(pages),
        routes: [
          ...dashboardRoutes(pages),
          ...workersRoutes(environments, Date.now, { manager: workers }),
        ],
      });
      server.listen(config.port, config.host, () => {
        console.log(`Dashboard listening on ${config.host}:${String(config.port)}`);
      });
      await new Promise<void>((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
      });
      stopBackups();
      clearInterval(ticking);
      clearInterval(alerting);
      clearInterval(threading);
      for (const timer of engineTicks) clearInterval(timer);
      await new Promise((resolve) => mcpServer.close(resolve));
      following.abort();
      // Closing the connection fails calls still waiting on T3, so shutdown does not wait for them.
      await connection.close();
      await follower;
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      db.close();
      return 0;
    }
    default:
      console.error(USAGE);
      return command === undefined || command === "--help" || command === "help" ? 0 : 64;
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  },
);

function t3PathOption(path: string | undefined): { t3Path?: string } {
  return path === undefined ? {} : { t3Path: path };
}

function t3HomeOption(home: string | undefined): { t3Home?: string } {
  return home !== undefined && isAbsolute(home) ? { t3Home: home } : {};
}

function optionalPath<K extends string>(
  key: K,
  path: string | undefined,
): Partial<Record<K, string>> {
  return path === undefined ? {} : ({ [key]: path } as Record<K, string>);
}

function hermesPathOption(path: string | undefined): { hermesPath?: string } {
  return path === undefined ? {} : { hermesPath: path };
}

/** An absolute path to an executable file, since systemd needs one for ExecStart. */
function executablePath(path: string): string {
  const absolute = resolve(path);
  try {
    accessSync(absolute, constants.X_OK);
  } catch {
    throw new Error(`${absolute} is not an executable file.`);
  }
  return absolute;
}

/**
 * The model the factory Hermes roles run, for the setup checklist: the root's
 * default model, while every profile that exists names a model too. A
 * profile without one gets the root's at the next deploy.
 */
function hermesDefaultModel(hermesHome: string): string | undefined {
  const read = (path: string): string => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return "";
    }
  };
  const model = hermesModel(read(join(hermesHome, "config.yaml")));
  if (model === undefined) return undefined;
  for (const role of ROLE_NAMES) {
    const path = join(hermesHome, "profiles", role, "config.yaml");
    if (existsSync(path) && hermesModel(read(path)) === undefined) return undefined;
  }
  return model;
}

/**
 * The dashboard's address for links in alerts: the host's first LAN address
 * when the dashboard listens on every interface, since a phone cannot reach
 * 0.0.0.0 or localhost.
 */
function dashboardUrl(host: string, port: number): string {
  let address = host;
  if (host === "0.0.0.0" || host === "::") {
    const lan = Object.values(networkInterfaces())
      .flat()
      .find((entry) => entry !== undefined && entry.family === "IPv4" && !entry.internal);
    address = lan?.address ?? "localhost";
  }
  return `http://${address}:${String(port)}/`;
}
