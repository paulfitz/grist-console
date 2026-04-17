import { BulkColValues, CellValue, ColumnInfo } from "./types.js";
import { formatCellValue } from "./ConsoleCellFormat.js";
import { BoxSpec, LayoutNode, PageInfo, SectionInfo, collectLeaves } from "./ConsoleLayout.js";
import { Theme, defaultTheme } from "./ConsoleTheme.js";
import stringWidth from "string-width";
import { getTermWidthOverride, getFlagPairDelta, getVs16Delta, hasOverrides } from "./termWidth.js";

// ANSI escape codes (non-stylistic, always needed)
const ESC = "\x1b[";
const CLEAR_LINE = `${ESC}K`; // clear from cursor to end of line
const MOVE_TO = (row: number, col: number) => `${ESC}${row + 1};${col + 1}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
export const ENTER_ALT_SCREEN = `${ESC}?1049h`;
export const EXIT_ALT_SCREEN = `${ESC}?1049l`;

/**
 * Build the screen preamble: hide cursor, set background color, move to home.
 * We don't clear the screen on every render (causes flicker); instead each
 * render overwrites every visible cell. The alternate screen buffer gives us
 * a clean starting state, and line-based renders use \x1b[K to erase any
 * stale trailing content.
 */
function screenPreamble(t: Theme): string {
  return HIDE_CURSOR + (t.screenBg || "") + MOVE_TO(0, 0);
}

export type AppMode = "table_picker" | "page_picker" | "grid" | "editing" | "confirm_delete" | "overlay" | "cell_viewer";

export interface PaneState {
  sectionInfo: SectionInfo;
  columns: ColumnInfo[];
  rowIds: number[];
  allRowIds: number[];
  colValues: BulkColValues;
  allColValues: BulkColValues;
  cursorRow: number;
  cursorCol: number;
  scrollRow: number;
  scrollCol: number;
}

export interface AppState {
  mode: AppMode;
  tableIds: string[];
  selectedTableIndex: number;
  currentTableId: string;
  columns: ColumnInfo[];
  rowIds: number[];
  colValues: BulkColValues;
  cursorRow: number;
  cursorCol: number;
  scrollRow: number;
  scrollCol: number;
  editValue: string;
  editCursorPos: number;
  statusMessage: string;
  docId: string;
  // Multi-pane page layout state
  pages: PageInfo[];
  selectedPageIndex: number;
  currentPageId: number;
  panes: PaneState[];
  layout: LayoutNode | null;
  boxSpec: BoxSpec | null;
  focusedPane: number;
  // Collapsed widget tray
  collapsedPaneIndices: number[];
  overlayPaneIndex: number | null;
  // Cell viewer
  cellViewerContent: string;
  cellViewerScroll: number;
  cellViewerLinkIndex: number;  // -1 = no link selected, 0+ = selected link
  // Theme
  theme: Theme;
}

export function createInitialState(docId: string, theme?: Theme): AppState {
  return {
    mode: "table_picker",
    tableIds: [],
    selectedTableIndex: 0,
    currentTableId: "",
    columns: [],
    rowIds: [],
    colValues: {},
    cursorRow: 0,
    cursorCol: 0,
    scrollRow: 0,
    scrollCol: 0,
    editValue: "",
    editCursorPos: 0,
    statusMessage: "",
    docId,
    // Multi-pane
    pages: [],
    selectedPageIndex: 0,
    currentPageId: 0,
    panes: [],
    layout: null,
    boxSpec: null,
    focusedPane: 0,
    collapsedPaneIndices: [],
    overlayPaneIndex: null,
    cellViewerContent: "",
    cellViewerScroll: 0,
    cellViewerLinkIndex: -1,
    // Theme
    theme: theme || defaultTheme,
  };
}

interface ColLayout {
  colId: string;
  label: string;
  width: number;
}

/**
 * Compute column widths based on header labels and sampled data.
 */
function computeColLayout(state: AppState): ColLayout[] {
  const maxWidth = 30;
  const minWidth = 4;
  return state.columns.map((col) => {
    let width = displayWidth(col.label);
    const values = state.colValues[col.colId];
    if (values) {
      const sampleSize = Math.min(values.length, 100);
      for (let i = 0; i < sampleSize; i++) {
        const formatted = flattenToLine(formatCellValue(values[i], col.type, col.widgetOptions, col.displayValues));
        width = Math.max(width, displayWidth(formatted));
      }
    }
    width = Math.max(minWidth, Math.min(maxWidth, width));
    return { colId: col.colId, label: col.label, width };
  });
}

/**
 * Return the display width of a string in terminal cells.
 * Uses string-width, with terminal-measured overrides for known-problematic characters.
 */
export function displayWidth(s: string): number {
  // Strip ANSI escape codes before measuring
  const clean = s.replace(/\x1b\[[0-9;]*m/g, "");
  const flagPairDelta = getFlagPairDelta();
  const vs16Delta = getVs16Delta();
  // When no calibration has detected any discrepancy, trust string-width fully
  // (handles composing terminals correctly for ZWJ, flags, etc.)
  if (!hasOverrides() && flagPairDelta === 0 && vs16Delta === 0) {
    return stringWidth(clean);
  }

  // Walk through the string char-by-char. For non-composing terminals this
  // naturally gives the correct width (each emoji counted individually,
  // ZWJ counted as 0). Flags need a delta since walking gives 1+1=2 for an
  // RI pair, but the terminal may render them as 4 cells unjoined.
  let w = 0;
  const chars = [...clean];
  let i = 0;
  while (i < chars.length) {
    // Check multi-codepoint overrides first, PREFERRING longer matches so that
    // e.g. a "❤️" (2-char) override beats a bare "❤" (1-char) override, and
    // a full ZWJ sequence beats individual components.
    let matched = false;
    for (let len = Math.min(chars.length - i, 8); len >= 2; len--) {
      const candidate = chars.slice(i, i + len).join("");
      const override = getTermWidthOverride(candidate);
      if (override !== undefined) {
        w += override;
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) { continue; }

    // Regional-indicator pair (flag emoji) -- check BEFORE single-char overrides
    const code = chars[i].codePointAt(0)!;
    const isRI = code >= 0x1F1E6 && code <= 0x1F1FF;
    if (isRI && i + 1 < chars.length) {
      const nextCode = chars[i + 1].codePointAt(0)!;
      if (nextCode >= 0x1F1E6 && nextCode <= 0x1F1FF) {
        w += 2 + flagPairDelta;
        i += 2;
        continue;
      }
    }

    // Character followed by VS16: handle as emoji-composed BEFORE single-char
    // override, because the same base char can render differently with VS16
    // (e.g. ❤ alone = 1 cell text, ❤+VS16 = 2 cells emoji).
    if (i + 1 < chars.length && chars[i + 1].codePointAt(0) === 0xFE0F) {
      w += stringWidth(chars[i] + chars[i + 1]) + vs16Delta;
      i += 2;
      continue;
    }

    // Single-char override, or fall back to string-width.
    // For ZWJ sequences / skin tones, we walk char-by-char. This matches
    // partial-compose and non-composing terminals naturally (e.g.
    // 🧙+ZWJ+♀+VS16 = 2+0+1+0 = 3 cells). Fully-composing terminals get
    // walked overcount, but the background probe catches and stores an
    // override for the exact composed sequence.
    const override = getTermWidthOverride(chars[i]);
    if (override !== undefined) {
      w += override;
    } else {
      w += stringWidth(chars[i]);
    }
    i++;
  }
  return w;
}

/**
 * Replace newlines and other control characters with spaces for single-line display.
 */
export function flattenToLine(s: string): string {
  return s.replace(/[\n\r\t]/g, " ");
}

/**
 * Truncate a string to fit within maxLen display cells.
 */
function truncate(s: string, maxLen: number): string {
  if (displayWidth(s) <= maxLen) { return s; }
  // Binary-ish search: try progressively shorter slices
  const chars = [...s]; // split into codepoints
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (displayWidth(chars.slice(0, mid).join("")) + 1 <= maxLen) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return chars.slice(0, lo).join("") + "\u2026";
}

function padRight(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) { return s; }
  return s + " ".repeat(width - w);
}

function padLeft(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) { return s; }
  return " ".repeat(width - w) + s;
}

/**
 * Convert a hex color like "#2486FB" to an ANSI 24-bit color escape.
 */
function hexToAnsi(hex: string, bg: boolean): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) { return ""; }
  return bg ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[38;2;${r};${g};${b}m`;
}

