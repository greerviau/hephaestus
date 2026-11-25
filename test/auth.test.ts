import { describe, expect, it } from "vitest";
import {
  SESSION_TTL_MS,
  Sessions,
  hashPassword,
  readPasswordHash,
  verifyPassword,
  writePasswordHash,
} from "../src/auth.js";
import { openStore } from "../src/store.js";

describe("password hashing", () => {
  it("verifies the right password and rejects others", async () => {
    const stored = hashPassword("correct horse battery");

    expect(stored).not.toContain("correct horse battery");
    expect(await verifyPassword("correct horse battery", stored)).toBe(true);
    expect(await verifyPassword("wrong horse battery", stored)).toBe(false);
  });

  it("salts each hash", () => {
    expect(hashPassword("same password")).not.toBe(hashPassword("same password"));
  });

  it.each(["not-a-hash", "scrypt$0$8$1$c2FsdA$a2V5"])(
    "rejects the malformed stored hash %j",
    async (stored) => {
      expect(await verifyPassword("anything", stored)).toBe(false);
    },
  );

  it("stores only the hash in the state database", async () => {
    const db = openStore(":memory:");
    writePasswordHash(db, hashPassword("correct horse battery"));

    const stored = readPasswordHash(db);

    expect(stored).toBeDefined();
    expect(await verifyPassword("correct horse battery", stored ?? "")).toBe(true);
    db.close();
  });
});

describe("Sessions", () => {
  it("accepts a token it issued until it expires or is revoked", () => {
    const db = openStore(":memory:");
    let now = 1_000_000;
    const sessions = new Sessions(db, () => now);

    const first = sessions.create();
    const second = sessions.create();

    expect(sessions.isValid(first)).toBe(true);
    expect(sessions.isValid("forged")).toBe(false);

    sessions.revoke(first);
    expect(sessions.isValid(first)).toBe(false);

    now += SESSION_TTL_MS;
    expect(sessions.isValid(second)).toBe(false);
    db.close();
  });

  it("stores token hashes, never the tokens", () => {
    const db = openStore(":memory:");
    const token = new Sessions(db).create();

    const rows = db.prepare("SELECT token_hash FROM sessions").all() as { token_hash: string }[];

    expect(rows).toHaveLength(1);
    expect(rows[0]?.token_hash).not.toBe(token);
    db.close();
  });
});
