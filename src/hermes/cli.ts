import { execFile } from "node:child_process";

export type HermesRun = (args: string[], options?: { input?: string }) => Promise<string>;

/** The factory's own Hermes home and a way to run `hermes` against it. */
export interface FactoryHermes {
  root: string;
  run: HermesRun;
}

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

/** A warning some Hermes installs print on every command; it never explains a failure. */
const NOISE = /install out of sync/;

/** A line of JSON a `hermes hephaestus` action printed, or undefined for any other line. */
export function jsonLine(line: string): unknown {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

/** The last JSON line in a `hermes hephaestus` action's output; Hermes may print other lines around it. */
export function lastJsonLine(output: string): unknown {
  for (const line of output.split("\n").reverse()) {
    const value = jsonLine(line);
    if (value !== undefined) return value;
  }
  return undefined;
}

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Runs `hermes` with HERMES_HOME (and HERMES_KANBAN_HOME) set to the factory
 * root, so no command can reach the owner's Hermes home. It must run as the
 * same user as Hephaestus: Hermes writes `.env` files and skill folders that
 * Hephaestus later reads and prunes. Output comes back without colour codes.
 */
export function hermesRunner(executable: string, root: string): HermesRun {
  return (args, options) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        args,
        {
          // HERMES_KANBAN_HOME would otherwise point board commands at another home's boards.
          env: { ...process.env, HERMES_HOME: root, HERMES_KANBAN_HOME: root, NO_COLOR: "1" },
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          if (error) {
            // Some installs print an "install out of sync" warning on stderr for every
            // command, and Hermes often prints the real error on stdout.
            const detail = stripAnsi(`${stdout}\n${stderr}`)
              .split("\n")
              .filter((line) => line.trim() !== "" && !NOISE.test(line))
              .slice(-3)
              .join(" ");
            reject(
              new Error(`hermes ${args.slice(0, 3).join(" ")} failed: ${detail}`, { cause: error }),
            );
          } else {
            resolve(stripAnsi(stdout));
          }
        },
      );
      // A child that exits before reading stdin must not raise an unhandled EPIPE.
      child.stdin?.on("error", () => undefined);
      if (options?.input === undefined) child.stdin?.end();
      else child.stdin?.end(options.input);
    });
}