const ANSI_RESET = "\x1b[0m";

/**
 * Apply choice color styling to a cell value string if the column has choiceOptions.
 */
export function applyChoiceColor(formatted: string, value: CellValue, colType: string, widgetOpts?: Record<string, any>): string {
  if (!widgetOpts?.choiceOptions) { return formatted; }
  const baseType = colType.split(":")[0];
  const opts = widgetOpts.choiceOptions as Record<string, { fillColor?: string; textColor?: string }>;

  if (baseType === "Choice") {
    const key = typeof value === "string" ? value : String(value);
    const colors = opts[key];
    if (!colors) { return formatted; }
    let ansi = "";
    if (colors.fillColor) { ansi += hexToAnsi(colors.fillColor, true); }
    if (colors.textColor) { ansi += hexToAnsi(colors.textColor, false); }
    if (!ansi) { return formatted; }
    return ansi + formatted + ANSI_RESET;
  }

  if (baseType === "ChoiceList" && Array.isArray(value) && value[0] === "L") {
    const items = value.slice(1) as string[];
    const fullJoined = items.map(v => String(v)).join(", ");
    // If the formatted string was truncated, we can't reliably color per-item
    // while preserving alignment -- return plain formatted text instead.
    if (formatted !== fullJoined) {
      return formatted;
    }
    // Color each choice in the comma-separated list
    const colored = items.map(item => {
      const colors = opts[item];
      if (!colors) { return String(item); }
      let ansi = "";
      if (colors.fillColor) { ansi += hexToAnsi(colors.fillColor, true); }
      if (colors.textColor) { ansi += hexToAnsi(colors.textColor, false); }
      if (!ansi) { return String(item); }
      return ansi + String(item) + ANSI_RESET;
    });
    return colored.join(", ");
  }

  return formatted;
}

/**
 * Get the status line content: show full cell value if the current cell is truncated,
 * otherwise show the statusMessage.
 */
