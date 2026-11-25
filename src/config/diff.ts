import { isDeepStrictEqual } from "node:util";

/** One changed leaf. `undefined` means the path is absent on that side. */
export interface Change {
  path: string[];
  before: unknown;
  after: unknown;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Lists every changed path between two JSON values, sorted by path. Objects
 * present on both sides are compared key by key; anything else, including
 * arrays, is compared whole.
 */
export function diffValues(before: unknown, after: unknown, path: string[] = []): Change[] {
  if (isPlainObject(before) && isPlainObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((key) => diffValues(before[key], after[key], [...path, key]));
  }
  return isDeepStrictEqual(before, after) ? [] : [{ path, before, after }];
}

export function getAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** Sets a path in place, creating objects on the way; `undefined` deletes the key. */
export function setAt(root: Record<string, unknown>, path: string[], value: unknown): void {
  let current = root;
  for (const key of path.slice(0, -1)) {
    const next = current[key];
    if (isPlainObject(next)) {
      current = next;
    } else {
      const created: Record<string, unknown> = {};
      current[key] = created;
      current = created;
    }
  }
  const last = path.at(-1);
  if (last === undefined) return;
  if (value === undefined) Reflect.deleteProperty(current, last);
  else current[last] = structuredClone(value);
}
