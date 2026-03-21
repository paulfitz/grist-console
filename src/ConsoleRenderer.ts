import { BulkColValues, ColumnInfo } from "./types";
import { formatCellValue } from "./ConsoleCellFormat";
import { BoxSpec, LayoutNode, PageInfo, SectionInfo, collectLeaves } from "./ConsoleLayout";
import { Theme, defaultTheme } from "./ConsoleTheme";

// ANSI escape codes (non-stylistic, always needed)
const ESC = "\x1b[";
const CLEAR_SCREEN = `${ESC}2J`;
const MOVE_TO = (row: number, col: number) => `${ESC}${row + 1};${col + 1}H`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;

/**
 * Build the screen preamble: hide cursor, set background color, clear screen.
 * For themes with a screenBg (e.g. blue background), the bg SGR is set before
 * clearing so the entire terminal fills with that color.
 */
function screenPreamble(t: Theme): string {
  return HIDE_CURSOR + (t.screenBg || "") + CLEAR_SCREEN + MOVE_TO(0, 0);
}

export type AppMode = "table_picker" | "page_picker" | "grid" | "editing" | "confirm_delete";

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
    let width = col.label.length;
    const values = state.colValues[col.colId];
    if (values) {
      const sampleSize = Math.min(values.length, 100);
      for (let i = 0; i < sampleSize; i++) {
        const formatted = formatCellValue(values[i], col.type, col.widgetOptions, col.displayValues);
        width = Math.max(width, formatted.length);
      }
    }
    width = Math.max(minWidth, Math.min(maxWidth, width));
    return { colId: col.colId, label: col.label, width };
  });
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) { return s; }
  return s.slice(0, maxLen - 1) + "\u2026";
}

function padRight(s: string, width: number): string {
  if (s.length >= width) { return s.slice(0, width); }
  return s + " ".repeat(width - s.length);
}

function padLeft(s: string, width: number): string {
  if (s.length >= width) { return s.slice(0, width); }
  return " ".repeat(width - s.length) + s;
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
  lines.push(t.helpBar("\u2191\u2193:select  Enter:open  T:theme  q:quit"));

  // Status
  lines.push(state.statusMessage || "");

  return screenPreamble(t) + lines.join("\n");
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
      let formatted = truncate(formatCellValue(raw, colType, state.columns[ci]?.widgetOptions, state.columns[ci]?.displayValues), col.width);
      const pad = isNumericType(colType) ? padLeft : padRight;
      formatted = pad(formatted, col.width);

      const isCurrentCell = (rowIdx === state.cursorRow && ci === state.cursorCol);

      if (state.mode === "editing" && isCurrentCell) {
        const editDisplay = padRight(truncate(state.editValue, col.width), col.width);
        line += t.colSeparator + t.cursor(editDisplay);
      } else if (isCurrentCell) {
        line += t.colSeparator + t.cursor(formatted);
      } else {
        line += t.colSeparator + formatted;
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
    lines.push(t.helpBar("\u2191\u2193\u2190\u2192:move  Enter:edit  a:add  d:del  t:tables  T:theme  q:quit"));
  }

  // Status
  lines.push(state.statusMessage || "");

  return screenPreamble(t) + lines.join("\n");
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
  lines.push(state.statusMessage || "");

  return screenPreamble(t) + lines.join("\n");
}

function renderMultiPane(state: AppState, termRows: number, termCols: number): string {
  const t = state.theme;
  // Build a character buffer for the whole screen
  const buf: string[][] = [];
  for (let r = 0; r < termRows - 2; r++) {
    buf.push(new Array(termCols).fill(" "));
  }

  const leaves = collectLeaves(state.layout!);

  // Draw borders between split children
  drawBorders(state.layout!, buf, termCols, termRows - 2, t);

  // Draw each pane
  for (const leaf of leaves) {
    if (leaf.paneIndex === undefined) { continue; }
    const pane = state.panes[leaf.paneIndex];
    if (!pane) { continue; }
    const isFocused = leaf.paneIndex === state.focusedPane;
    renderPaneInto(buf, leaf, pane, isFocused, state.mode, state.editValue, t);
  }

  // Flatten buffer to string with ANSI positioning
  let output = HIDE_CURSOR + (t.screenBg || "") + CLEAR_SCREEN;
  for (let r = 0; r < buf.length; r++) {
    output += MOVE_TO(r, 0) + buf[r].join("");
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
    output += MOVE_TO(footerRow, 0) +
      t.helpBar("\u2191\u2193\u2190\u2192:move  Tab:pane  Enter:edit  a:add  d:del  p:pages  T:theme  q:quit");
  }
  output += MOVE_TO(termRows - 1, 0) + (state.statusMessage || "");

  return output;
}

function renderPaneInto(
  buf: string[][], leaf: LayoutNode, pane: PaneState,
  isFocused: boolean, mode: AppMode, editValue: string, t: Theme,
): void {
  const { top, left, width, height } = leaf;
  if (width < 3 || height < 2) { return; }

  const pk = pane.sectionInfo.parentKey;
  if (pk === "single" || pk === "detail") {
    renderCardPaneInto(buf, leaf, pane, isFocused, mode, editValue, t);
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
      let formatted = truncate(formatCellValue(raw, colType, pane.columns[ci]?.widgetOptions, pane.columns[ci]?.displayValues), col.width);
      const pad = isNumericType(colType) ? padLeft : padRight;
      formatted = pad(formatted, col.width);

      const isCurrentCell = isFocused && rowIdx === pane.cursorRow && ci === pane.cursorCol;

      if (mode === "editing" && isCurrentCell) {
        const editDisplay = padRight(truncate(editValue, col.width), col.width);
        line += t.colSeparator + t.cursor(editDisplay);
      } else if (isCurrentCell) {
        line += t.colSeparator + t.cursor(formatted);
      } else {
        line += t.colSeparator + formatted;
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
  isFocused: boolean, mode: AppMode, editValue: string, t: Theme,
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
    Math.max(6, ...pane.columns.map(c => c.label.length)),
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
    const formatted = truncate(formatCellValue(raw, col.type, col.widgetOptions, col.displayValues), valueWidth);

    const isCurrentField = isFocused && fieldIdx === pane.cursorCol;
    const label = padRight(truncate(col.label, labelWidth), labelWidth);

    let line: string;
    if (mode === "editing" && isCurrentField) {
      const editDisplay = padRight(truncate(editValue, valueWidth), valueWidth);
      line = t.fieldLabel(label) + cardSep + t.cursor(editDisplay);
    } else if (isCurrentField) {
      line = t.fieldLabelActive(label) + cardSep + t.cursor(padRight(formatted, valueWidth));
    } else {
      line = t.fieldLabel(label) + cardSep + padRight(formatted, valueWidth);
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
    let width = col.label.length;
    const values = pane.colValues[col.colId];
    if (values) {
      const sampleSize = Math.min(values.length, 100);
      for (let i = 0; i < sampleSize; i++) {
        const formatted = formatCellValue(values[i], col.type, col.widgetOptions, col.displayValues);
        width = Math.max(width, formatted.length);
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
  buf[row][col] = text + " ".repeat(Math.max(0, maxWidth - stripAnsi(text).length));
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
