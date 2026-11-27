import { describe, expect, it } from "vitest";
import { openStore } from "../../src/store.js";
import { T3Adapter } from "../../src/t3/adapter.js";
import { mintPairingCode, revokeSessions, signIn, t3Runner } from "../../src/t3/auth.js";
import { T3Connection } from "../../src/t3/connection.js";
import { ThreadEvents } from "../../src/t3/events.js";
import { ThreadFollower } from "../../src/t3/follower.js";
import { FactoryThreads } from "../../src/t3/threads.js";
import { resolveT3Origin } from "../../src/t3/origin.js";

/**
 * Runs against the real T3 server on this host, and launches one short thread
 * on a linked worker. Set HEPHAESTUS_T3_INTEGRATION=1 and
 * HEPHAESTUS_T3_WORKER=<environment id> to run it. It signs in with a fresh
 * pairing code, archives its thread, and revokes its session at the end.
 */
const worker = process.env.HEPHAESTUS_T3_WORKER;
const enabled = process.env.HEPHAESTUS_T3_INTEGRATION === "1" && worker !== undefined;

describe.runIf(enabled)("T3 integration", () => {
  it(
    "launches a thread on a worker and follows it into the event store",
    { timeout: 300_000 },
    async () => {
      const environmentId = worker ?? "";
      const clientName = `Hephaestus (integration ${String(process.pid)})`;
      const runT3 = t3Runner();
      const origin = resolveT3Origin(process.env, process.env.HOME ?? "");
      const token = await signIn(origin, clientName, await mintPairingCode(runT3, clientName));
      const connection = new T3Connection(`${origin}/mcp`, {
        token: () => Promise.resolve(token.accessToken),
        renew: () => Promise.reject(new Error("The integration test does not renew its token.")),
      });
      const t3 = new T3Adapter(connection);
      let threadId: string | undefined;
      try {
        const { environments } = await t3.environments();
        expect(
          environments.find((environment) => environment.environmentId === environmentId),
        ).toMatchObject({
          reachable: true,
        });

        const events = new ThreadEvents(openStore(":memory:"));
        threadId = await new FactoryThreads(t3, events).launch(
          {
            environmentId,
            title: "Hephaestus integration test",
            providerInstanceId: "claudeAgent",
            model: "claude-sonnet-5-5",
            options: [{ id: "effort", value: "low" }],
            runtimeMode: "full-access",
            message:
              'Run `echo hephaestus` as a shell command, then end your reply with exactly:\n```hephaestus-result\n{"ok": true}\n```',
            clientRequestId: `hephaestus-integration-${String(process.pid)}`,
          },
          { configVersion: 0, taskId: null },
        );
        expect(events.thread(environmentId, threadId)?.status).toBe("starting");
        const follower = new ThreadFollower(t3, events, { waitMs: 15_000 });
        for (let round = 0; round < 20 && events.following().length > 0; round += 1) {
          await follower.followAll();
        }

        expect(events.thread(environmentId, threadId)?.status).toBe("completed");
        const items = events.items(environmentId, threadId);
        expect(
          items.some((item) => item.type === "command_execution" && item.status === "completed"),
        ).toBe(true);
        const replies = items.filter((item) => item.type === "assistant_message");
        expect(replies.at(-1)?.text).toContain("hephaestus-result");
      } finally {
        if (threadId !== undefined)
          await t3.archive(environmentId, threadId).catch(() => undefined);
        await connection.close();
        await revokeSessions(runT3, clientName);
      }
    },
  );
});
