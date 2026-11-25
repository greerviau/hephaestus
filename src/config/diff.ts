import { isDeepStrictEqual } from "node:util";

/** One changed leaf. `undefined` means the path is absent on that side. */
export interface Change {
  path: string[];
  before: unknown;
  after: unknown;
}

/** Sets an own, enumerable property, so a key such as `__proto__` stays plain data. */
export function defineOwn(object: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(object, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/** An own property's value; inherited members such as `constructor` count as absent. */
function own(object: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

/** Whether `a` and `b` name the same path or one contains the other. */
export function overlaps(a: string[], b: string[]): boolean {
  const length = Math.min(a.length, b.length);
  return a.slice(0, length).every((key, index) => key === b[index]);
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
    return keys.flatMap((key) => diffValues(own(before, key), own(after, key), [...path, key]));
  }
  return isDeepStrictEqual(before, after) ? [] : [{ path, before, after }];
}

export function getAt(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isPlainObject(current)) return undefined;
    current = own(current, key);
  }
  return current;
}

/** Sets a path in place, creating objects on the way; `undefined` deletes the key. */
export function setAt(root: Record<string, unknown>, path: string[], value: unknown): void {
  let current = root;
  for (const key of path.slice(0, -1)) {
    const next = own(current, key);
    if (isPlainObject(next)) {
      current = next;
    } else {
      const created: Record<string, unknown> = {};
      defineOwn(current, key, created);
      current = created;
    }
  }
  const last = path.at(-1);
  if (last === undefined) return;
  if (value === undefined) Reflect.deleteProperty(current, last);
  else defineOwn(current, last, structuredClone(value));
}
