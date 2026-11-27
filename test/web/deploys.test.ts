import { describe, expect, it } from "vitest";
import { BackgroundDeploys } from "../../src/web/deploys.js";

function gate(): { open: () => void; wait: Promise<void> } {
  let open: () => void = () => undefined;
  const wait = new Promise<void>((done) => {
    open = done;
  });
  return { open, wait };
}

describe("BackgroundDeploys", () => {
  it("starts a deploy without waiting for it, and reports it running", async () => {
    const held = gate();
    const deploys = new BackgroundDeploys(() => held.wait.then(() => ({})));

    deploys.start(3);

    expect(deploys.status()).toEqual({ running: { version: 3, queued: 0 } });
    held.open();
    await deploys.settled();
    expect(deploys.status()).toEqual({ last: { version: 3, outcome: "succeeded" } });
  });

  it("runs deploys one after another, never overlapping", async () => {
    const held = [gate(), gate()];
    const events: string[] = [];
    const deploys = new BackgroundDeploys(async (id) => {
      events.push(`start ${String(id)}`);
      await held[id - 1]?.wait;
      events.push(`end ${String(id)}`);
      return {};
    });

    deploys.start(1);
    deploys.start(2);

    expect(events).toEqual(["start 1"]);
    expect(deploys.status().running).toEqual({ version: 1, queued: 1 });
    held[0]?.open();
    held[1]?.open();
    await deploys.settled();
    expect(events).toEqual(["start 1", "end 1", "start 2", "end 2"]);
  });

  it("deploys a version once however often it is started", async () => {
    const held = gate();
    const seen: number[] = [];
    const deploys = new BackgroundDeploys((id) => {
      seen.push(id);
      return held.wait.then(() => ({}));
    });

    deploys.start(1);
    deploys.start(1);
    deploys.start(2);
    deploys.start(2);
    held.open();
    await deploys.settled();

    expect(seen).toEqual([1, 2]);
  });

  it("keeps a failure in the status, and clears it once a later deploy succeeds", async () => {
    let fail = true;
    const deploys = new BackgroundDeploys(() =>
      fail ? Promise.reject(new Error("push failed")) : Promise.resolve({}),
    );

    deploys.start(1);
    await deploys.settled();
    expect(deploys.status()).toEqual({ last: { version: 1, outcome: "failed" } });

    fail = false;
    deploys.start(1);
    await deploys.settled();
    expect(deploys.status()).toEqual({ last: { version: 1, outcome: "succeeded" } });
  });

  it("keeps going after a failure, and says when only the Hermes root was not updated", async () => {
    const deploys = new BackgroundDeploys((id) =>
      id === 1 ? Promise.reject(new Error("x")) : Promise.resolve({ hermesError: "no sync" }),
    );

    deploys.start(1);
    deploys.start(2);
    await deploys.settled();

    expect(deploys.status()).toEqual({ last: { version: 2, outcome: "hermes-failed" } });
  });

  it("stops showing a success after a while, but not a failure", async () => {
    let now = 0;
    const ok = new BackgroundDeploys(
      () => Promise.resolve({}),
      () => now,
    );
    ok.start(1);
    await ok.settled();
    now = 31_000;
    expect(ok.status()).toEqual({});

    const bad = new BackgroundDeploys(
      () => Promise.reject(new Error("x")),
      () => now,
    );
    bad.start(1);
    await bad.settled();
    now = 10 * 60_000;
    expect(bad.status()).toEqual({ last: { version: 1, outcome: "failed" } });
  });
});
