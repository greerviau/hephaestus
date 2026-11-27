import { crc32, deflateSync } from "node:zlib";
import type { ChartBar } from "./chart.js";

/*
 * A bar chart drawn straight into a PNG with Node's zlib and a built-in 5x7
 * pixel font. It needs no native module, no browser, no display, and no font
 * file on the host, so it runs the same wherever Hephaestus runs.
 */

type Color = readonly [number, number, number];

const SURFACE: Color = [255, 255, 255];
const INK: Color = [31, 41, 55];
const MUTED: Color = [75, 85, 99];
const GRID: Color = [229, 231, 235];
const AXIS: Color = [156, 163, 175];
const BAR: Color = [47, 111, 203];

const WIDTH = 900;
const LEFT = 70;
const RIGHT = 30;
const PLOT_TOP = 100;
const PLOT_HEIGHT = 300;
const GLYPH_W = 5;
const ADVANCE = 6;

/** Seven rows of five pixels each, for the characters a chart uses. Text is drawn in capitals. */
const FONT: Record<string, string> = {
  " ": "00000 00000 00000 00000 00000 00000 00000",
  A: "01110 10001 10001 11111 10001 10001 10001",
  B: "11110 10001 10001 11110 10001 10001 11110",
  C: "01110 10001 10000 10000 10000 10001 01110",
  D: "11110 10001 10001 10001 10001 10001 11110",
  E: "11111 10000 10000 11110 10000 10000 11111",
  F: "11111 10000 10000 11110 10000 10000 10000",
  G: "01110 10001 10000 10111 10001 10001 01111",
  H: "10001 10001 10001 11111 10001 10001 10001",
  I: "01110 00100 00100 00100 00100 00100 01110",
  J: "00111 00010 00010 00010 00010 10010 01100",
  K: "10001 10010 10100 11000 10100 10010 10001",
  L: "10000 10000 10000 10000 10000 10000 11111",
  M: "10001 11011 10101 10101 10001 10001 10001",
  N: "10001 11001 10101 10011 10001 10001 10001",
  O: "01110 10001 10001 10001 10001 10001 01110",
  P: "11110 10001 10001 11110 10000 10000 10000",
  Q: "01110 10001 10001 10001 10101 10010 01101",
  R: "11110 10001 10001 11110 10100 10010 10001",
  S: "01111 10000 10000 01110 00001 00001 11110",
  T: "11111 00100 00100 00100 00100 00100 00100",
  U: "10001 10001 10001 10001 10001 10001 01110",
  V: "10001 10001 10001 10001 10001 01010 00100",
  W: "10001 10001 10001 10101 10101 11011 10001",
  X: "10001 10001 01010 00100 01010 10001 10001",
  Y: "10001 10001 01010 00100 00100 00100 00100",
  Z: "11111 00001 00010 00100 01000 10000 11111",
  "0": "01110 10001 10011 10101 11001 10001 01110",
  "1": "00100 01100 00100 00100 00100 00100 01110",
  "2": "01110 10001 00001 00010 00100 01000 11111",
  "3": "11110 00001 00001 01110 00001 00001 11110",
  "4": "00010 00110 01010 10010 11111 00010 00010",
  "5": "11111 10000 11110 00001 00001 10001 01110",
  "6": "00110 01000 10000 11110 10001 10001 01110",
  "7": "11111 00001 00010 00100 01000 01000 01000",
  "8": "01110 10001 10001 01110 10001 10001 01110",
  "9": "01110 10001 10001 01111 00001 00010 01100",
  ".": "00000 00000 00000 00000 00000 01100 01100",
  ",": "00000 00000 00000 00000 01100 00100 01000",
  ":": "00000 01100 01100 00000 01100 01100 00000",
  "-": "00000 00000 00000 11111 00000 00000 00000",
  "+": "00000 00100 00100 11111 00100 00100 00000",
  "/": "00001 00010 00010 00100 01000 01000 10000",
  "(": "00010 00100 01000 01000 01000 00100 00010",
  ")": "01000 00100 00010 00010 00010 00100 01000",
  "%": "11001 11010 00010 00100 01000 01011 10011",
  "'": "00100 00100 01000 00000 00000 00000 00000",
  _: "00000 00000 00000 00000 00000 00000 11111",
  "?": "01110 10001 00001 00010 00100 00000 00100",
};

