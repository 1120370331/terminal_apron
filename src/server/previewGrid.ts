import Headless from "@xterm/headless";
import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import type { TerminalPreviewGrid, TerminalPreviewRow, TerminalPreviewSegment } from "../shared/types.js";

const PREVIEW_COLS = 240;
const PREVIEW_ROWS = 80;
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

export async function renderPreviewGrid(data: string): Promise<TerminalPreviewGrid | undefined> {
  if (!data) {
    return undefined;
  }

  const screen = new Headless.Terminal({
    allowProposedApi: true,
    cols: PREVIEW_COLS,
    rows: PREVIEW_ROWS,
    scrollback: PREVIEW_ROWS
  });

  try {
    await writeHeadless(screen, data);
    const buffer = screen.buffer.active;
    const start = Math.max(0, buffer.length - PREVIEW_ROWS);
    const rows: TerminalPreviewRow[] = [];
    const cell = buffer.getNullCell();

    for (let rowIndex = start; rowIndex < buffer.length; rowIndex += 1) {
      const line = buffer.getLine(rowIndex);
      if (!line) {
        continue;
      }
      rows.push(renderLine(line, cell));
    }

    while (rows.length && isEmptyRow(rows[0])) {
      rows.shift();
    }

    return {
      cols: PREVIEW_COLS,
      rows
    };
  } finally {
    screen.dispose();
  }
}

function renderLine(line: { length: number; getCell: (index: number, cell?: IBufferCell) => IBufferCell | undefined }, cell: IBufferCell): TerminalPreviewRow {
  const segments: TerminalPreviewSegment[] = [];
  let current: TerminalPreviewSegment | null = null;
  let lastNonEmptySegment = -1;

  for (let col = 0; col < Math.min(line.length, PREVIEW_COLS); col += 1) {
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
  return Array.from(value).reduce((count, char) => count + (char.charCodeAt(0) > 0xff ? 2 : 1), 0);
}

function isEmptyRow(row: TerminalPreviewRow): boolean {
  return row.segments.length === 0 || row.segments.every((segment) => !segment.bg && !segment.text.trim());
}

function writeHeadless(screen: HeadlessTerminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    screen.write(data, resolve);
  });
}
