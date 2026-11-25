#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { DEFAULT_PORT, readConfig } from "./config.js";
import { resolveRoots } from "./baseline.js";
import { scheduleBackups } from "./config/backup.js";
import { importSkill } from "./config/defaults.js";
import { ConfigStore } from "./config/store.js";
import { AlreadyInstalledError, install, installedUnitPath, uninstall } from "./install.js";
import { resolvePaths } from "./paths.js";
import { readPassword } from "./prompt.js";
import { waitForDashboard } from "./ready.js";
import { createDashboardServer } from "./server.js";
import { SystemdUserService } from "./service.js";
import { openStore } from "./store.js";
import { settingsRoutes } from "./web/settings.js";

const USAGE = `Usage:
  hephaestus install [--port <port>] [--skill <folder>]...
                                       Create ~/.hephaestus, set the dashboard password, start the service.
                                       Each --skill folder (one with a SKILL.md) goes into the first
                                       config version. Reads the password from stdin when stdin is not
                                       a terminal.
  hephaestus uninstall                 Remove the service and ~/.hephaestus, then report baseline changes.
  hephaestus serve                     Run the dashboard in the foreground (the service runs this).`;

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
        skills,
        waitForReady: (config) => waitForDashboard(config),
      });
      console.log(`Installed. The dashboard listens on port ${String(port)}.`);
      return 0;
    }
    case "uninstall": {
      parseArgs({ args: rest, options: {} });
      const { drift } = uninstall({
        paths,
        service: new SystemdUserService(installedUnitPath(paths)),
      });
      console.log("Uninstalled.");
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
    case "serve": {
      parseArgs({ args: rest, options: {} });
      const config = readConfig(paths.config);
      const db = openStore(paths.state);
      const store = new ConfigStore(db);
      mkdirSync(paths.backups, { recursive: true, mode: 0o700 });
      const stopBackups = scheduleBackups(store, paths.backups);
      const server = createDashboardServer({
        db,
        instanceId: config.instanceId,
        routes: settingsRoutes(store),
      });
      server.listen(config.port, config.host, () => {
        console.log(`Dashboard listening on ${config.host}:${String(config.port)}`);
      });
      await new Promise<void>((resolve) => {
        process.once("SIGTERM", resolve);
        process.once("SIGINT", resolve);
      });
      stopBackups();
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