function getStatusLine(state: AppState, termCols: number): string {
  if (state.statusMessage) { return state.statusMessage; }
  if (state.mode === "editing") { return ""; }

  // Get the current pane and cursor
  let columns: ColumnInfo[];
  let colValues: BulkColValues;
  let cursorRow: number;
  let cursorCol: number;

  if (state.mode === "overlay" && state.overlayPaneIndex !== null) {
    const pane = state.panes[state.overlayPaneIndex];
    if (!pane) { return ""; }
    columns = pane.columns;
    colValues = pane.colValues;
    cursorRow = pane.cursorRow;
    cursorCol = pane.cursorCol;
  } else if (state.panes.length > 0) {
    const pane = state.panes[state.focusedPane];
    if (!pane) { return ""; }
    columns = pane.columns;
    colValues = pane.colValues;
    cursorRow = pane.cursorRow;
    cursorCol = pane.cursorCol;
  } else {
    columns = state.columns;
    colValues = state.colValues;
    cursorRow = state.cursorRow;
    cursorCol = state.cursorCol;
  }

  if (cursorCol >= columns.length) { return ""; }
  const col = columns[cursorCol];
  const values = colValues[col.colId];
  const raw = values ? values[cursorRow] : null;
  if (raw === null || raw === undefined) { return ""; }
  const full = flattenToLine(formatCellValue(raw, col.type, col.widgetOptions, col.displayValues));
  // Only show if it would be truncated (longer than typical column width)
  if (displayWidth(full) > 30) {
    return truncate(full, termCols);
  }
  return "";
}

/**
 * Return a visible window of the edit text that keeps the cursor in view,
 * plus the cursor's column offset within that window.
 */
export function editWindow(editValue: string, cursorPos: number, width: number): { text: string; cursorOffset: number } {
  const chars = [...editValue];
  // Find the display width up to the cursor
  const beforeCursor = chars.slice(0, cursorPos).join("");
  const cursorDisplayPos = displayWidth(beforeCursor);

  if (cursorDisplayPos < width) {
    // Cursor fits -- show from the start, truncate at width
    return { text: padRight(truncate(editValue, width), width), cursorOffset: cursorDisplayPos };
  }

  // Cursor is past visible area -- scroll so cursor is near the right edge
  const margin = Math.max(1, Math.floor(width / 4));
  const targetStart = cursorDisplayPos - width + margin;

  // Find the character index where display width >= targetStart
  let w = 0;
  let startCharIdx = 0;
  for (const ch of chars) {
    if (w >= targetStart) { break; }
    w += displayWidth(ch);
    startCharIdx++;
  }

  const visible = chars.slice(startCharIdx).join("");
  const truncated = truncate(visible, width);
  const offsetInWindow = cursorDisplayPos - displayWidth(chars.slice(0, startCharIdx).join(""));
  return { text: padRight(truncated, width), cursorOffset: Math.min(offsetInWindow, width - 1) };
}

function isNumericType(colType: string): boolean {
  return colType === "Int" || colType === "Numeric" ||
    colType.startsWith("Ref:") || colType === "ManualPos";
}

/**
 * Render the full screen content as a string.
 */
export function render(state: AppState): string {
  const termRows = process.stdout.rows || 24;
  const termCols = process.stdout.columns || 80;

  if (state.mode === "cell_viewer" || (state.mode === "editing" && state.cellViewerContent)) {
    return renderCellViewer(state, termRows, termCols);
  }
  if (state.mode === "table_picker") {
    return renderTablePicker(state, termRows, termCols);
  }
  if (state.mode === "page_picker") {
    return renderPagePicker(state, termRows, termCols);
  }
  if (state.panes.length > 0 && state.layout) {
    return renderMultiPane(state, termRows, termCols);
  }
  return renderGrid(state, termRows, termCols);
}

