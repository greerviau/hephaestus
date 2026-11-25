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

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Runs `hermes` with HERMES_HOME set to the factory root, so no command can
 * reach the owner's Hermes home. Output comes back without colour codes.
 */
export function hermesRunner(executable: string, root: string): HermesRun {
  return (args, options) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        executable,
        args,
        {
          env: { ...process.env, HERMES_HOME: root, NO_COLOR: "1" },
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
      child.stdin?.end(options?.input ?? "");
    });
}
