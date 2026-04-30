import { formatCellValue } from "./ConsoleCellFormat.js";
import { Theme } from "./ConsoleTheme.js";
import {
  CLEAR_LINE, MOVE_TO, HIDE_CURSOR, SHOW_CURSOR,
  displayWidth, flattenToLine, truncate, padRight, padLeft,
  applyChoiceColor, editWindow, extractUrls,
} from "./ConsoleDisplay.js";
import { AppState, PaneState, activeView } from "./ConsoleAppState.js";
import { renderMultiPane } from "./ConsoleMultiPane.js";
import { computeColLayout } from "./ConsoleLayout.js";
import { formatRelativeTime } from "./SiteApi.js";
import { renderGoatOverlay, goatStatus } from "./GoatAnimation.js";
import { isGoatTheme } from "./ConsoleTheme.js";

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
  // Goat theme keeps a running commentary in the status line when idle.
  if (isGoatTheme(state.theme)) {
    const chatter = goatStatus(state);
    if (chatter) { return truncate(chatter, termCols); }
  }
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
  if (state.mode === "help") {
    return renderHelp(state, termRows, termCols);
  }
  if (state.mode === "site_picker") {
    return renderSitePicker(state, termRows, termCols);
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
    const urlHint = urls.length > 0 ? "  Tab:link" : "";
    const enterHint = state.cellViewerLinkIndex >= 0 ? "Enter:open" : "Enter:edit";
    lines.push(t.helpBar(`\u2191\u2193:scroll  ${enterHint}${urlHint}  Esc:close  ^C:quit${scrollInfo}`));
    if (state.cellViewerLinkIndex >= 0 && state.cellViewerLinkIndex < urls.length) {
      lines.push(`link ${state.cellViewerLinkIndex + 1}/${urls.length}: ${urls[state.cellViewerLinkIndex]}`);
    } else {
      lines.push("");
    }
  }

  let result = screenPreamble(t) + lines.join(CLEAR_LINE + "\r\n") + CLEAR_LINE;

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

/**
 * Static keyboard reference -- mirrors README.md but kept in code so the
 * help screen is guaranteed to ship with the binary.
 */
const HELP_LINES: string[] = [
  "",
  "  PICKERS  (site / pages / tables)",
  "    ↑ ↓                Move",
  "    Enter              Open",
  "    Tab                Swap pages ↔ tables",
  "    s                  Site list (when launched against a site)",
  "    T  /  F12          Cycle theme",
  "    ^C  /  ^Q          Quit",
  "",
  "  GRID  (one or more table panes on a page)",
  "    Arrows / Tab       Move one cell",
  "    Page Up / Down     Scroll a page",
  "    Home / End         First / last column of the row",
  "    ^Home / ^End       First / last cell of the table",
  "    ^↑ / ^↓            First / last record",
  "    ^← / ^→            First / last column",
  "    <type>             Edit cell, replacing its value",
  "    Enter / F2         Edit cell, keeping its value",
  "    Backspace          Edit with the cell empty",
  "    Delete             Clear the cell",
  "    ^Enter / F7        Add a row",
  "    ^Delete / F8       Delete the row",
  "    F3                 Open the full-cell viewer",
  "    F6 / Shift-F6      Next / previous pane",
  "    Alt+1 ... Alt+9    Open a collapsed widget full-screen",
  "    ^Z                 Undo (this session)",
  "    ^Y / ^Shift+Z      Redo",
  "    ^R / F5            Refresh",
  "    F4                 Tables picker",
  "    Esc                Pages picker",
  "    F12                Cycle theme",
  "    ^Q / ^C            Quit",
  "",
  "  CARD  (one record per page, fields stacked)",
  "    ↑ ↓                Previous / next field",
  "    ← → / ^↑↓ / PgUp/Dn   Flip records",
  "    Type / Enter       Edit, same as grid",
  "",
  "  CELL VIEWER  (F3)",
  "    ↑↓ / PgUp/Dn / Home/End   Scroll content",
  "    Tab / Shift-Tab           Cycle URLs in the cell",
  "    Enter                     Open URL or start editing",
  "    Esc / F3                  Close",
  "",
  "  EDITING A CELL",
  "    Enter              Save",
  "    Esc                Cancel",
  "    ← → / Home / End   Move within the text",
  "",
  "  BOOLEAN CELLS",
  "    Enter, Space, or any printable key flips the value.",
  "    Backspace / Delete clears it to false.",
  "",
  "  HELP",
  "    F1 or ?            Open this help",
  "    ↑↓ / PgUp/Dn       Scroll",
  "    Esc / F1 / ?       Close",
  "",
];