function renderCellViewer(state: AppState, termRows: number, termCols: number): string {
  const t = state.theme;
  const isEditing = state.mode === "editing";
  const content = isEditing ? state.editValue : state.cellViewerContent;

  // Word-wrap content to terminal width (with 2-char margin)
  const wrapWidth = termCols - 2;
  const wrappedLines: string[] = [];
  for (const rawLine of content.split("\n")) {
    if (displayWidth(rawLine) <= wrapWidth) {
      wrappedLines.push(rawLine);
    } else {
      // Wrap long lines
      const chars = [...rawLine];
      let start = 0;
      while (start < chars.length) {
        // Find how many chars fit in wrapWidth
        let end = start + 1;
        while (end <= chars.length && displayWidth(chars.slice(start, end).join("")) <= wrapWidth) {
          end++;
        }
        end--; // back to last that fit
        if (end <= start) { end = start + 1; } // at least one char
        wrappedLines.push(chars.slice(start, end).join(""));
        start = end;
      }
    }
  }

  const lines: string[] = [];
  const titleText = isEditing ? " Editing Cell " : " Cell Content ";
  lines.push(t.titleBar(padRight(titleText, termCols)));

  const dataRows = termRows - 3; // title + footer + status
  for (let r = 0; r < dataRows; r++) {
    const lineIdx = state.cellViewerScroll + r;
    if (lineIdx < wrappedLines.length) {
      lines.push(" " + padRight(wrappedLines[lineIdx], termCols - 1));
    } else {
      lines.push("");
    }
  }

  while (lines.length < termRows - 2) {
    lines.push("");
  }

  const scrollInfo = wrappedLines.length > dataRows
    ? `  (${state.cellViewerScroll + 1}-${Math.min(state.cellViewerScroll + dataRows, wrappedLines.length)}/${wrappedLines.length})`
    : "";
  if (isEditing) {
    lines.push(t.helpBar(`Type to edit  Enter:save  Esc:cancel${scrollInfo}`));
    lines.push("");
  } else {
    const urls = [...state.cellViewerContent.matchAll(/https?:\/\/[^\s)>\]]+/g)].map(m => m[0]);
    const urlHint = urls.length > 0 ? "  o:link" : "";
    const enterHint = state.cellViewerLinkIndex >= 0 ? "Enter:open" : "Enter:edit";
    lines.push(t.helpBar(`\u2191\u2193:scroll  ${enterHint}${urlHint}  Esc/v:close${scrollInfo}`));
    if (state.cellViewerLinkIndex >= 0 && state.cellViewerLinkIndex < urls.length) {
      lines.push(`link ${state.cellViewerLinkIndex + 1}/${urls.length}: ${urls[state.cellViewerLinkIndex]}`);
    } else {
      lines.push("");
    }
  }

  let result = screenPreamble(t) + lines.join("\n");

  // Show terminal cursor when editing in cell viewer
  if (isEditing) {
    // Find cursor position within the wrapped content
    let charsLeft = state.editCursorPos;
    let cursorLine = 0;
    let cursorCol = 0;
    for (let i = 0; i < wrappedLines.length; i++) {
      const lineLen = [...wrappedLines[i]].length;
      if (charsLeft <= lineLen) {
        cursorLine = i;
        cursorCol = displayWidth(wrappedLines[i].slice(0, charsLeft));
        break;
      }
      charsLeft -= lineLen;
      // Account for the newline between original lines
      if (charsLeft > 0) { charsLeft--; }
    }
    const screenRow = 1 + (cursorLine - state.cellViewerScroll); // 1 for title bar
    if (screenRow >= 1 && screenRow < termRows - 2) {
      result += SHOW_CURSOR + MOVE_TO(screenRow, 1 + cursorCol); // 1 for left margin
    }
  }

  return result;
}

function renderTablePicker(state: AppState, termRows: number, termCols: number): string {
  const t = state.theme;
  const lines: string[] = [];

  // Title bar
  const title = t.pickerTitleFormat("Select a Table");
  lines.push(t.titleBar(padRight(title, termCols)));

  // Empty line
  lines.push("");

  // Table list
  const visibleCount = Math.min(state.tableIds.length, termRows - 5);
  for (let i = 0; i < visibleCount; i++) {
    const tid = state.tableIds[i];
    if (i === state.selectedTableIndex) {
      lines.push(`  ${t.pickerSelected(` > ${tid} `)}`);
    } else {
      lines.push(`    ${tid}`);
    }
  }

  // Fill remaining lines
  while (lines.length < termRows - 2) {
    lines.push("");
  }

  // Key help
  const pagesHint = state.pages.length > 0 ? "  p:pages" : "";
  lines.push(t.helpBar(`\u2191\u2193:select  Enter:open${pagesHint}  T:theme  q:quit`));

  // Status
  lines.push(getStatusLine(state, termCols));

  // Clear to end of line after each line to overwrite any stale content
  // left from previous renders without clearing the whole screen (flicker).
  return screenPreamble(t) + lines.join(CLEAR_LINE + "\r\n") + CLEAR_LINE;
}

