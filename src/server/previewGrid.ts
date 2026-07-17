import Headless from "@xterm/headless";
import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import type { TerminalPreviewGrid, TerminalPreviewRow, TerminalPreviewSegment } from "../shared/types.js";
import { characterColumns } from "../shared/unicodeWidth.js";

const PREVIEW_MIN_COLS = 20;
const PREVIEW_DEFAULT_COLS = 120;
const PREVIEW_MAX_COLS = 600;
const PREVIEW_DEFAULT_ROWS = 80;
const PREVIEW_MAX_ROWS = 1200;
const ANSI_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)|\u001b\[[0-?]*[ -/]*[@-~]/g;
const PALETTE = [
  "#2e3436",
  "#cc0000",
  "#4e9a06",
  "#c4a000",
  "#3465a4",
  "#75507b",
  "#06989a",
  "#d3d7cf",
  "#555753",
  "#ef2929",
  "#8ae234",
  "#fce94f",
  "#729fcf",
  "#ad7fa8",
  "#34e2e2",
  "#eeeeec"
];

interface RenderPreviewGridOptions {
  cols?: number;
  rows?: number;
  preserveViewport?: boolean;
}

export async function renderPreviewGrid(
  data: string,
  options: RenderPreviewGridOptions = {}
): Promise<TerminalPreviewGrid | undefined> {
  if (!data) {
    return undefined;
  }

  const cols = clampNumber(options.cols, detectPreviewColumns(data), PREVIEW_MIN_COLS, PREVIEW_MAX_COLS);
  const rowsToKeep = clampNumber(options.rows, PREVIEW_DEFAULT_ROWS, 10, PREVIEW_MAX_ROWS);
  if (options.preserveViewport) {
    return renderDumpScreenGrid(data, cols, rowsToKeep);
  }

  const screen = new Headless.Terminal({
    allowProposedApi: true,
    cols,
    rows: rowsToKeep,
    scrollback: rowsToKeep
  });

  try {
    await writeHeadless(screen, data);
    const buffer = screen.buffer.active;
    const start = Math.max(0, buffer.length - rowsToKeep);
    const rows: TerminalPreviewRow[] = [];
    const cell = buffer.getNullCell();

    for (let rowIndex = start; rowIndex < buffer.length; rowIndex += 1) {
      const line = buffer.getLine(rowIndex);
      if (!line) {
        continue;
      }
      rows.push(renderLine(line, cell));
    }

    if (!options.preserveViewport) {
      while (rows.length && isEmptyRow(rows[0])) {
        rows.shift();
      }
      while (rows.length && isEmptyRow(rows[rows.length - 1])) {
        rows.pop();
      }
    }

    return {
      cols,
      rows
    };
  } finally {
    screen.dispose();
  }
}

function renderDumpScreenGrid(data: string, cols: number, rowsToKeep: number): TerminalPreviewGrid {
  let rawRows = normalizeTerminalRows(data);
  if (rawRows.length > rowsToKeep) {
    rawRows = rawRows.slice(-rowsToKeep);
  }

  const rows = rawRows.map((line) => ({
    segments: trimTrailingDefaultSpaces(parseAnsiLine(line))
  }));
  while (rows.length && isEmptyRow(rows[0])) {
    rows.shift();
  }
  while (rows.length && isEmptyRow(rows[rows.length - 1])) {
    rows.pop();
  }

  return {
    cols,
    rows
  };
}

function parseAnsiLine(line: string): TerminalPreviewSegment[] {
  const segments: TerminalPreviewSegment[] = [];
  let style: Omit<TerminalPreviewSegment, "text" | "cols"> = {};
  let cursor = 0;

  const pushText = (text: string) => {
    if (!text) {
      return;
    }
    const segment = {
      text,
      cols: visibleColumns(text),
      ...style
    };
    const previous = segments[segments.length - 1];
    if (previous && segmentKey(previous) === segmentKey(segment)) {
      previous.text += segment.text;
      previous.cols += segment.cols;
    } else {
      segments.push(segment);
    }
  };

  for (const match of line.matchAll(ANSI_PATTERN)) {
    const index = match.index ?? 0;
    pushText(line.slice(cursor, index));
    const sequence = match[0];
    if (sequence.startsWith("\u001b[") && sequence.endsWith("m")) {
      style = applySgr(style, sequence);
    }
    cursor = index + sequence.length;
  }

  pushText(line.slice(cursor));
  return segments;
}

function renderLine(line: { length: number; getCell: (index: number, cell?: IBufferCell) => IBufferCell | undefined }, cell: IBufferCell): TerminalPreviewRow {
  const segments: TerminalPreviewSegment[] = [];
  let current: TerminalPreviewSegment | null = null;
  let lastNonEmptySegment = -1;

  for (let col = 0; col < Math.min(line.length, PREVIEW_MAX_COLS); col += 1) {
    const item = line.getCell(col, cell);
    if (!item || item.getWidth() === 0) {
      continue;
    }

    const segment = cellToSegment(item);
    const key = segmentKey(segment);
    if (current && segmentKey(current) === key) {
      current.text += segment.text;
      current.cols += segment.cols;
    } else {
      current = segment;
      segments.push(current);
    }

    if (segment.text.trim() || segment.bg) {
      lastNonEmptySegment = segments.length - 1;
    }
  }

  return {
    segments: lastNonEmptySegment >= 0 ? trimTrailingDefaultSpaces(segments.slice(0, lastNonEmptySegment + 1)) : []
  };
}

function cellToSegment(cell: IBufferCell): TerminalPreviewSegment {
  const inverse = Boolean(cell.isInverse());
  const fg = colorFromCell(cell, "fg");
  const bg = colorFromCell(cell, "bg");
  return {
    text: cell.getChars() || " ",
    cols: Math.max(1, cell.getWidth()),
    fg: inverse ? bg : fg,
    bg: inverse ? fg : bg,
    bold: Boolean(cell.isBold()),
    italic: Boolean(cell.isItalic()),
    underline: Boolean(cell.isUnderline()),
    dim: Boolean(cell.isDim())
  };
}

function colorFromCell(cell: IBufferCell, target: "fg" | "bg"): string | undefined {
  const isDefault = target === "fg" ? cell.isFgDefault() : cell.isBgDefault();
  if (isDefault) {
    return undefined;
  }

  const color = target === "fg" ? cell.getFgColor() : cell.getBgColor();
  const isRgb = target === "fg" ? cell.isFgRGB() : cell.isBgRGB();
  if (isRgb) {
    return `#${color.toString(16).padStart(6, "0").slice(-6)}`;
  }

  return ansiPaletteColor(color);
}

function ansiPaletteColor(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0 || value > 255) {
    return undefined;
  }
  if (value < 16) {
    return PALETTE[value];
  }
  if (value >= 232) {
    const channel = 8 + (value - 232) * 10;
    return rgb(channel, channel, channel);
  }

  const offset = value - 16;
  return rgb(
    cubeChannel(Math.floor(offset / 36)),
    cubeChannel(Math.floor((offset % 36) / 6)),
    cubeChannel(offset % 6)
  );
}

