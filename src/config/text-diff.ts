type Op = { kind: " " | "-" | "+"; text: string };

/** Above this many cells the line-by-line comparison is skipped and the changed block is shown whole. */
const MAX_CELLS = 4_000_000;

function lines(text: string): string[] {
  return text === "" ? [] : text.split("\n");
}

/** Edit script between two line lists: common prefix and suffix first, then a longest common subsequence of what is left. */
function edits(before: string[], after: string[]): Op[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  const head: Op[] = before.slice(0, start).map((text) => ({ kind: " ", text }));
  const tail: Op[] = before.slice(endBefore).map((text) => ({ kind: " ", text }));
  const a = before.slice(start, endBefore);
  const b = after.slice(start, endAfter);
  const middle: Op[] = [];
  if (a.length * b.length > MAX_CELLS) {
    middle.push(...a.map((text): Op => ({ kind: "-", text })));
    middle.push(...b.map((text): Op => ({ kind: "+", text })));
  } else {
    // table[i][j] is the length of the longest common subsequence of a[i..] and b[j..].
    const table = Array.from({ length: a.length + 1 }, () =>
      new Array<number>(b.length + 1).fill(0),
    );
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        const row = table[i];
        const below = table[i + 1];
        if (row === undefined || below === undefined) continue;
        row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (i < a.length && j < b.length && a[i] === b[j]) {
        middle.push({ kind: " ", text: a[i] ?? "" });
        i++;
        j++;
      } else if (
        j >= b.length ||
        (i < a.length && (table[i + 1]?.[j] ?? 0) >= (table[i]?.[j + 1] ?? 0))
      ) {
        middle.push({ kind: "-", text: a[i] ?? "" });
        i++;
      } else {
        middle.push({ kind: "+", text: b[j] ?? "" });
        j++;
      }
    }
  }
  return [...head, ...middle, ...tail];
}

/**
 * A unified diff of two texts, with three lines of context. `before` is
 * undefined for a file that does not exist yet. Returns "" when nothing changed.
 */
export function unifiedDiff(
  before: string | undefined,
  after: string | undefined,
  label: string,
  context = 3,
): string {
  if (before === after) return "";
  const ops = edits(lines(before ?? ""), lines(after ?? ""));
  const header = [
    `--- ${before === undefined ? "/dev/null" : `before/${label}`}`,
    `+++ ${after === undefined ? "/dev/null" : `after/${label}`}`,
  ];
  const changed = ops.flatMap((op, index) => (op.kind === " " ? [] : [index]));
  const hunks: [number, number][] = [];
  for (const index of changed) {
    const from = Math.max(0, index - context);
    const to = Math.min(ops.length - 1, index + context);
    const last = hunks.at(-1);
    if (last !== undefined && from <= last[1] + 1) last[1] = Math.max(last[1], to);
    else hunks.push([from, to]);
  }
  const body: string[] = [];
  for (const [from, to] of hunks) {
    let beforeLine = 1;
    let afterLine = 1;
    for (const op of ops.slice(0, from)) {
      if (op.kind !== "+") beforeLine++;
      if (op.kind !== "-") afterLine++;
    }
    const slice = ops.slice(from, to + 1);
    const beforeCount = slice.filter((op) => op.kind !== "+").length;
    const afterCount = slice.filter((op) => op.kind !== "-").length;
    body.push(
      `@@ -${String(beforeCount === 0 ? beforeLine - 1 : beforeLine)},${String(beforeCount)} +${String(afterCount === 0 ? afterLine - 1 : afterLine)},${String(afterCount)} @@`,
    );
    for (const op of slice) body.push(`${op.kind}${op.text}`);
  }
  return [...header, ...body].join("\n");
}