function renderGrid(state: AppState, termRows: number, termCols: number): string {
  const t = state.theme;
  const lines: string[] = [];
  const layout = computeColLayout(state);
  const maxRowId = state.rowIds.length > 0 ? Math.max(...state.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);

  // Determine visible columns based on scrollCol and terminal width
  let availWidth = termCols - rowNumWidth;
  const visibleCols: number[] = [];
  for (let c = state.scrollCol; c < layout.length; c++) {
    const needed = layout[c].width + t.colSeparator.length;
    if (needed > availWidth) { break; }
    visibleCols.push(c);
    availWidth -= needed;
  }

  // Determine visible rows
  const headerRows = t.headerSepLine ? 3 : 2; // title, headers, [separator]
  const footerRows = 2; // help, status
  const dataRows = Math.max(1, termRows - headerRows - footerRows);

  // Title bar
  const rowCount = state.rowIds.length;
  const detail = `(${rowCount} ${rowCount === 1 ? "row" : "rows"})`;
  const title = t.titleFormat(state.currentTableId, detail);
  lines.push(t.titleBar(padRight(title, termCols)));

  // Column headers
  let headerContent = padLeft("#", rowNumWidth);
  for (const ci of visibleCols) {
    headerContent += t.headerSeparator + padRight(truncate(layout[ci].label, layout[ci].width), layout[ci].width);
  }
  lines.push(t.columnHeader(headerContent));

  // Separator (optional)
  if (t.headerSepLine) {
    let sepLine = t.rowSepChar.repeat(rowNumWidth);
    for (const ci of visibleCols) {
      sepLine += t.rowSepChar + t.crossChar + t.rowSepChar + t.rowSepChar.repeat(layout[ci].width);
    }
    lines.push(sepLine);
  }

  // Data rows
  for (let r = 0; r < dataRows; r++) {
    const rowIdx = state.scrollRow + r;
    if (rowIdx >= state.rowIds.length) {
      lines.push("");
      continue;
    }
    const rowId = state.rowIds[rowIdx];
    let line = t.rowNumber(padLeft(String(rowId), rowNumWidth));
    for (const ci of visibleCols) {
      const col = layout[ci];
      const colType = state.columns[ci]?.type || "Text";
      const values = state.colValues[col.colId];
      const raw = values ? values[rowIdx] : null;
      const plainText = truncate(flattenToLine(formatCellValue(raw, colType, state.columns[ci]?.widgetOptions, state.columns[ci]?.displayValues)), col.width);
      const padFn = isNumericType(colType) ? padLeft : padRight;
      const isCurrentCell = (rowIdx === state.cursorRow && ci === state.cursorCol);

      if (state.mode === "editing" && isCurrentCell) {
        const { text: editDisplay } = editWindow(state.editValue, state.editCursorPos, col.width);
        line += t.colSeparator + t.cursor(editDisplay);
      } else if (isCurrentCell) {
        line += t.colSeparator + t.cursor(padFn(plainText, col.width));
      } else {
        const colored = applyChoiceColor(plainText, raw, colType, state.columns[ci]?.widgetOptions);
        line += t.colSeparator + padFn(colored, col.width);
      }
    }
    lines.push(line);
  }

  // Fill remaining
  while (lines.length < termRows - footerRows) {
    lines.push("");
  }

  // Key help
  if (state.mode === "editing") {
    lines.push(t.helpBar("Type to edit  Enter:save  Esc:cancel"));
  } else if (state.mode === "confirm_delete") {
    lines.push(t.helpBar(`Delete row ${state.rowIds[state.cursorRow]}? y:confirm  n/Esc:cancel`));
  } else {
    const pagesHint = state.pages.length > 0 ? "  p:pages" : "";
    lines.push(t.helpBar(`\u2191\u2193\u2190\u2192:move  Enter:edit  v:view  a:add  d:del  t:tables${pagesHint}  T:theme  q:quit`));
  }

  // Status
  lines.push(getStatusLine(state, termCols));

  let result = screenPreamble(t) + lines.join(CLEAR_LINE + "\r\n") + CLEAR_LINE;

  // Show terminal cursor at edit position when editing
  if (state.mode === "editing" && !state.cellViewerContent) {
    const headerRows = t.headerSepLine ? 3 : 2;
    const editRow = headerRows + (state.cursorRow - state.scrollRow);
    let editCol = rowNumWidth + t.colSeparator.length;
    for (const ci of visibleCols) {
      if (ci === state.cursorCol) { break; }
      editCol += layout[ci].width + t.colSeparator.length;
    }
    const colWidth = layout[state.cursorCol]?.width || 0;
    const { cursorOffset } = editWindow(state.editValue, state.editCursorPos, colWidth);
    editCol += cursorOffset;
    result += SHOW_CURSOR + MOVE_TO(editRow, editCol);
  }

  return result;
}

function renderPagePicker(state: AppState, termRows: number, termCols: number): string {
  const t = state.theme;
  const lines: string[] = [];

  const title = t.pickerTitleFormat("Select a Page");
  lines.push(t.titleBar(padRight(title, termCols)));
  lines.push("");

  const visibleCount = Math.min(state.pages.length, termRows - 5);
  for (let i = 0; i < visibleCount; i++) {
    const page = state.pages[i];
    const indent = "  ".repeat(page.indentation);
    if (i === state.selectedPageIndex) {
      lines.push(`  ${t.pickerSelected(` > ${indent}${page.name} `)}`);
    } else {
      lines.push(`    ${indent}${page.name}`);
    }
  }

  while (lines.length < termRows - 2) {
    lines.push("");
  }

  lines.push(t.helpBar("\u2191\u2193:select  Enter:open  t:tables  T:theme  q:quit"));
  lines.push(getStatusLine(state, termCols));

  // Clear to end of line after each line to overwrite any stale content
  // left from previous renders without clearing the whole screen (flicker).
  return screenPreamble(t) + lines.join(CLEAR_LINE + "\r\n") + CLEAR_LINE;
}