function cubeChannel(value: number): number {
  return value === 0 ? 0 : 55 + value * 40;
}

function rgb(red: number, green: number, blue: number): string {
  return `#${[red, green, blue].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

function segmentKey(segment: TerminalPreviewSegment): string {
  return [
    segment.fg ?? "",
    segment.bg ?? "",
    segment.bold ? "1" : "",
    segment.italic ? "1" : "",
    segment.underline ? "1" : "",
    segment.dim ? "1" : ""
  ].join("|");
}

function applySgr(
  current: Omit<TerminalPreviewSegment, "text" | "cols">,
  sequence: string
): Omit<TerminalPreviewSegment, "text" | "cols"> {
  const next: Omit<TerminalPreviewSegment, "text" | "cols"> = { ...current };
  const body = sequence.slice(2, -1);
  const codes = body.length ? body.split(";").map((item) => Number(item || 0)) : [0];

  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) {
      return {};
    }
    if (code === 1) {
      next.bold = true;
    } else if (code === 2) {
      next.dim = true;
    } else if (code === 3) {
      next.italic = true;
    } else if (code === 4) {
      next.underline = true;
    } else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code === 23) {
      delete next.italic;
    } else if (code === 24) {
      delete next.underline;
    } else if (code >= 30 && code <= 37) {
      next.fg = PALETTE[code - 30];
    } else if (code === 39) {
      delete next.fg;
    } else if (code >= 40 && code <= 47) {
      next.bg = PALETTE[code - 40];
    } else if (code === 49) {
      delete next.bg;
    } else if (code >= 90 && code <= 97) {
      next.fg = PALETTE[8 + code - 90];
    } else if (code >= 100 && code <= 107) {
      next.bg = PALETTE[8 + code - 100];
    } else if ((code === 38 || code === 48) && codes[index + 1] === 5) {
      const color = ansiPaletteColor(codes[index + 2]);
      if (color) {
        if (code === 38) {
          next.fg = color;
        } else {
          next.bg = color;
        }
      }
      index += 2;
    } else if ((code === 38 || code === 48) && codes[index + 1] === 2) {
      const color = rgb(clampByte(codes[index + 2]), clampByte(codes[index + 3]), clampByte(codes[index + 4]));
      if (code === 38) {
        next.fg = color;
      } else {
        next.bg = color;
      }
      index += 4;
    }
  }

  return next;
}

function trimTrailingDefaultSpaces(segments: TerminalPreviewSegment[]): TerminalPreviewSegment[] {
  const last = segments[segments.length - 1];
  if (!last || last.bg || last.text.trim()) {
    return segments;
  }

  const trimmed = last.text.trimEnd();
  if (!trimmed) {
    return segments.slice(0, -1);
  }

  return [...segments.slice(0, -1), { ...last, text: trimmed, cols: visibleColumns(trimmed) }];
}

function visibleColumns(value: string): number {
  return Array.from(value).reduce((count, char) => count + characterColumns(char), 0);
}

function detectPreviewColumns(value: string): number {
  const plain = value.replace(ANSI_PATTERN, "");
  let maxColumns = 0;
  for (const line of plain.split(/\r?\n/)) {
    maxColumns = Math.max(maxColumns, visibleColumns(line.trimEnd()));
  }
  return Math.max(PREVIEW_MIN_COLS, Math.min(PREVIEW_MAX_COLS, maxColumns || PREVIEW_DEFAULT_COLS));
}

function clampByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.floor(value)));
}

function isEmptyRow(row: TerminalPreviewRow): boolean {
  return row.segments.length === 0 || row.segments.every((segment) => !segment.bg && !segment.text.trim());
}

function writeHeadless(screen: HeadlessTerminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    screen.write(data, resolve);
  });
}

function clampNumber(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function normalizeTerminalRows(value: string): string[] {
  return value.split("\n").map((line) => {
    const withoutTrailingCr = line.endsWith("\r") ? line.slice(0, -1) : line;
    const carriageReturn = withoutTrailingCr.lastIndexOf("\r");
    return carriageReturn >= 0 ? withoutTrailingCr.slice(carriageReturn + 1) : withoutTrailingCr;
  });
}
