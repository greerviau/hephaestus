import { describe, expect, it } from "vitest";
import { serviceProgram, update, type UpdateRun } from "../src/update.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

/** A checkout on main at OLD whose origin/main is at NEW, answering like git and npm would. */
function fake(
  overrides: Record<string, { status: number; stdout?: string; stderr?: string }> = {},
): {
  run: UpdateRun;
  calls: string[];
} {
  const calls: string[] = [];
  let head = OLD;
  const answers: Record<string, { status: number; stdout?: string; stderr?: string }> = {
    "git status --porcelain --untracked-files=no": { status: 0, stdout: "" },
    "git symbolic-ref --short HEAD": { status: 0, stdout: "main\n" },
    "git fetch --quiet origin main": { status: 0 },
    "git rev-parse origin/main": { status: 0, stdout: `${NEW}\n` },
    [`git merge-base --is-ancestor HEAD origin/main`]: { status: 0 },
    [`git rev-list --count ${OLD}..${NEW}`]: { status: 0, stdout: "3\n" },
    [`git diff --name-only ${OLD} ${NEW} -- templates/hermes src/hermes src/config/shipped.ts`]: {
      status: 0,
      stdout: "",
    },
    "npm ci": { status: 0 },
    "npm run build": { status: 0 },
    "node cli hermes sync": { status: 0 },
    ...overrides,
  };
  const run: UpdateRun = (command, args) => {
    const line = [command, ...args].join(" ");
    calls.push(line);
    if (line === "git rev-parse HEAD") return { status: 0, stdout: `${head}\n` };
    if (line === "git merge --ff-only origin/main") {
      head = NEW;
      return { status: 0, stdout: "" };
    }
    if (line === `git reset --quiet --hard ${OLD}`) {
      head = OLD;
      return { status: 0, stdout: "" };
    }
    // A second npm run on the old commit, after a rollback, succeeds unless told otherwise.
    if (head === OLD && (line === "npm ci" || line === "npm run build")) {
      return { status: answers[`rollback ${line}`]?.status ?? 0, stdout: "" };
    }
    const answer = answers[line];
    if (answer === undefined) throw new Error(`unexpected command: ${line}`);
    return { status: answer.status, stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" };
  };
  return { run, calls };
}

function options(run: UpdateRun, extra: { hermes?: boolean; starts?: boolean[] } = {}) {
  const log: string[] = [];
  let restarts = 0;
  const starts = [...(extra.starts ?? [])];
  return {
    log,
    restarts: () => restarts,
    options: {
      root: "/checkout",
      git: "git",
      npm: ["npm"],
      node: "node",
      cli: "cli",
      hermes: extra.hermes ?? false,
      run,
      restart: () => {
        restarts += 1;
        return Promise.resolve(starts.shift() ?? true);
      },
      log: (line: string) => log.push(line),
    },
  };
}

describe("update", () => {
  it("fast-forwards to origin/main, installs, builds, and restarts the service", async () => {
    const { run, calls } = fake();
    const t = options(run);

    expect(await update(t.options)).toBe(0);
    expect(calls).toEqual(
      expect.arrayContaining(["git merge --ff-only origin/main", "npm ci", "npm run build"]),
    );
    expect(calls.indexOf("npm ci")).toBeLessThan(calls.indexOf("npm run build"));
    expect(calls.indexOf("git merge --ff-only origin/main")).toBeLessThan(calls.indexOf("npm ci"));
    expect(t.restarts()).toBe(1);
    expect(t.log.join("\n")).toMatch(/aaaaaaa.*bbbbbbb.*3 commits/s);
    // No Hermes file changed, so no sync.
    expect(calls).not.toContain("node cli hermes sync");
  });

  it("refuses and changes nothing when the checkout has uncommitted changes", async () => {
    const { run, calls } = fake({
      "git status --porcelain --untracked-files=no": { status: 0, stdout: " M src/cli.ts\n" },
    });
    const t = options(run);

    expect(await update(t.options)).toBe(1);
    expect(t.log.join("\n")).toMatch(/uncommitted changes/);
    expect(calls).not.toContain("git merge --ff-only origin/main");
    expect(calls).not.toContain("npm ci");
    expect(t.restarts()).toBe(0);
  });

  it("refuses when the checkout cannot fast-forward, or is not on main", async () => {
    const diverged = fake({ "git merge-base --is-ancestor HEAD origin/main": { status: 1 } });
    const a = options(diverged.run);
    expect(await update(a.options)).toBe(1);
    expect(a.log.join("\n")).toMatch(/cannot fast-forward/);
    expect(diverged.calls).not.toContain("git merge --ff-only origin/main");

    const branch = fake({ "git symbolic-ref --short HEAD": { status: 0, stdout: "work\n" } });
    const b = options(branch.run);
    expect(await update(b.options)).toBe(1);
    expect(b.log.join("\n")).toMatch(/on branch work, not main/);

    const offline = fake({ "git fetch --quiet origin main": { status: 128 } });
    const c = options(offline.run);
    expect(await update(c.options)).toBe(1);
    expect(c.log.join("\n")).toMatch(/could not fetch/);
    expect(a.restarts() + b.restarts() + c.restarts()).toBe(0);
  });

  it("does nothing when the checkout is already at origin/main", async () => {
    const { run, calls } = fake({ "git rev-parse origin/main": { status: 0, stdout: `${OLD}\n` } });
    const t = options(run);

    expect(await update(t.options)).toBe(0);
    expect(t.log.join("\n")).toMatch(/already up to date/i);
    expect(calls).not.toContain("npm ci");
    expect(t.restarts()).toBe(0);
  });

  it("rolls back to the old commit and rebuilds it when the install or the build fails", async () => {
    for (const failing of ["npm ci", "npm run build"]) {
      const { run, calls } = fake({ [failing]: { status: 1 } });
      const t = options(run);

      expect(await update(t.options)).toBe(1);
      expect(t.restarts()).toBe(0);
      expect(calls).toContain(`git reset --quiet --hard ${OLD}`);
      expect(calls.slice(calls.indexOf(`git reset --quiet --hard ${OLD}`))).toEqual([
        `git reset --quiet --hard ${OLD}`,
        "npm ci",
        "npm run build",
      ]);
      expect(t.log.join("\n")).toMatch(/did not restart.*rolled back to aaaaaaa/s);
    }
  });

  it("says so when the rollback cannot rebuild the old commit either", async () => {
    const { run } = fake({ "npm ci": { status: 1 }, "rollback npm ci": { status: 1 } });
    const t = options(run);

    expect(await update(t.options)).toBe(1);
    expect(t.restarts()).toBe(0);
    expect(t.log.join("\n")).toMatch(/could not rebuild aaaaaaa/);
  });

  it("rolls back and restarts the old build when the new one does not start", async () => {
    const { run, calls } = fake();
    const t = options(run, { starts: [false, true] });

    expect(await update(t.options)).toBe(1);
    expect(t.restarts()).toBe(2);
    expect(calls).toContain(`git reset --quiet --hard ${OLD}`);
    expect(t.log.join("\n")).toMatch(/did not start.*rolled back to aaaaaaa/s);
  });

  it("names the cause when the fetch fails", async () => {
    const { run } = fake({
      "git fetch --quiet origin main": { status: 128, stderr: "fatal: unable to access" },
    });
    const t = options(run);

    expect(await update(t.options)).toBe(1);
    expect(t.log.join("\n")).toMatch(/could not fetch main from origin: fatal: unable to access/);
  });

  it("syncs the factory Hermes root when the files that sync installs changed", async () => {
    const { run, calls } = fake({
      [`git diff --name-only ${OLD} ${NEW} -- templates/hermes src/hermes src/config/shipped.ts`]: {
        status: 0,
        stdout: "templates/hermes/plugin/hephaestus/__init__.py\n",
      },
    });
    const t = options(run, { hermes: true });

    expect(await update(t.options)).toBe(0);
    expect(calls.indexOf("node cli hermes sync")).toBeGreaterThan(calls.indexOf("npm run build"));
    expect(t.restarts()).toBe(1);
  });
});

describe("serviceProgram", () => {
  it("reads the node and CLI paths from the unit's ExecStart, quotes and all", () => {
    const unit = [
      "[Service]",
      'ExecStart=:"/usr/bin/node" "/home/me/Factory \\"Tools\\"/dist/cli.js" "serve"',
    ].join("\n");
    expect(serviceProgram(unit)).toEqual({
      node: "/usr/bin/node",
      cli: '/home/me/Factory "Tools"/dist/cli.js',
    });
    expect(serviceProgram("[Service]\n")).toBeUndefined();
  });
});
