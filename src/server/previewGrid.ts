import Headless from "@xterm/headless";
import type { IBufferCell, Terminal as HeadlessTerminal } from "@xterm/headless";
import type { TerminalPreviewGrid, TerminalPreviewRow, TerminalPreviewSegment } from "../shared/types.js";

const PREVIEW_MIN_COLS = 80;
const PREVIEW_MAX_COLS = 220;
const PREVIEW_RENDER_MAX_COLS = 120;
const PREVIEW_ROWS = 360;
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

export async function renderPreviewGrid(data: string): Promise<TerminalPreviewGrid | undefined> {
  if (!data) {
    return undefined;
  }

  const cols = detectPreviewColumns(data);
  const screen = new Headless.Terminal({
    allowProposedApi: true,
    cols,
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
    while (rows.length && isEmptyRow(rows[rows.length - 1])) {
      rows.pop();
    }

    const contentCols = rows.reduce((max, row) => Math.max(max, rowColumns(row)), 0);
    const renderCols = Math.max(PREVIEW_MIN_COLS, Math.min(PREVIEW_RENDER_MAX_COLS, contentCols || cols, cols));

    return {
      cols: renderCols,
      rows: rows.map((row) => clipRow(row, renderCols))
    };
  } finally {
    screen.dispose();
  }
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
    segments: lastNonEmptySegment >= 0 ? trimDefaultPadding(segments.slice(0, lastNonEmptySegment + 1)) : []
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

function trimDefaultPadding(segments: TerminalPreviewSegment[]): TerminalPreviewSegment[] {
  return trimLeadingDefaultSpaces(trimTrailingDefaultSpaces(segments));
}

function trimLeadingDefaultSpaces(segments: TerminalPreviewSegment[]): TerminalPreviewSegment[] {
  const first = segments[0];
  if (!first || first.bg || first.text.trimStart() === first.text) {
    return segments;
  }

  const trimmed = first.text.trimStart();
  if (!trimmed) {
    return trimLeadingDefaultSpaces(segments.slice(1));
  }

  return [{ ...first, text: trimmed, cols: visibleColumns(trimmed) }, ...segments.slice(1)];
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

function clipRow(row: TerminalPreviewRow, cols: number): TerminalPreviewRow {
  const segments: TerminalPreviewSegment[] = [];
  let used = 0;
  for (const segment of row.segments) {
    if (used >= cols) {
      break;
    }
    const available = cols - used;
    if (segment.cols <= available) {
      segments.push(segment);
      used += segment.cols;
      continue;
    }
    const text = sliceColumns(segment.text, available);
    if (text) {
      segments.push({ ...segment, text, cols: visibleColumns(text) });
    }
    break;
  }
  return { segments };
}

function rowColumns(row: TerminalPreviewRow): number {
  return row.segments.reduce((total, segment) => total + segment.cols, 0);
}

function sliceColumns(value: string, maxCols: number): string {
  let output = "";
  let used = 0;
  for (const char of Array.from(value)) {
    const width = charColumns(char);
    if (used + width > maxCols) {
      break;
    }
    output += char;
    used += width;
  }
  return output;
}

function visibleColumns(value: string): number {
  return Array.from(value).reduce((count, char) => count + charColumns(char), 0);
}

function detectPreviewColumns(value: string): number {
  const plain = value.replace(ANSI_PATTERN, "");
  let maxColumns = 0;
  for (const line of plain.split(/\r?\n/)) {
    maxColumns = Math.max(maxColumns, visibleColumns(line.trimEnd()));
  }
  return Math.max(PREVIEW_MIN_COLS, Math.min(PREVIEW_MAX_COLS, maxColumns || 120));
}

function charColumns(char: string): number {
  const codePoint = char.codePointAt(0) ?? 0;
  if (codePoint === 0) {
    return 0;
  }
  return codePoint > 0xff ? 2 : 1;
}

function isEmptyRow(row: TerminalPreviewRow): boolean {
  return row.segments.length === 0 || row.segments.every((segment) => !segment.bg && !segment.text.trim());
}

function writeHeadless(screen: HeadlessTerminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    screen.write(data, resolve);
  });
}