function renderHelp(state: AppState, termRows: number, termCols: number): string {
  const t = state.theme;
  const lines: string[] = [];

  const title = t.pickerTitleFormat("grist-console — keys");
  lines.push(t.titleBar(padRight(title, termCols)));

  const dataRows = Math.max(1, termRows - 3); // title + help bar + status
  const maxScroll = Math.max(0, HELP_LINES.length - dataRows);
  if (state.helpScroll > maxScroll) { state.helpScroll = maxScroll; }
  for (let r = 0; r < dataRows; r++) {
    const idx = state.helpScroll + r;
    lines.push(idx < HELP_LINES.length ? padRight(HELP_LINES[idx], termCols) : "");
  }

  const scrollHint = HELP_LINES.length > dataRows
    ? `  (${state.helpScroll + 1}-${Math.min(state.helpScroll + dataRows, HELP_LINES.length)}/${HELP_LINES.length})`
    : "";
  lines.push(t.helpBar(`↑↓:scroll  Esc/F1:close  ^C:quit${scrollHint}`));
  lines.push(getStatusLine(state, termCols));

  return screenPreamble(t) + lines.join(CLEAR_LINE + "\r\n") + CLEAR_LINE;
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
  const pagesHint = state.pages.length > 0 ? "  Tab:pages" : "";
  const siteHint = state.hasSiteContext ? "  s:site" : "";
  lines.push(t.helpBar(`\u2191\u2193:select  Enter:open${pagesHint}${siteHint}  T:theme  F1:help  ^C:quit`));

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
  const sepWidth = displayWidth(t.colSeparator);
  let availWidth = termCols - rowNumWidth;
  const visibleCols: number[] = [];
  for (let c = pane.scrollCol; c < layout.length; c++) {
    const needed = layout[c].width + sepWidth;
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
    const pagesHint = state.pages.length > 0 ? "  Esc:pages" : "";
    lines.push(t.helpBar(`type:edit  Enter:edit  F3:view  ^Enter:add  ^Del:del  ^Z:undo  F4:tables${pagesHint}  F1:help  ^C:quit`));
  }

  // Status
  lines.push(getStatusLine(state, termCols));

  let result = screenPreamble(t) + lines.join(CLEAR_LINE + "\r\n") + CLEAR_LINE;

  // Overlay the wandering goat if the theme is active. Screen-coord
  // based so the multi-line ASCII art paints cleanly over the grid.
  result += renderGoatOverlay(state, 0, termRows, termCols);

  // Show terminal cursor at edit position when editing
  if (state.mode === "editing" && !state.cellViewerContent) {
    const editRow = headerRows + (pane.cursorRow - pane.scrollRow);
    let editCol = rowNumWidth + sepWidth;
    for (const ci of visibleCols) {
      if (ci === pane.cursorCol) { break; }
      editCol += layout[ci].width + sepWidth;
    }
    const colWidth = layout[pane.cursorCol]?.width || 0;
    const { cursorOffset } = editWindow(state.editValue, state.editCursorPos, colWidth);
    editCol += cursorOffset;
    result += SHOW_CURSOR + MOVE_TO(editRow, editCol);
  }

  return result;
}

/**
 * Three-column flat list of docs across the site, sorted most-recent
 * first. Doc-name column gets ~half the width; workspace + relative-time
 * share the rest. The cursor row is highlighted with the same pickerSelected
 * style the table/page pickers use.
 */
function renderSitePicker(state: AppState, termRows: number, termCols: number): string {
  const t = state.theme;
  const lines: string[] = [];

  const title = t.pickerTitleFormat(state.siteDocs.length === 0
    ? "No docs found"
    : `Open a doc  (${state.siteDocs.length})`);
  lines.push(t.titleBar(padRight(title, termCols)));
  lines.push("");

  // Column widths. Reserve 4 cells for the "  > " / "    " prefix.
  const prefixWidth = 4;
  const avail = Math.max(20, termCols - prefixWidth - 2);
  const timeWidth = 14;
  const wsWidth = Math.min(24, Math.max(10, Math.floor(avail * 0.3)));
  const nameWidth = Math.max(10, avail - wsWidth - timeWidth - 4);

  const visibleCount = Math.min(state.siteDocs.length, termRows - 5);
  // Scroll so the cursor stays in view.
  const scroll = Math.max(0,
    Math.min(state.siteDocs.length - visibleCount,
      state.siteCursor - Math.floor(visibleCount / 2)));
  const now = new Date();
  for (let i = 0; i < visibleCount; i++) {
    const idx = scroll + i;
    if (idx >= state.siteDocs.length) { lines.push(""); continue; }
    const d = state.siteDocs[idx];
    const name = padRight(truncate(d.name, nameWidth), nameWidth);
    const ws = padRight(truncate(d.workspaceName, wsWidth), wsWidth);
    const when = padRight(truncate(formatRelativeTime(d.updatedAt, now), timeWidth), timeWidth);
    const row = `${name}  ${ws}  ${when}`;
    if (idx === state.siteCursor) {
      lines.push(`  ${t.pickerSelected(` > ${row} `)}`);
    } else {
      lines.push(`     ${row}`);
    }
  }
  while (lines.length < termRows - 2) { lines.push(""); }

  lines.push(t.helpBar("↑↓:select  Enter:open  T:theme  F1:help  ^C:quit"));
  lines.push(getStatusLine(state, termCols));

  return screenPreamble(t) + lines.join(CLEAR_LINE + "\r\n") + CLEAR_LINE;
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

  const siteHint = state.hasSiteContext ? "  s:site" : "";
  lines.push(t.helpBar(`\u2191\u2193:select  Enter:open  Tab:tables${siteHint}  T:theme  F1:help  ^C:quit`));
  lines.push(getStatusLine(state, termCols));

  // Clear to end of line after each line to overwrite any stale content
  // left from previous renders without clearing the whole screen (flicker).
  return screenPreamble(t) + lines.join(CLEAR_LINE + "\r\n") + CLEAR_LINE;
}


export function showCursor(): string {
  return SHOW_CURSOR;
}