function renderMultiPane(state: AppState, termRows: number, termCols: number): string {
  const t = state.theme;
  const hasCollapsed = state.collapsedPaneIndices.length > 0;
  const trayHeight = hasCollapsed ? 1 : 0;

  // Overlay mode: render a single collapsed pane full-screen
  if (state.mode === "overlay" && state.overlayPaneIndex !== null) {
    const pane = state.panes[state.overlayPaneIndex];
    if (pane) {
      return renderOverlay(state, pane, termRows, termCols, trayHeight);
    }
  }

  // Build a character buffer for the whole screen (below tray, above footer)
  const bufHeight = termRows - 2 - trayHeight;
  const buf: string[][] = [];
  for (let r = 0; r < bufHeight; r++) {
    buf.push(new Array(termCols).fill(" "));
  }

  const leaves = collectLeaves(state.layout!);

  // Draw borders between split children
  drawBorders(state.layout!, buf, termCols, bufHeight, t);

  // Draw each pane
  for (const leaf of leaves) {
    if (leaf.paneIndex === undefined) { continue; }
    const pane = state.panes[leaf.paneIndex];
    if (!pane) { continue; }
    const isFocused = leaf.paneIndex === state.focusedPane;
    renderPaneInto(buf, leaf, pane, isFocused, state.mode, state.editValue, state.editCursorPos, t);
  }

  // Flatten buffer to string with ANSI positioning
  let output = HIDE_CURSOR + (t.screenBg || "") + MOVE_TO(0, 0);

  // Collapsed widget tray at top
  if (hasCollapsed) {
    output += MOVE_TO(0, 0) + renderCollapsedTray(state, termCols);
  }

  for (let r = 0; r < buf.length; r++) {
    output += MOVE_TO(r + trayHeight, 0) + buf[r].join("");
  }

  // Footer: help and status
  const footerRow = termRows - 2;
  if (state.mode === "editing") {
    output += MOVE_TO(footerRow, 0) +
      t.helpBar("Type to edit  Enter:save  Esc:cancel");
  } else if (state.mode === "confirm_delete") {
    const pane = state.panes[state.focusedPane];
    const rowId = pane ? pane.rowIds[pane.cursorRow] : "?";
    output += MOVE_TO(footerRow, 0) +
      t.helpBar(`Delete row ${rowId}? y:confirm  n/Esc:cancel`);
  } else {
    const collapsedHint = hasCollapsed ? "  1-9:widget" : "";
    output += MOVE_TO(footerRow, 0) +
      t.helpBar(`\u2191\u2193\u2190\u2192:move  Tab:pane  Enter:edit  v:view  a:add  d:del  p:pages${collapsedHint}  T:theme  q:quit`);
  }
  output += MOVE_TO(termRows - 1, 0) + getStatusLine(state, termCols);

  // Show terminal cursor at edit position when editing in a grid pane
  if (state.mode === "editing" && !state.cellViewerContent) {
    const paneIdx = state.overlayPaneIndex ?? state.focusedPane;
    const pane = state.panes[paneIdx];
    const leaf = leaves.find(l => l.paneIndex === paneIdx);
    if (pane && leaf && !isCardPane(pane)) {
      const paneLayout = computePaneColLayout(pane, leaf.width);
      const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
      const rowNumWidth = Math.max(3, String(maxRowId).length);
      const headerRows = t.headerSepLine ? 3 : 2;
      const editRow = leaf.top + headerRows + (pane.cursorRow - pane.scrollRow) + trayHeight;
      let editCol = leaf.left + rowNumWidth + t.colSeparator.length;
      for (let ci = pane.scrollCol; ci < pane.cursorCol && ci < paneLayout.length; ci++) {
        editCol += paneLayout[ci].width + t.colSeparator.length;
      }
      const colWidth = paneLayout[pane.cursorCol]?.width || 0;
      const { cursorOffset } = editWindow(state.editValue, state.editCursorPos, colWidth);
      editCol += cursorOffset;
      output += SHOW_CURSOR + MOVE_TO(editRow, editCol);
    }
  }

  return output;
}

function renderCollapsedTray(state: AppState, termCols: number): string {
  const t = state.theme;
  let tray = "";
  for (let i = 0; i < state.collapsedPaneIndices.length; i++) {
    const paneIdx = state.collapsedPaneIndices[i];
    const pane = state.panes[paneIdx];
    if (!pane) { continue; }
    const name = pane.sectionInfo.title || pane.sectionInfo.tableId;
    const label = ` ${i + 1}:${name} `;
    tray += t.titleBar(label) + " ";
  }
  return padRight(tray, termCols);
}

function renderOverlay(
  state: AppState, pane: PaneState,
  termRows: number, termCols: number, trayHeight: number,
): string {
  const t = state.theme;
  const bufHeight = termRows - 2 - trayHeight;
  const buf: string[][] = [];
  for (let r = 0; r < bufHeight; r++) {
    buf.push(new Array(termCols).fill(" "));
  }

  const overlayLeaf: LayoutNode = {
    top: 0, left: 0, width: termCols, height: bufHeight,
    paneIndex: state.overlayPaneIndex!,
  };
  renderPaneInto(buf, overlayLeaf, pane, true, state.mode, state.editValue, state.editCursorPos, t);

  let output = HIDE_CURSOR + (t.screenBg || "") + MOVE_TO(0, 0);
  if (trayHeight > 0) {
    output += MOVE_TO(0, 0) + renderCollapsedTray(state, termCols);
  }
  for (let r = 0; r < buf.length; r++) {
    output += MOVE_TO(r + trayHeight, 0) + buf[r].join("");
  }

  const footerRow = termRows - 2;
  if (state.mode === "editing") {
    output += MOVE_TO(footerRow, 0) +
      t.helpBar("Type to edit  Enter:save  Esc:cancel");
  } else {
    output += MOVE_TO(footerRow, 0) +
      t.helpBar("\u2191\u2193\u2190\u2192:move  Enter:edit  v:view  Esc:close  a:add  d:del");
  }
  output += MOVE_TO(termRows - 1, 0) + getStatusLine(state, termCols);

  // Show terminal cursor when editing in overlay
  if (state.mode === "editing" && !state.cellViewerContent && !isCardPane(pane)) {
    const paneLayout = computePaneColLayout(pane, termCols);
    const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
    const rowNumWidth = Math.max(3, String(maxRowId).length);
    const headerRows = t.headerSepLine ? 3 : 2;
    const editRow = headerRows + (pane.cursorRow - pane.scrollRow) + trayHeight;
    let editCol = rowNumWidth + t.colSeparator.length;
    for (let ci = pane.scrollCol; ci < pane.cursorCol && ci < paneLayout.length; ci++) {
      editCol += paneLayout[ci].width + t.colSeparator.length;
    }
    const colWidth = paneLayout[pane.cursorCol]?.width || 0;
    const { cursorOffset } = editWindow(state.editValue, state.editCursorPos, colWidth);
    editCol += cursorOffset;
    output += SHOW_CURSOR + MOVE_TO(editRow, editCol);
  }

  return output;
}

