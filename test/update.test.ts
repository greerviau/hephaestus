import { describe, expect, it } from "vitest";
import { serviceProgram, update, type UpdateRun } from "../src/update.js";

const OLD = "a".repeat(40);
const NEW = "b".repeat(40);

/** A checkout on main at OLD whose origin/main is at NEW, answering like git and npm would. */
function fake(overrides: Record<string, { status: number; stdout?: string }> = {}): {
  run: UpdateRun;
  calls: string[];
} {
  const calls: string[] = [];
  let head = OLD;
  const answers: Record<string, { status: number; stdout?: string }> = {
    "git status --porcelain --untracked-files=no": { status: 0, stdout: "" },
    "git symbolic-ref --short HEAD": { status: 0, stdout: "main\n" },
    "git fetch --quiet origin main": { status: 0 },
    "git rev-parse origin/main": { status: 0, stdout: `${NEW}\n` },
    [`git merge-base --is-ancestor HEAD origin/main`]: { status: 0 },
    [`git rev-list --count ${OLD}..${NEW}`]: { status: 0, stdout: "3\n" },
    [`git diff --name-only ${OLD} ${NEW} -- templates/hermes src/hermes`]: {
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
    const answer = answers[line];
    if (answer === undefined) throw new Error(`unexpected command: ${line}`);
    return { status: answer.status, stdout: answer.stdout ?? "" };
  };
  return { run, calls };
}

function options(run: UpdateRun, extra: { hermes?: boolean } = {}) {
  const log: string[] = [];
  let restarts = 0;
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
      },
      log: (line: string) => log.push(line),
    },
  };
}

describe("update", () => {
  it("fast-forwards to origin/main, installs, builds, and restarts the service", () => {
    const { run, calls } = fake();
    const t = options(run);

    expect(update(t.options)).toBe(0);
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

  it("refuses and changes nothing when the checkout has uncommitted changes", () => {
    const { run, calls } = fake({
      "git status --porcelain --untracked-files=no": { status: 0, stdout: " M src/cli.ts\n" },
    });
    const t = options(run);

    expect(update(t.options)).toBe(1);
    expect(t.log.join("\n")).toMatch(/uncommitted changes/);
    expect(calls).not.toContain("git merge --ff-only origin/main");
    expect(calls).not.toContain("npm ci");
    expect(t.restarts()).toBe(0);
  });

  it("refuses when the checkout cannot fast-forward, or is not on main", () => {
    const diverged = fake({ "git merge-base --is-ancestor HEAD origin/main": { status: 1 } });
    const a = options(diverged.run);
    expect(update(a.options)).toBe(1);
    expect(a.log.join("\n")).toMatch(/cannot fast-forward/);
    expect(diverged.calls).not.toContain("git merge --ff-only origin/main");

    const branch = fake({ "git symbolic-ref --short HEAD": { status: 0, stdout: "work\n" } });
    const b = options(branch.run);
    expect(update(b.options)).toBe(1);
    expect(b.log.join("\n")).toMatch(/on branch work, not main/);

    const offline = fake({ "git fetch --quiet origin main": { status: 128 } });
    const c = options(offline.run);
    expect(update(c.options)).toBe(1);
    expect(c.log.join("\n")).toMatch(/could not fetch/);
    expect(a.restarts() + b.restarts() + c.restarts()).toBe(0);
  });

  it("does nothing when the checkout is already at origin/main", () => {
    const { run, calls } = fake({ "git rev-parse origin/main": { status: 0, stdout: `${OLD}\n` } });
    const t = options(run);

    expect(update(t.options)).toBe(0);
    expect(t.log.join("\n")).toMatch(/already up to date/i);
    expect(calls).not.toContain("npm ci");
    expect(t.restarts()).toBe(0);
  });

  it("leaves the old build running when the install or the build fails, and says so", () => {
    for (const failing of ["npm ci", "npm run build"]) {
      const { run } = fake({ [failing]: { status: 1 } });
      const t = options(run);

      expect(update(t.options)).toBe(1);
      expect(t.restarts()).toBe(0);
      expect(t.log.join("\n")).toMatch(/did not restart.*still runs the old build/s);
    }
  });

  it("syncs the factory Hermes root when the files that sync installs changed", () => {
    const { run, calls } = fake({
      [`git diff --name-only ${OLD} ${NEW} -- templates/hermes src/hermes`]: {
        status: 0,
        stdout: "templates/hermes/plugin/hephaestus/__init__.py\n",
      },
    });
    const t = options(run, { hermes: true });

    expect(update(t.options)).toBe(0);
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
