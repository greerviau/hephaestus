import { escapeHtml, fold } from "./html.js";

/**
 * Charts drawn on the server as SVG: one value axis, a recessive grid, and
 * a hatched series so that no series depends on hue alone. Nothing here
 * answers a hover, because that needs a script; `tableFold` holds the exact
 * numbers.
 */

export interface Series {
  name: string;
  values: number[];
  /** A CSS color, such as `var(--series-1)`. */
  color: string;
  hatch?: boolean;
}

function plain(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A round axis maximum and step that fit `max`, with four or five gridlines. */
function axis(max: number, integer: boolean): { max: number; step: number } {
  if (max <= 0) return { max: 4, step: 1 };
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  let step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;
  if (integer) step = Math.max(1, Math.ceil(step));
  return { max: Math.ceil(max / step) * step, step };
}

function gridline(left: number, width: number, y: number, value: number): string {
  return `<line x1="${String(left)}" x2="${String(width)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${value === 0 ? "var(--axis)" : "var(--grid)"}"/><text x="${String(left - 8)}" y="${(y + 4).toFixed(1)}" text-anchor="end">${plain(Number(value.toFixed(2)))}</text>`;
}

/** Which labels to print so they do not collide: evenly spaced, always the last. */
function labelIndexes(count: number, plotWidth: number, minGap: number): Set<number> {
  const every = Math.ceil(count / Math.max(1, Math.floor(plotWidth / minGap)));
  const keep: number[] = [];
  for (let index = 0; index < count; index += every) keep.push(index);
  const last = keep.at(-1);
  if (last !== undefined && last !== count - 1) {
    if (count - 1 - last < every) keep.pop();
    keep.push(count - 1);
  }
  return new Set(keep);
}

function hatchFill(color: string): string {
  return `repeating-linear-gradient(45deg,${color} 0 3px,var(--bg) 3px 5px)`;
}

export interface ColumnsOptions {
  /** Unique on the page; names the hatch pattern. */
  id: string;
  labels: string[];
  /** Whole-number counts, stacked from the first series up. */
  series: Series[];
  /** What the chart shows, for screen readers. */
  aria: string;
  /** Names the region that scrolls sideways on a narrow screen. */
  region: string;
}

/** Stacked columns, one per label, in a region that scrolls sideways when the screen is narrow. */
export function columns(options: ColumnsOptions): string {
  const width = 860;
  const height = 220;
  const left = 32;
  const top = 8;
  const bottom = 24;
  const plotHeight = height - top - bottom;
  const count = options.labels.length;
  const totals = options.labels.map((_, index) =>
    options.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
  );
  const scale = axis(Math.max(0, ...totals), true);
  const band = (width - left) / Math.max(1, count);
  const barWidth = Math.min(32, band * 0.6);
  const shown = labelIndexes(count, width - left, 56);
  const hatchId = `hatch-${options.id}`;
  const hatched = options.series.find((series) => series.hatch === true);
  const parts: string[] = [
    hatched === undefined
      ? ""
      : `<defs><pattern id="${escapeHtml(hatchId)}" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="${hatched.color}"/><rect width="2" height="6" fill="var(--bg)"/></pattern></defs>`,
  ];
  for (let value = 0; value <= scale.max + 1e-9; value += scale.step) {
    parts.push(gridline(left, width, top + plotHeight - (value / scale.max) * plotHeight, value));
  }
  options.labels.forEach((label, index) => {
    const x = left + band * index + (band - barWidth) / 2;
    let y = top + plotHeight;
    for (const series of options.series) {
      const barHeight = ((series.values[index] ?? 0) / scale.max) * plotHeight;
      if (barHeight <= 0) continue;
      y -= barHeight;
      // A 1px gap keeps stacked segments apart without leaning on their colors.
      parts.push(
        `<rect x="${x.toFixed(1)}" y="${(y + 1).toFixed(1)}" width="${barWidth.toFixed(1)}" height="${Math.max(1, barHeight - 1).toFixed(1)}" rx="2" fill="${series.hatch === true ? `url(#${escapeHtml(hatchId)})` : series.color}"/>`,
      );
    }
    if (shown.has(index)) {
      const last = index === count - 1 && count > 1;
      parts.push(
        `<text x="${(last ? x + barWidth : x + barWidth / 2).toFixed(1)}" y="${String(height - 6)}" text-anchor="${last ? "end" : "middle"}">${escapeHtml(label)}</text>`,
      );
    }
  });
  return `<div class="chart-scroll" tabindex="0" role="region" aria-label="${escapeHtml(options.region)}"><div class="chart"><svg class="wide" viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${escapeHtml(options.aria)}">${parts.join("")}</svg></div></div>`;
}

export interface LineOptions {
  labels: string[];
  /** null means no reading for that label, which breaks the line. */
  values: (number | null)[];
  /** A CSS color. */
  color: string;
  /** What the chart shows, for screen readers. */
  aria: string;
  /** Counts: the axis ticks stay whole numbers. */
  integer?: boolean;
}

/** A small trend line with the first and last labels under it. */
export function line(options: LineOptions): string {
  const width = 280;
  const height = 120;
  const left = 32;
  const top = 8;
  const bottom = 20;
  const plotHeight = height - top - bottom;
  const plotWidth = width - left - 8;
  const count = options.values.length;
  const readings = options.values.filter((value): value is number => value !== null);
  let max = axis(Math.max(0, ...readings), options.integer === true).max;
  // The middle tick is half the maximum, so a count's maximum must be even.
  if (options.integer === true && max % 2 === 1) max += 1;
  const x = (index: number): number =>
    left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number): number => top + plotHeight - (value / max) * plotHeight;
  const parts = [0, max / 2, max].map((value) => gridline(left, width, y(value), value));
  let path = "";
  let pen = "M";
  const dots: string[] = [];
  options.values.forEach((value, index) => {
    if (value === null) {
      pen = "M";
      return;
    }
    path += `${pen}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
    pen = "L";
    // A reading with no reading on either side has no line segment, so it needs a mark of its own.
    if (
      (options.values[index - 1] ?? null) === null &&
      (options.values[index + 1] ?? null) === null
    ) {
      dots.push(
        `<circle cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="3" fill="${options.color}"/>`,
      );
    }
  });
  if (path !== "") {
    parts.push(
      `<path d="${path}" fill="none" stroke="${options.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
  }
  parts.push(...dots);
  const first = options.labels[0];
  const last = options.labels.at(-1);
  if (first !== undefined) {
    parts.push(`<text x="${String(left)}" y="${String(height - 4)}">${escapeHtml(first)}</text>`);
  }
  if (last !== undefined && count > 1) {
    parts.push(
      `<text x="${String(width)}" y="${String(height - 4)}" text-anchor="end">${escapeHtml(last)}</text>`,
    );
  }
  return `<div class="chart"><svg viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="${escapeHtml(options.aria)}">${parts.join("")}</svg></div>`;
}

/** The chart's key: each series' swatch, its name, and its total. */
export function legend(series: readonly (Series & { total: number })[]): string {
  return `<ul class="legend">${series
    .map(
      (item) =>
        `<li><span class="key" style="background:${item.hatch === true ? hatchFill(item.color) : item.color}"></span>${escapeHtml(item.name)} ${String(item.total)}</li>`,
    )
    .join("")}</ul>`;
}

/**
 * The charts' numbers as one folded table in a scroll region the keyboard
 * can reach. The first column is each row's header; the rest are right
 * aligned. Every cell is escaped.
 */
export function tableFold(
  summary: string,
  label: string,
  head: readonly string[],
  rows: readonly (readonly string[])[],
): string {
  const headCells = head
    .map(
      (cell, index) => `<th scope="col"${index === 0 ? "" : ' class="r"'}>${escapeHtml(cell)}</th>`,
    )
    .join("");
  const body = rows
    .map(
      (cells) =>
        `<tr>${cells
          .map((cell, index) =>
            index === 0
              ? `<th scope="row">${escapeHtml(cell)}</th>`
              : `<td class="r">${escapeHtml(cell)}</td>`,
          )
          .join("")}</tr>`,
    )
    .join("\n");
  return fold(
    summary,
    `<div class="table-region" tabindex="0" role="region" aria-label="${escapeHtml(label)}"><table><thead><tr>${headCells}</tr></thead><tbody>
${body}
</tbody></table></div>`,
  );
}
