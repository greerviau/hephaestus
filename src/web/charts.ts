import { escapeHtml, table } from "./html.js";

/**
 * Charts drawn on the server as SVG, in the mockup's style: one value axis,
 * a recessive grid, the second series hatched so it never depends on hue
 * alone, and a table under each chart with the same numbers. Hovering a
 * column or point shows its values through SVG titles, with no script.
 */

export interface Series {
  name: string;
  /** null means no reading for that label. */
  values: (number | null)[];
  /** A CSS color, such as `var(--series-1)`. */
  color: string;
  hatch?: boolean;
}

export interface ChartOptions {
  /** Unique on the page; names the hatch pattern. */
  id: string;
  labels: string[];
  series: Series[];
  /** What the chart shows, for screen readers. */
  aria: string;
  height?: number;
  format?: (value: number) => string;
}

const WIDTH = 720;

function plain(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** A round axis maximum and step that fit `max`, with four or five gridlines. */
export function axis(max: number): { max: number; step: number } {
  if (max <= 0) return { max: 4, step: 1 };
  const rough = max / 4;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * magnitude).find((s) => s >= rough) ?? rough;
  return { max: Math.ceil(max / step) * step, step };
}

function grid(
  scale: { max: number; step: number },
  left: number,
  top: number,
  plotHeight: number,
  format: (value: number) => string,
): string {
  const lines: string[] = [];
  for (let value = 0; value <= scale.max + 1e-9; value += scale.step) {
    const y = top + plotHeight - (value / scale.max) * plotHeight;
    lines.push(
      `<line x1="${String(left)}" x2="${String(WIDTH)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${value === 0 ? "var(--axis)" : "var(--grid)"}" stroke-width="1"/><text x="${String(left - 8)}" y="${(y + 4).toFixed(1)}" text-anchor="end">${escapeHtml(format(Number(value.toFixed(2))))}</text>`,
    );
  }
  return lines.join("");
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

function roundedTop(x: number, y: number, width: number, height: number, radius: number): string {
  if (radius === 0 || height < radius)
    return `M${x.toFixed(1)},${y.toFixed(1)}h${width.toFixed(1)}v${height.toFixed(1)}h${(-width).toFixed(1)}z`;
  return `M${x.toFixed(1)},${(y + height).toFixed(1)}V${(y + radius).toFixed(1)}Q${x.toFixed(1)},${y.toFixed(1)} ${(x + radius).toFixed(1)},${y.toFixed(1)}H${(x + width - radius).toFixed(1)}Q${(x + width).toFixed(1)},${y.toFixed(1)} ${(x + width).toFixed(1)},${(y + radius).toFixed(1)}V${(y + height).toFixed(1)}z`;
}

function tooltip(options: ChartOptions, index: number): string {
  const format = options.format ?? plain;
  return `${options.labels[index] ?? ""}: ${options.series
    .map((series) => {
      const value = series.values[index];
      return `${series.name} ${value === null || value === undefined ? "no reading" : format(value)}`;
    })
    .join(", ")}`;
}

function svgOpen(options: ChartOptions, height: number): string {
  return `<div class="chart graph-scroll"><svg class="plot" viewBox="0 0 ${String(WIDTH)} ${String(height)}" role="img" aria-label="${escapeHtml(options.aria)}">`;
}

/** Stacked columns, one per label. */
export function columns(options: ChartOptions): string {
  const height = options.height ?? 220;
  const left = 36;
  const top = 8;
  const bottom = 28;
  const plotHeight = height - top - bottom;
  const plotWidth = WIDTH - left;
  const count = options.labels.length;
  const totals = options.labels.map((_, index) =>
    options.series.reduce((sum, series) => sum + (series.values[index] ?? 0), 0),
  );
  const scale = axis(Math.max(0, ...totals));
  const band = plotWidth / Math.max(1, count);
  const barWidth = Math.min(24, band * 0.6);
  const hatchId = `hatch-${options.id}`;
  const shown = labelIndexes(count, plotWidth, 52);
  const parts: string[] = [
    svgOpen(options, height),
    `<defs><pattern id="${hatchId}" width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="5" height="5" fill="var(--series-2)"/><line x1="0" y1="0" x2="0" y2="5" stroke="var(--surface)" stroke-width="1.6"/></pattern></defs>`,
    grid(scale, left, top, plotHeight, options.format ?? plain),
  ];
  options.labels.forEach((label, index) => {
    const x = left + band * index + (band - barWidth) / 2;
    const topSeries = options.series.reduce(
      (found, series, seriesIndex) => ((series.values[index] ?? 0) > 0 ? seriesIndex : found),
      -1,
    );
    let stacked = 0;
    const marks: string[] = [];
    options.series.forEach((series, seriesIndex) => {
      const value = series.values[index] ?? 0;
      if (value <= 0) return;
      const barHeight = (value / scale.max) * plotHeight;
      const y = top + plotHeight - ((stacked + value) / scale.max) * plotHeight;
      const gap = stacked > 0 ? 2 : 0;
      marks.push(
        `<path class="mark" d="${roundedTop(x, y, barWidth, Math.max(0, barHeight - gap), seriesIndex === topSeries ? 4 : 0)}" fill="${series.hatch === true ? `url(#${hatchId})` : series.color}"/>`,
      );
      stacked += value;
    });
    parts.push(
      `<g><title>${escapeHtml(tooltip(options, index))}</title><rect x="${(left + band * index).toFixed(1)}" y="${String(top)}" width="${band.toFixed(1)}" height="${String(plotHeight)}" fill="transparent"/>${marks.join("")}</g>`,
    );
    if (shown.has(index)) {
      const last = index === count - 1;
      parts.push(
        `<text x="${(last ? x + barWidth : x + barWidth / 2).toFixed(1)}" y="${String(height - 8)}" text-anchor="${last ? "end" : "middle"}">${escapeHtml(label)}</text>`,
      );
    }
  });
  parts.push("</svg></div>");
  return parts.join("");
}

/** Lines over the labels; a null value breaks the line. */
export function lines(options: ChartOptions): string {
  const height = options.height ?? 200;
  const left = 44;
  const right = 8;
  const top = 12;
  const bottom = 28;
  const plotHeight = height - top - bottom;
  const plotWidth = WIDTH - left - right;
  const count = options.labels.length;
  const values = options.series.flatMap((series) =>
    series.values.filter((value): value is number => value !== null),
  );
  const scale = axis(Math.max(0, ...values));
  const x = (index: number): number =>
    left + (count === 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number): number => top + plotHeight - (value / scale.max) * plotHeight;
  const format = options.format ?? plain;
  const parts: string[] = [svgOpen(options, height), grid(scale, left, top, plotHeight, format)];
  for (const series of options.series) {
    let pen = "M";
    let path = "";
    series.values.forEach((value, index) => {
      if (value === null) {
        pen = "M";
        return;
      }
      path += `${pen}${x(index).toFixed(1)},${y(value).toFixed(1)}`;
      pen = "L";
    });
    parts.push(
      `<path d="${path}" fill="none" stroke="${series.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    series.values.forEach((value, index) => {
      if (value === null) return;
      parts.push(
        `<circle class="mark" cx="${x(index).toFixed(1)}" cy="${y(value).toFixed(1)}" r="${index === count - 1 ? "4" : "3"}" fill="${series.color}" stroke="var(--surface)" stroke-width="1.5"><title>${escapeHtml(`${options.labels[index] ?? ""}: ${series.name} ${format(value)}`)}</title></circle>`,
      );
    });
  }
  for (const index of labelIndexes(count, plotWidth, 60)) {
    parts.push(
      `<text x="${x(index).toFixed(1)}" y="${String(height - 8)}" text-anchor="${index === 0 ? "start" : index === count - 1 ? "end" : "middle"}">${escapeHtml(options.labels[index] ?? "")}</text>`,
    );
  }
  parts.push("</svg></div>");
  return parts.join("");
}

/** The chart's key. `total` is shown after the name when given. */
export function legend(series: (Series & { total?: string })[], line = false): string {
  return `<ul class="legend" aria-hidden="true">${series
    .map(
      (item) =>
        `<li><span class="key${line ? " lk" : ""}${item.hatch === true ? " hatch" : ""}"${item.hatch === true ? "" : ` style="background:${item.color}"`}></span>${escapeHtml(item.name)}${item.total === undefined ? "" : ` <span class="num">${escapeHtml(item.total)}</span>`}</li>`,
    )
    .join("")}</ul>`;
}

/** The chart's numbers as a table, folded under it. */
export function tableView(
  labels: string[],
  series: Series[],
  head: string,
  format: (value: number) => string = plain,
): string {
  return `<details class="as-table"><summary>Show as table</summary>${table(
    [{ label: head }, ...series.map((item) => ({ label: item.name, right: true }))],
    labels.map((label, index) => [
      escapeHtml(label),
      ...series.map((item) => {
        const value = item.values[index];
        return value === null || value === undefined ? "No reading" : escapeHtml(format(value));
      }),
    ]),
  )}</details>`;
}
