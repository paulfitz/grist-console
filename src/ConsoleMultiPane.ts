/**
 * Buffer-based renderer for multi-section pages.
 *
 * The single-pane grid renderer (renderGrid in ConsoleRenderer) emits ANSI
 * line-by-line. Multi-section pages need to compose several panes side-by-side
 * inside a layout tree, so this module renders into a 2D character buffer
 * and then flushes the buffer with cursor-positioning escapes.
 *
 * Rhymes with grist-core's ViewLayout + Pane components: ViewLayout owns
 * the buffer; renderPaneInto is the per-section dispatch (grid / card /
 * chart placeholder). Overlay mode is the equivalent of ViewLayout's
 * "expand one widget" gesture.
 */

import { formatCellValue } from "./ConsoleCellFormat.js";
import { LayoutNode, collectLeaves } from "./ConsoleLayout.js";
import { Theme } from "./ConsoleTheme.js";
import { AppMode, AppState, PaneState, isCardPane, paneTitle } from "./ConsoleAppState.js";
import {
  HIDE_CURSOR, SHOW_CURSOR, MOVE_TO, CLEAR_LINE,
  displayWidth, flattenToLine, truncate, padRight, padLeft, stripAnsi,
  applyChoiceColor, editWindow,
} from "./ConsoleDisplay.js";
import { getStatusLine, isNumericType } from "./ConsoleRenderer.js";
import { computeColLayout } from "./ConsoleLayout.js";
import { paintGoatIntoBuffer } from "./GoatAnimation.js";

export function renderMultiPane(state: AppState, termRows: number, termCols: number): string {
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
    renderPaneInto(buf, leaf, pane, leaf.paneIndex, isFocused, state.mode, state.editValue, state.editCursorPos, t);
  }

  // Paint the wandering goat INTO the buffer. writeToBuffer fills
  // cell-by-cell so this overwrites individual cells cleanly; each
  // line then hits the terminal with the goat already in place,
  // eliminating the grid-then-goat flash on terminals without DEC 2026.
  paintGoatIntoBuffer(state, buf, termCols);

  // Flatten buffer to string with ANSI positioning
  let output = HIDE_CURSOR + (t.screenBg || "") + MOVE_TO(0, 0);

  // Collapsed widget tray at top
  if (hasCollapsed) {
    output += MOVE_TO(0, 0) + renderCollapsedTray(state, termCols);
  }

  for (let r = 0; r < buf.length; r++) {
    output += MOVE_TO(r + trayHeight, 0) + buf[r].join("");
  }

  // Footer: help and status. Each line ends with CLEAR_LINE so shorter
  // content doesn't leave stale trailing chars from the previous render
  // (e.g. "Theme: matrix" -> "Theme: c64" leaving "rix" behind).
  const footerRow = termRows - 2;
  if (state.mode === "editing") {
    output += MOVE_TO(footerRow, 0) +
      t.helpBar("Type to edit  Enter:save  Esc:cancel") + CLEAR_LINE;
  } else if (state.mode === "confirm_delete") {
    const pane = state.panes[state.focusedPane];
    const rowId = pane ? pane.rowIds[pane.cursorRow] : "?";
    output += MOVE_TO(footerRow, 0) +
      t.helpBar(`Delete row ${rowId}? y:confirm  n/Esc:cancel`) + CLEAR_LINE;
  } else {
    const collapsedHint = hasCollapsed ? "  1-9:widget" : "";
    output += MOVE_TO(footerRow, 0) +
      t.helpBar(`\u2191\u2193\u2190\u2192:move  Tab:pane  Enter:edit  v:view  a:add  d:del  u:undo  p:pages${collapsedHint}  T:theme  q:quit`) +
      CLEAR_LINE;
  }
  output += MOVE_TO(termRows - 1, 0) + getStatusLine(state, termCols) + CLEAR_LINE;

  // Show terminal cursor at edit position when editing in a grid pane
  if (state.mode === "editing" && !state.cellViewerContent) {
    const paneIdx = state.overlayPaneIndex ?? state.focusedPane;
    const pane = state.panes[paneIdx];
    const leaf = leaves.find(l => l.paneIndex === paneIdx);
    if (pane && leaf && !isCardPane(pane)) {
      output += positionEditCursor(t, pane, leaf.top, leaf.left, trayHeight, state.editValue, state.editCursorPos);
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
    const name = paneTitle(pane);
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
  renderPaneInto(buf, overlayLeaf, pane, state.overlayPaneIndex!, true, state.mode, state.editValue, state.editCursorPos, t);

  paintGoatIntoBuffer(state, buf, termCols);

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
      t.helpBar("Type to edit  Enter:save  Esc:cancel") + CLEAR_LINE;
  } else {
    output += MOVE_TO(footerRow, 0) +
      t.helpBar("\u2191\u2193\u2190\u2192:move  Enter:edit  v:view  Esc:close  a:add  d:del") +
      CLEAR_LINE;
  }
  output += MOVE_TO(termRows - 1, 0) + getStatusLine(state, termCols) + CLEAR_LINE;

  // Show terminal cursor when editing in overlay
  if (state.mode === "editing" && !state.cellViewerContent && !isCardPane(pane)) {
    output += positionEditCursor(t, pane, 0, 0, trayHeight, state.editValue, state.editCursorPos);
  }

  return output;
}