function renderPaneInto(
  buf: string[][], leaf: LayoutNode, pane: PaneState,
  isFocused: boolean, mode: AppMode, editValue: string, editCursorPos: number, t: Theme,
): void {
  const { top, left, width, height } = leaf;
  if (width < 3 || height < 2) { return; }

  const pk = pane.sectionInfo.parentKey;
  if (pk === "single" || pk === "detail") {
    renderCardPaneInto(buf, leaf, pane, isFocused, mode, editValue, editCursorPos, t);
    return;
  }
  if (pk === "chart") {
    renderChartPlaceholder(buf, leaf, pane, isFocused, t);
    return;
  }

  const layout = computePaneColLayout(pane, width);
  const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);

  // Title bar (row 0)
  const tableName = pane.sectionInfo.title || pane.sectionInfo.tableId;
  const rowCount = pane.rowIds.length;
  const titleText = ` ${tableName} (${rowCount}) `;
  const titleLine = truncate(titleText, width);
  const titleStyled = isFocused
    ? t.titleBar(padRight(titleLine, width))
    : t.titleBarDim(padRight(titleLine, width));
  writeToBuffer(buf, top, left, titleStyled, width);

  const minHeight = t.headerSepLine ? 4 : 3;
  if (height < minHeight) { return; }

  // Determine visible columns
  let availWidth = width - rowNumWidth;
  const visibleCols: number[] = [];
  for (let c = pane.scrollCol; c < layout.length; c++) {
    const needed = layout[c].width + t.colSeparator.length;
    if (needed > availWidth) { break; }
    visibleCols.push(c);
    availWidth -= needed;
  }

  // Column headers (row 1)
  let headerContent = padLeft("#", rowNumWidth);
  for (const ci of visibleCols) {
    headerContent += t.headerSeparator + padRight(truncate(layout[ci].label, layout[ci].width), layout[ci].width);
  }
  writeToBuffer(buf, top + 1, left, t.columnHeader(headerContent), width);

  // Separator (row 2, optional)
  let dataStartRow = top + 2;
  if (t.headerSepLine) {
    let sepLine = t.rowSepChar.repeat(rowNumWidth);
    for (const ci of visibleCols) {
      sepLine += t.rowSepChar + t.crossChar + t.rowSepChar + t.rowSepChar.repeat(layout[ci].width);
    }
    writeToBuffer(buf, top + 2, left, sepLine, width);
    dataStartRow = top + 3;
  }

  // Data rows
  const dataRows = Math.max(0, height - (dataStartRow - top));
  for (let r = 0; r < dataRows; r++) {
    const rowIdx = pane.scrollRow + r;
    if (rowIdx >= pane.rowIds.length) { break; }
    const rowId = pane.rowIds[rowIdx];
    let line = t.rowNumber(padLeft(String(rowId), rowNumWidth));
    for (const ci of visibleCols) {
      const col = layout[ci];
      const colType = pane.columns[ci]?.type || "Text";
      const values = pane.colValues[col.colId];
      const raw = values ? values[rowIdx] : null;
      const plainText = truncate(flattenToLine(formatCellValue(raw, colType, pane.columns[ci]?.widgetOptions, pane.columns[ci]?.displayValues)), col.width);
      const padFn = isNumericType(colType) ? padLeft : padRight;
      const isCurrentCell = isFocused && rowIdx === pane.cursorRow && ci === pane.cursorCol;

      if (mode === "editing" && isCurrentCell) {
        const { text: editDisplay } = editWindow(editValue, editCursorPos, col.width);
        line += t.colSeparator + t.cursor(editDisplay);
      } else if (isCurrentCell) {
        line += t.colSeparator + t.cursor(padFn(plainText, col.width));
      } else {
        // Apply choice colors for Choice/ChoiceList columns
        const colored = applyChoiceColor(plainText, raw, colType, pane.columns[ci]?.widgetOptions);
        line += t.colSeparator + padFn(colored, col.width);
      }
    }
    writeToBuffer(buf, dataStartRow + r, left, line, width);
  }
}

/**
 * Render a card (detail/single) pane. Shows one record at a time with
 * field labels and values listed vertically.
 * cursorRow = current record index, cursorCol = current field index.
 */