class Canvas {
  readonly data: Buffer;

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.data = Buffer.alloc(width * height * 3);
    this.rect(0, 0, width, height, SURFACE);
  }

  rect(x: number, y: number, w: number, h: number, color: Color): void {
    const x0 = Math.max(0, Math.round(x));
    const x1 = Math.min(this.width, Math.round(x + w));
    for (
      let row = Math.max(0, Math.round(y));
      row < Math.min(this.height, Math.round(y + h));
      row++
    ) {
      for (let col = x0; col < x1; col++) {
        const at = (row * this.width + col) * 3;
        this.data[at] = color[0];
        this.data[at + 1] = color[1];
        this.data[at + 2] = color[2];
      }
    }
  }

  text(value: string, x: number, y: number, scale: number, color: Color): void {
    let cursor = x;
    for (const char of value.toUpperCase()) {
      const glyph = FONT[char] ?? FONT["?"] ?? "";
      glyph.split(" ").forEach((bits, row) => {
        for (let col = 0; col < GLYPH_W; col++) {
          if (bits[col] === "1")
            this.rect(cursor + col * scale, y + row * scale, scale, scale, color);
        }
      });
      cursor += ADVANCE * scale;
    }
  }

  png(): Buffer {
    const stride = this.width * 3;
    const raw = Buffer.alloc((stride + 1) * this.height);
    for (let y = 0; y < this.height; y++) {
      // Filter type 0: the row as it is.
      this.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const header = Buffer.alloc(13);
    header.writeUInt32BE(this.width, 0);
    header.writeUInt32BE(this.height, 4);
    header[8] = 8;
    header[9] = 2;
    return Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", header),
      chunk("IDAT", deflateSync(raw)),
      chunk("IEND", Buffer.alloc(0)),
    ]);
  }
}

function chunk(type: string, body: Buffer): Buffer {
  const out = Buffer.alloc(12 + body.length);
  out.writeUInt32BE(body.length, 0);
  out.write(type, 4, "latin1");
  body.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + body.length)), 8 + body.length);
  return out;
}

const textWidth = (value: string, scale: number): number => value.length * ADVANCE * scale;

/** The caption broken into lines that fit `width` pixels. */
function wrap(value: string, scale: number, width: number): string[] {
  const perLine = Math.max(10, Math.floor(width / (ADVANCE * scale)));
  const lines: string[] = [];
  let line = "";
  for (const word of value.split(/\s+/).filter((w) => w !== "")) {
    const next = line === "" ? word : `${line} ${word}`;
    if (next.length > perLine && line !== "") {
      lines.push(line);
      line = word;
    } else line = next;
  }
  if (line !== "") lines.push(line);
  return lines;
}

/** A step of 1, 2, or 5 times a power of ten that puts at most five gridlines under the top. */
function niceStep(max: number): number {
  for (let magnitude = 1; ; magnitude *= 10) {
    for (const base of [1, 2, 5]) if (max / (base * magnitude) <= 5) return base * magnitude;
  }
}

export interface BarChartSpec {
  title: string;
  caption: string;
  bars: readonly ChartBar[];
}

/** A PNG of one bar series on a white surface, with a title, a count axis, and a caption. */
export function renderBarChart(spec: BarChartSpec): Buffer {
  const plotWidth = WIDTH - LEFT - RIGHT;
  const captionLines = wrap(spec.caption, 2, WIDTH - 2 * 40);
  const labelsBottom = PLOT_TOP + PLOT_HEIGHT;
  const height = labelsBottom + 70 + captionLines.length * 22 + 24;
  const canvas = new Canvas(WIDTH, height);

  canvas.text(spec.title, 40, 30, 3, INK);

  const max = Math.max(1, ...spec.bars.map((bar) => bar.value));
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const y = (value: number): number => labelsBottom - (value / top) * PLOT_HEIGHT;
  for (let tick = 0; tick <= top; tick += step) {
    canvas.rect(LEFT, y(tick), plotWidth, 1, tick === 0 ? AXIS : GRID);
    const label = String(tick);
    canvas.text(label, LEFT - 10 - textWidth(label, 2), y(tick) - 7, 2, MUTED);
  }

  const slot = plotWidth / Math.max(1, spec.bars.length);
  const barWidth = Math.min(slot * 0.7, 64);
  const longest = Math.max(1, ...spec.bars.map((bar) => bar.label.length));
  // Draw every label at the larger size when they fit, then the smaller, then every nth.
  const labelScale = textWidth("0".repeat(longest), 2) + 6 <= slot ? 2 : 1;
  const every = Math.max(1, Math.ceil((textWidth("0".repeat(longest), labelScale) + 6) / slot));
  spec.bars.forEach((bar, i) => {
    const x = LEFT + i * slot + (slot - barWidth) / 2;
    if (bar.value > 0) {
      canvas.rect(x, y(bar.value), barWidth, labelsBottom - y(bar.value), BAR);
      if (spec.bars.length <= 16) {
        const value = String(bar.value);
        canvas.text(value, x + (barWidth - textWidth(value, 2)) / 2, y(bar.value) - 20, 2, INK);
      }
    }
    if (i % every === 0) {
      const at = LEFT + i * slot + (slot - textWidth(bar.label, labelScale)) / 2;
      canvas.text(bar.label, Math.max(2, at), labelsBottom + 12, labelScale, MUTED);
    }
  });

  captionLines.forEach((line, i) => {
    canvas.text(line, 40, labelsBottom + 60 + i * 22, 2, MUTED);
  });
  return canvas.png();
}
