import {
  createHash,
  randomBytes,
  scrypt,
  scryptSync,
  timingSafeEqual,
  type ScryptOptions,
} from "node:crypto";
import type { Database } from "better-sqlite3";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MIN_PASSWORD_LENGTH = 12;
/** Keeps the URL-encoded login form well under the server's request size limit. */
export const MAX_PASSWORD_LENGTH = 256;

const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;
const KEY_LENGTH = 32;
const PASSWORD_KEY = "dashboard_password_hash";

/** Returns `scrypt$N$r$p$<salt>$<key>` with base64url salt and key. */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = scryptSync(password, salt, KEY_LENGTH, SCRYPT);
  return [
    "scrypt",
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

function scryptAsync(
  password: string,
  salt: Buffer,
  length: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, length, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SALT_LENGTH = 16;

/**
 * Checks a password off the main thread. A stored hash that does not match the
 * exact format `hashPassword` writes, including the salt and key lengths and
 * scrypt parameters, never matches.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 6) return false;
  const [scheme, n, r, p, salt = "", key = ""] = parts;
  if (scheme !== "scrypt" || !BASE64URL.test(salt) || !BASE64URL.test(key)) return false;
  if (n !== String(SCRYPT.N) || r !== String(SCRYPT.r) || p !== String(SCRYPT.p)) return false;
  const saltBytes = Buffer.from(salt, "base64url");
  const expected = Buffer.from(key, "base64url");
  if (saltBytes.length !== SALT_LENGTH || expected.length !== KEY_LENGTH) return false;
  try {
    const actual = await scryptAsync(password, saltBytes, KEY_LENGTH, SCRYPT);
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function writePasswordHash(db: Database, hash: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(PASSWORD_KEY, hash);
}

export function readPasswordHash(db: Database): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(PASSWORD_KEY) as
    { value: string } | undefined;
  return row?.value;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Dashboard sessions. The database holds only SHA-256 hashes of the tokens. */
export class Sessions {
  constructor(
    private readonly db: Database,
    private readonly now: () => number = Date.now,
  ) {}

  create(): string {
    const token = randomBytes(32).toString("base64url");
    const createdAt = this.now();
    this.db
      .prepare("INSERT INTO sessions (token_hash, created_at, expires_at) VALUES (?, ?, ?)")
      .run(hashToken(token), createdAt, createdAt + SESSION_TTL_MS);
    return token;
  }

  isValid(token: string): boolean {
    const row = this.db
      .prepare("SELECT expires_at FROM sessions WHERE token_hash = ?")
      .get(hashToken(token)) as { expires_at: number } | undefined;
    return row !== undefined && row.expires_at > this.now();
  }

  revoke(token: string): void {
    this.db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
  }
}
