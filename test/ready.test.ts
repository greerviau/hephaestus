import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { waitForDashboard } from "../src/ready.js";

let server: Server | undefined;

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running) await new Promise((resolve) => running.close(resolve));
});

async function listen(instanceId: string): Promise<number> {
  server = createServer((_request, response) => {
    response.writeHead(200, { "x-hephaestus-instance": instanceId });
    response.end();
  });
  const running = server;
  await new Promise<void>((resolve) => running.listen(0, "127.0.0.1", resolve));
  return (running.address() as AddressInfo).port;
}

describe("waitForDashboard", () => {
  it("resolves when this install's dashboard answers on the port", async () => {
    const port = await listen("mine");

    await expect(
      waitForDashboard({ host: "0.0.0.0", port, instanceId: "mine" }, { timeoutMs: 2000 }),
    ).resolves.toBeUndefined();
  });

  it("rejects when another server holds the port", async () => {
    const port = await listen("someone-else");

    await expect(
      waitForDashboard({ host: "0.0.0.0", port, instanceId: "mine" }, { timeoutMs: 500 }),
    ).rejects.toThrow(/did not answer on port/);
  });

  it("rejects when nothing listens", async () => {
    const port = await listen("closing");
    await new Promise((resolve) => server?.close(resolve));
    server = undefined;

    await expect(
      waitForDashboard({ host: "0.0.0.0", port, instanceId: "mine" }, { timeoutMs: 500 }),
    ).rejects.toThrow(/did not answer on port/);
  });
});