function renderCardPaneInto(
  buf: string[][], leaf: LayoutNode, pane: PaneState,
  isFocused: boolean, mode: AppMode, editValue: string, editCursorPos: number, t: Theme,
): void {
  const { top, left, width, height } = leaf;

  // Title bar (row 0)
  const tableName = pane.sectionInfo.title || pane.sectionInfo.tableId;
  const rowCount = pane.rowIds.length;
  const recNum = rowCount > 0 ? pane.cursorRow + 1 : 0;
  const titleText = ` ${tableName} (${recNum}/${rowCount}) `;
  const titleLine = truncate(titleText, width);
  const titleStyled = isFocused
    ? t.titleBar(padRight(titleLine, width))
    : t.titleBarDim(padRight(titleLine, width));
  writeToBuffer(buf, top, left, titleStyled, width);

  if (height < 3 || rowCount === 0) { return; }

  // Compute label width (max label length)
  const labelWidth = Math.min(
    Math.max(6, ...pane.columns.map(c => displayWidth(c.label))),
    Math.floor(width / 3),
  );
  const cardSep = t.colSeparator;
  const valueWidth = Math.max(4, width - labelWidth - cardSep.length);

  // Show fields for the current record, starting from scrollCol
  const fieldRows = height - 1; // rows available below title
  for (let f = 0; f < fieldRows; f++) {
    const fieldIdx = pane.scrollCol + f;
    if (fieldIdx >= pane.columns.length) { break; }
    const col = pane.columns[fieldIdx];
    const values = pane.colValues[col.colId];
    const raw = values ? values[pane.cursorRow] : null;
    const formatted = truncate(flattenToLine(formatCellValue(raw, col.type, col.widgetOptions, col.displayValues)), valueWidth);

    const isCurrentField = isFocused && fieldIdx === pane.cursorCol;
    const label = padRight(truncate(col.label, labelWidth), labelWidth);

    let line: string;
    if (mode === "editing" && isCurrentField) {
      const { text: editDisplay } = editWindow(editValue, editCursorPos, valueWidth);
      line = t.fieldLabel(label) + cardSep + t.cursor(editDisplay);
    } else if (isCurrentField) {
      line = t.fieldLabelActive(label) + cardSep + t.cursor(padRight(formatted, valueWidth));
    } else {
      const colored = applyChoiceColor(formatted, raw, col.type, col.widgetOptions);
      line = t.fieldLabel(label) + cardSep + padRight(colored, valueWidth);
    }
    writeToBuffer(buf, top + 1 + f, left, line, width);
  }
}

/**
 * Render a placeholder for chart sections (not renderable in terminal).
 */
function renderChartPlaceholder(
  buf: string[][], leaf: LayoutNode, pane: PaneState, isFocused: boolean, t: Theme,
): void {
  const { top, left, width, height } = leaf;

  const tableName = pane.sectionInfo.title || pane.sectionInfo.tableId;
  const titleText = ` ${tableName} [chart] `;
  const titleLine = truncate(titleText, width);
  const titleStyled = isFocused
    ? t.titleBar(padRight(titleLine, width))
    : t.titleBarDim(padRight(titleLine, width));
  writeToBuffer(buf, top, left, titleStyled, width);

  if (height >= 3) {
    const msg = "(chart not supported in console)";
    writeToBuffer(buf, top + 2, left, padRight("  " + msg, width), width);
  }
}

function computePaneColLayout(pane: PaneState, paneWidth: number): ColLayout[] {
  const maxWidth = 30;
  const minWidth = 4;
  return pane.columns.map((col) => {
    let width = displayWidth(col.label);
    const values = pane.colValues[col.colId];
    if (values) {
      const sampleSize = Math.min(values.length, 100);
      for (let i = 0; i < sampleSize; i++) {
        const formatted = flattenToLine(formatCellValue(values[i], col.type, col.widgetOptions, col.displayValues));
        width = Math.max(width, displayWidth(formatted));
      }
    }
    width = Math.max(minWidth, Math.min(maxWidth, width));
    return { colId: col.colId, label: col.label, width };
  });
}

/**
 * Write a styled string into the character buffer at a given position.
 * We write the raw string; ANSI codes pass through since buf cells are joined.
 */
function writeToBuffer(buf: string[][], row: number, col: number, text: string, maxWidth: number): void {
  if (row < 0 || row >= buf.length) { return; }
  // Replace the entire row segment with the text (ANSI codes make char counting unreliable,
  // so we use a single-cell approach: clear the range, then write the string into cell 0).
  buf[row][col] = text + " ".repeat(Math.max(0, maxWidth - displayWidth(stripAnsi(text))));
  // Clear remaining cells in this pane's range so they don't duplicate content
  for (let c = col + 1; c < Math.min(col + maxWidth, buf[row].length); c++) {
    buf[row][c] = "";
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function drawBorders(node: LayoutNode, buf: string[][], termCols: number, termRows: number, t: Theme): void {
  if (!node.children || node.children.length < 2) { return; }

  for (let i = 0; i < node.children.length - 1; i++) {
    const child: LayoutNode = node.children[i];

    if (node.direction === "vertical") {
      // Horizontal border between vertically stacked children
      const borderRow = child.top + child.height;
      if (borderRow >= 0 && borderRow < termRows) {
        for (let c = node.left; c < Math.min(node.left + node.width, termCols); c++) {
          if (buf[borderRow] && c < buf[borderRow].length) {
            buf[borderRow][c] = t.borderHoriz;
          }
        }
      }
    } else if (node.direction === "horizontal") {
      // Vertical border between horizontally arranged children
      const borderCol = child.left + child.width;
      if (borderCol >= 0 && borderCol < termCols) {
        for (let r = node.top; r < Math.min(node.top + node.height, termRows); r++) {
          if (buf[r] && borderCol < buf[r].length) {
            buf[r][borderCol] = t.borderVert;
          }
        }
      }
    }
  }

  // Recurse into children
  for (const child of node.children) {
    drawBorders(child, buf, termCols, termRows, t);
  }
}

export function isCardPane(pane: PaneState): boolean {
  const pk = pane.sectionInfo.parentKey;
  return pk === "single" || pk === "detail";
}

export function showCursor(): string {
  return SHOW_CURSOR;
}