/**
 * Compute and emit the ANSI sequence that places the terminal cursor at the
 * current edit position inside a grid pane. The cursor sits inside the
 * editable cell, accounting for horizontal scroll within the cell text.
 */
function positionEditCursor(
  t: Theme, pane: PaneState,
  paneTop: number, paneLeft: number, trayHeight: number,
  editValue: string, editCursorPos: number,
): string {
  const paneLayout = computeColLayout(pane);
  const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);
  const headerRows = t.headerSepLine ? 3 : 2;
  const editRow = paneTop + headerRows + (pane.cursorRow - pane.scrollRow) + trayHeight;
  let editCol = paneLeft + rowNumWidth + t.colSeparator.length;
  for (let ci = pane.scrollCol; ci < pane.cursorCol && ci < paneLayout.length; ci++) {
    editCol += paneLayout[ci].width + t.colSeparator.length;
  }
  const colWidth = paneLayout[pane.cursorCol]?.width || 0;
  const { cursorOffset } = editWindow(editValue, editCursorPos, colWidth);
  editCol += cursorOffset;
  return SHOW_CURSOR + MOVE_TO(editRow, editCol);
}

function renderPaneInto(
  buf: string[][], leaf: LayoutNode, pane: PaneState, paneIdx: number,
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
  const tableName = paneTitle(pane);
  const rowCount = pane.rowIds.length;
  writeTitleBar(buf, leaf, ` ${tableName} (${rowCount}) `, isFocused, t);

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
  const tableName = paneTitle(pane);
  const rowCount = pane.rowIds.length;
  const recNum = rowCount > 0 ? pane.cursorRow + 1 : 0;
  writeTitleBar(buf, leaf, ` ${tableName} (${recNum}/${rowCount}) `, isFocused, t);

  if (height < 3 || rowCount === 0) { return; }

  // Compute label width (max label length)
  let maxLabelWidth = 6;
  for (const c of pane.columns) {
    const w = displayWidth(c.label);
    if (w > maxLabelWidth) { maxLabelWidth = w; }
  }
  const labelWidth = Math.min(maxLabelWidth, Math.floor(width / 3));
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

  const tableName = paneTitle(pane);
  writeTitleBar(buf, leaf, ` ${tableName} [chart] `, isFocused, t);

  if (height >= 3) {
    const msg = "(chart not supported in console)";
    writeToBuffer(buf, top + 2, left, padRight("  " + msg, width), width);
  }
}

/**
 * Write a styled string into the character buffer at a given position.
 * We write the raw string; ANSI codes pass through since buf cells are joined.
 */
/**
 * Render a pane's title bar text and write it into the buffer at the leaf's
 * top-left corner. Focused panes get the bright title style; others are dim.
 */
function writeTitleBar(
  buf: string[][], leaf: LayoutNode, titleText: string, isFocused: boolean, t: Theme,
): void {
  const padded = padRight(truncate(titleText, leaf.width), leaf.width);
  const styled = isFocused ? t.titleBar(padded) : t.titleBarDim(padded);
  writeToBuffer(buf, leaf.top, leaf.left, styled, leaf.width);
}

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
