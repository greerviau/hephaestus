import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { T3Connection, T3ToolError } from "../../src/t3/connection.js";
import { FakeFailure, FakeT3, delay } from "./fake-t3.js";

let fake: FakeT3;

beforeEach(async () => {
  fake = new FakeT3();
  await fake.start();
});

afterEach(async () => {
  await fake.stop();
});

describe("T3Connection", () => {
  it("calls a tool with the bearer token and returns its structured result", async () => {
    fake.tools.set("t3_environment_links", () => ({ environmentId: "local", links: [] }));
    const connection = new T3Connection(fake.url, {
      token: () => Promise.resolve("good-token"),
      renew: () => Promise.resolve(),
    });

    const result = await connection.call("t3_environment_links", {});

    expect(result).toEqual({ environmentId: "local", links: [] });
    await connection.close();
  });

  it("turns an OrchestratorMcpFailure into a T3ToolError with its code", async () => {
    fake.tools.set("t3_thread_read", () => {
      throw new FakeFailure("thread_not_found", "The thread was not found.");
    });
    const connection = new T3Connection(fake.url, {
      token: () => Promise.resolve("good-token"),
      renew: () => Promise.resolve(),
    });

    const error = await connection
      .call("t3_thread_read", { threadId: "x" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(T3ToolError);
    expect(error).toMatchObject({ code: "thread_not_found", tool: "t3_thread_read" });
    await connection.close();
  });

  it("renews the credential once when T3 rejects the token", async () => {
    fake.tools.set("t3_environment_links", () => ({ environmentId: "local", links: [] }));
    let token = "expired-token";
    let renewals = 0;
    const connection = new T3Connection(fake.url, {
      token: () => Promise.resolve(token),
      renew: () => {
        renewals += 1;
        token = "good-token";
        return Promise.resolve();
      },
    });

    await expect(connection.call("t3_environment_links", {})).resolves.toMatchObject({
      environmentId: "local",
    });
    expect(renewals).toBe(1);
    await connection.close();
  });

  it("gives up when a renewed token is also rejected", async () => {
    const connection = new T3Connection(fake.url, {
      token: () => Promise.resolve("bad-token"),
      renew: () => Promise.resolve(),
    });

    await expect(connection.call("t3_environment_links", {})).rejects.toThrow(/401|rejected/i);
    await connection.close();
  });
});

describe("T3Connection under load", () => {
  it("shares one connection and one renewal between concurrent calls", async () => {
    fake.tools.set("t3_environment_links", () => ({ environmentId: "local", links: [] }));
    let token = "expired-token";
    let tokens = 0;
    let renewals = 0;
    const connection = new T3Connection(fake.url, {
      token: () => {
        tokens += 1;
        return Promise.resolve(token);
      },
      renew: async () => {
        renewals += 1;
        await delay(20);
        token = "good-token";
      },
    });

    await Promise.all([1, 2, 3].map(() => connection.call("t3_environment_links", {})));

    expect(renewals).toBe(1);
    expect(tokens).toBeLessThanOrEqual(2);
    await connection.close();
  });

  it("aborts calls still waiting when it closes", async () => {
    fake.tools.set("t3_thread_wait", async () => {
      await delay(5_000);
      return {};
    });
    const connection = new T3Connection(fake.url, {
      token: () => Promise.resolve("good-token"),
      renew: () => Promise.resolve(),
    });
    await connection.call("t3_environment_links", {}).catch(() => undefined);

    const started = Date.now();
    const waiting = connection
      .call("t3_thread_wait", { threadId: "t" })
      .catch((error: unknown) => error);
    await delay(100);
    await connection.close();

    expect(await waiting).toBeInstanceOf(Error);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("resolves the server URL each time it connects", async () => {
    fake.tools.set("t3_environment_links", () => ({ environmentId: "local", links: [] }));
    let resolved = 0;
    const connection = new T3Connection(
      () => {
        resolved += 1;
        return fake.url;
      },
      { token: () => Promise.resolve("good-token"), renew: () => Promise.resolve() },
    );

    await connection.call("t3_environment_links", {});
    expect(resolved).toBe(1);
    await connection.close();
  });
});
