import { BulkColValues, CellValue, ColumnInfo } from "./types.js";
import { formatCellValue } from "./ConsoleCellFormat.js";
import { LayoutNode, collectLeaves } from "./ConsoleLayout.js";
import { Theme } from "./ConsoleTheme.js";
import {
  CLEAR_LINE, MOVE_TO, HIDE_CURSOR, SHOW_CURSOR,
  displayWidth, flattenToLine, truncate, padRight, padLeft, stripAnsi,
  applyChoiceColor, editWindow, extractUrls,
} from "./ConsoleDisplay.js";

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

import { AppMode, AppState, PaneState, isCardPane, activeView } from "./ConsoleAppState.js";

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
function getStatusLine(state: AppState, termCols: number): string {
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
      t.helpBar(`\u2191\u2193\u2190\u2192:move  Tab:pane  Enter:edit  v:view  a:add  d:del  u:undo  p:pages${collapsedHint}  T:theme  q:quit`);
  }
  output += MOVE_TO(termRows - 1, 0) + getStatusLine(state, termCols);

  // Show terminal cursor at edit position when editing in a grid pane
  if (state.mode === "editing" && !state.cellViewerContent) {
    const paneIdx = state.overlayPaneIndex ?? state.focusedPane;
    const pane = state.panes[paneIdx];
    const leaf = leaves.find(l => l.paneIndex === paneIdx);
    if (pane && leaf && !isCardPane(pane)) {
      const paneLayout = computeColLayout(pane);
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
    const name = pane.sectionInfo?.title || pane.sectionInfo?.tableId || "";
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
    const paneLayout = computeColLayout(pane);
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

  const pk = pane.sectionInfo?.parentKey;
  if (pk === "single" || pk === "detail") {
    renderCardPaneInto(buf, leaf, pane, isFocused, mode, editValue, editCursorPos, t);
    return;
  }
  if (pk === "chart") {
    renderChartPlaceholder(buf, leaf, pane, isFocused, t);
    return;
  }

  const layout = computeColLayout(pane);
  const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);

  // Title bar (row 0)
  const tableName = pane.sectionInfo?.title || pane.sectionInfo?.tableId || "";
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
  const tableName = pane.sectionInfo?.title || pane.sectionInfo?.tableId || "";
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

  const tableName = pane.sectionInfo?.title || pane.sectionInfo?.tableId || "";
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

export function showCursor(): string {
  return SHOW_CURSOR;
}
