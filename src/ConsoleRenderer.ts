import { formatCellValue } from "./ConsoleCellFormat.js";
import { Theme } from "./ConsoleTheme.js";
import {
  CLEAR_LINE, MOVE_TO, HIDE_CURSOR, SHOW_CURSOR,
  displayWidth, flattenToLine, truncate, padRight, padLeft,
  applyChoiceColor, editWindow, extractUrls,
} from "./ConsoleDisplay.js";
import { AppState, PaneState, activeView } from "./ConsoleAppState.js";
import { renderMultiPane } from "./ConsoleMultiPane.js";

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

interface ColLayout {
  colId: string;
  label: string;
  width: number;
}

/**
 * Compute column widths based on header labels and sampled data.
 * Shared by the grid renderer and ConsoleInput's cursor-visibility logic.
 */
export function computeColLayout(pane: PaneState): ColLayout[] {
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
 * Get the status line content: show full cell value if the current cell is truncated,
 * otherwise show the statusMessage.
 */
export function getStatusLine(state: AppState, termCols: number): string {
  // Persistent warnings take priority and survive cursor moves that would
  // otherwise clear state.statusMessage.
  if (state.schemaStale) {
    return truncate("⚠ Schema changed - press r to refresh", termCols);
  }
  if (state.statusMessage) { return state.statusMessage; }
  if (state.mode === "editing") { return ""; }

  const pane = activeView(state);
  if (!pane) { return ""; }
  if (pane.cursorCol >= pane.columns.length) { return ""; }
  const col = pane.columns[pane.cursorCol];
  const values = pane.colValues[col.colId];
  const raw = values ? values[pane.cursorRow] : null;
  if (raw === null || raw === undefined) { return ""; }
  const full = flattenToLine(formatCellValue(raw, col.type, col.widgetOptions, col.displayValues));
  // Only show if it would be truncated (longer than typical column width)
  if (displayWidth(full) > 30) {
    return truncate(full, termCols);
  }
  return "";
}

export function isNumericType(colType: string): boolean {
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
    const urls = extractUrls(state.cellViewerContent);
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
  const pane = state.panes[state.focusedPane];
  if (!pane) {
    // Nothing loaded yet; just clear the screen with a minimal preamble.
    return screenPreamble(t) + CLEAR_LINE;
  }
  const lines: string[] = [];
  const layout = computeColLayout(pane);
  const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);

  // Determine visible columns based on scrollCol and terminal width
  let availWidth = termCols - rowNumWidth;
  const visibleCols: number[] = [];
  for (let c = pane.scrollCol; c < layout.length; c++) {
    const needed = layout[c].width + t.colSeparator.length;
    if (needed > availWidth) { break; }
    visibleCols.push(c);
    availWidth -= needed;
  }

  const headerRows = t.headerSepLine ? 3 : 2; // title, headers, [separator]
  const footerRows = 2; // help, status
  const dataRows = Math.max(1, termRows - headerRows - footerRows);

  // Title bar
  const rowCount = pane.rowIds.length;
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
    const rowIdx = pane.scrollRow + r;
    if (rowIdx >= pane.rowIds.length) {
      lines.push("");
      continue;
    }
    const rowId = pane.rowIds[rowIdx];
    let line = t.rowNumber(padLeft(String(rowId), rowNumWidth));
    for (const ci of visibleCols) {
      const col = layout[ci];
      const colType = pane.columns[ci]?.type || "Text";
      const values = pane.colValues[col.colId];
      const raw = values ? values[rowIdx] : null;
      const plainText = truncate(flattenToLine(formatCellValue(raw, colType, pane.columns[ci]?.widgetOptions, pane.columns[ci]?.displayValues)), col.width);
      const padFn = isNumericType(colType) ? padLeft : padRight;
      const isCurrentCell = (rowIdx === pane.cursorRow && ci === pane.cursorCol);

      if (state.mode === "editing" && isCurrentCell) {
        const { text: editDisplay } = editWindow(state.editValue, state.editCursorPos, col.width);
        line += t.colSeparator + t.cursor(editDisplay);
      } else if (isCurrentCell) {
        line += t.colSeparator + t.cursor(padFn(plainText, col.width));
      } else {
        const colored = applyChoiceColor(plainText, raw, colType, pane.columns[ci]?.widgetOptions);
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
    lines.push(t.helpBar(`Delete row ${pane.rowIds[pane.cursorRow]}? y:confirm  n/Esc:cancel`));
  } else {
    const pagesHint = state.pages.length > 0 ? "  p:pages" : "";
    lines.push(t.helpBar(`\u2191\u2193\u2190\u2192:move  Enter:edit  v:view  a:add  d:del  u:undo  t:tables${pagesHint}  T:theme  q:quit`));
  }

  // Status
  lines.push(getStatusLine(state, termCols));

  let result = screenPreamble(t) + lines.join(CLEAR_LINE + "\r\n") + CLEAR_LINE;

  // Show terminal cursor at edit position when editing
  if (state.mode === "editing" && !state.cellViewerContent) {
    const editRow = headerRows + (pane.cursorRow - pane.scrollRow);
    let editCol = rowNumWidth + t.colSeparator.length;
    for (const ci of visibleCols) {
      if (ci === pane.cursorCol) { break; }
      editCol += layout[ci].width + t.colSeparator.length;
    }
    const colWidth = layout[pane.cursorCol]?.width || 0;
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


export function showCursor(): string {
  return SHOW_CURSOR;
}
