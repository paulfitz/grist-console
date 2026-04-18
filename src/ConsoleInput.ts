import { AppMode, AppState, isCardPane, PaneState, activeView } from "./ConsoleAppState.js";
import { displayWidth, extractUrls } from "./ConsoleDisplay.js";
import { CellValue } from "./types.js";
import { collectLeaves, LayoutNode } from "./ConsoleLayout.js";
import { parseCellInput, formatCellValue } from "./ConsoleCellFormat.js";
import { ConsoleConnection } from "./ConsoleConnection.js";
import { computeColLayout } from "./ConsoleRenderer.js";

/**
 * Ensure scrollCol is adjusted so cursorCol is visible.
 * Uses the same column-width computation as the grid renderer.
 */
export function ensureColVisible(pane: PaneState, availWidth: number): void {
  if (pane.cursorCol < pane.scrollCol) {
    pane.scrollCol = pane.cursorCol;
    return;
  }
  const colLayout = computeColLayout(pane);
  const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);
  const sepLen = 3; // " | "

  // Check if cursorCol is visible from current scrollCol
  let used = rowNumWidth;
  for (let c = pane.scrollCol; c <= pane.cursorCol; c++) {
    used += sepLen + (colLayout[c]?.width || 4);
  }
  if (used <= availWidth) { return; }

  // Scroll right until cursorCol fits
  while (pane.scrollCol < pane.cursorCol) {
    pane.scrollCol++;
    used = rowNumWidth;
    for (let c = pane.scrollCol; c <= pane.cursorCol; c++) {
      used += sepLen + (colLayout[c]?.width || 4);
    }
    if (used <= availWidth) { return; }
  }
  // Last resort: cursor is the first visible column
  pane.scrollCol = pane.cursorCol;
}

function getLeafForPane(state: AppState, paneIndex: number): LayoutNode | undefined {
  if (!state.layout) { return undefined; }
  return collectLeaves(state.layout).find(l => l.paneIndex === paneIndex);
}

/**
 * For a linked card pane, find the pane whose cursorRow should be moved
 * when navigating records. Walks up the link chain to find the source.
 * For unlinked card panes, returns the pane itself.
 */
function findCardRecordTarget(state: AppState, pane: PaneState): PaneState {
  const srcRef = pane.sectionInfo?.linkSrcSectionRef;
  if (!srcRef) { return pane; }
  const srcPane = state.panes.find(p => p.sectionInfo?.sectionId === srcRef);
  if (!srcPane) { return pane; }
  // If the source is also a card pane, recurse up the chain
  if (isCardPane(srcPane)) {
    return findCardRecordTarget(state, srcPane);
  }
  return srcPane;
}

export type InputAction =
  | { type: "none" }
  | { type: "quit" }
  | { type: "render" }
  | { type: "select_table" }
  | { type: "select_page" }
  | { type: "refresh" }
  | { type: "save_edit" }
  | { type: "add_row" }
  | { type: "delete_row" }
  | { type: "switch_to_tables" }
  | { type: "switch_to_pages" }
  | { type: "focus_next_pane" }
  | { type: "focus_prev_pane" }
  | { type: "cycle_theme" }
  | { type: "close_overlay" }
  | { type: "view_cell" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "open_url"; url: string };

/**
 * Parse a raw keypress buffer into a key name.
 */
function parseKey(buf: Buffer): string {
  // Arrow keys and special keys
  if (buf[0] === 0x1b) {
    if (buf[1] === 0x5b) {
      // Shift-Tab: ESC [ Z
      if (buf[2] === 0x5a) { return "shift-tab"; }
      switch (buf[2]) {
        case 0x41: return "up";
        case 0x42: return "down";
        case 0x43: return "right";
        case 0x44: return "left";
        case 0x48: return "home";
        case 0x46: return "end";
        case 0x35: if (buf[3] === 0x7e) { return "pageup"; } break;
        case 0x36: if (buf[3] === 0x7e) { return "pagedown"; } break;
        case 0x33: if (buf[3] === 0x7e) { return "delete"; } break;
      }
    }
    if (buf.length === 1) { return "escape"; }
    return "unknown";
  }
  if (buf[0] === 0x03) { return "ctrl-c"; }
  if (buf[0] === 0x0d) { return "enter"; }
  if (buf[0] === 0x7f) { return "backspace"; }
  if (buf[0] === 0x09) { return "tab"; }
  if (buf.length === 1 && buf[0] >= 0x20 && buf[0] < 0x7f) {
    return String.fromCharCode(buf[0]);
  }
  // Multi-byte UTF-8 character
  if (buf[0] > 0x7f) {
    return buf.toString("utf8");
  }
  return "unknown";
}

/**
 * Handle a keypress in table picker mode.
 */
function handleTablePickerKey(key: string, state: AppState): InputAction {
  const pageSize = Math.max(1, (process.stdout.rows || 24) - 5);
  switch (key) {
    case "up":
      if (state.selectedTableIndex > 0) {
        state.selectedTableIndex--;
      }
      return { type: "render" };
    case "down":
      if (state.selectedTableIndex < state.tableIds.length - 1) {
        state.selectedTableIndex++;
      }
      return { type: "render" };
    case "pageup":
      state.selectedTableIndex = Math.max(0, state.selectedTableIndex - pageSize);
      return { type: "render" };
    case "pagedown":
      state.selectedTableIndex = Math.min(state.tableIds.length - 1, state.selectedTableIndex + pageSize);
      return { type: "render" };
    case "home":
      state.selectedTableIndex = 0;
      return { type: "render" };
    case "end":
      state.selectedTableIndex = Math.max(0, state.tableIds.length - 1);
      return { type: "render" };
    case "enter":
      return { type: "select_table" };
    case "p":
    case "escape":
      if (state.pages.length > 0) {
        return { type: "switch_to_pages" };
      }
      return { type: "none" };
    case "T":
      return { type: "cycle_theme" };
    case "q":
    case "ctrl-c":
      return { type: "quit" };
    default:
      return { type: "none" };
  }
}

/**
 * Handle a keypress in edit mode.
 */
function editReturnMode(state: AppState): AppMode {
  if (state.cellViewerContent) { return "cell_viewer"; }
  if (state.overlayPaneIndex !== null) { return "overlay"; }
  return "grid";
}

function handleEditKey(key: string, state: AppState): InputAction {
  switch (key) {
    case "escape":
      state.mode = editReturnMode(state);
      state.statusMessage = "";
      return { type: "render" };
    case "enter":
      return { type: "save_edit" };
    case "backspace":
      if (state.editCursorPos > 0) {
        state.editValue =
          state.editValue.slice(0, state.editCursorPos - 1) +
          state.editValue.slice(state.editCursorPos);
        state.editCursorPos--;
      }
      return { type: "render" };
    case "delete":
      if (state.editCursorPos < state.editValue.length) {
        state.editValue =
          state.editValue.slice(0, state.editCursorPos) +
          state.editValue.slice(state.editCursorPos + 1);
      }
      return { type: "render" };
    case "left":
      if (state.editCursorPos > 0) {
        state.editCursorPos--;
      }
      return { type: "render" };
    case "right":
      if (state.editCursorPos < state.editValue.length) {
        state.editCursorPos++;
      }
      return { type: "render" };
    case "home":
      state.editCursorPos = 0;
      return { type: "render" };
    case "end":
      state.editCursorPos = state.editValue.length;
      return { type: "render" };
    default:
      // Insert character at cursor position
      if (key.length === 1 || key.charCodeAt(0) > 127) {
        state.editValue =
          state.editValue.slice(0, state.editCursorPos) +
          key +
          state.editValue.slice(state.editCursorPos);
        state.editCursorPos += key.length;
        return { type: "render" };
      }
      return { type: "none" };
  }
}

/**
 * Handle a keypress in confirm_delete mode.
 */
function handleConfirmDeleteKey(key: string, state: AppState): InputAction {
  const returnMode = state.overlayPaneIndex !== null ? "overlay" as const : "grid" as const;
  switch (key) {
    case "y":
      state.mode = returnMode;
      return { type: "delete_row" };
    case "n":
    case "escape":
      state.mode = returnMode;
      state.statusMessage = "";
      return { type: "render" };
    default:
      return { type: "none" };
  }
}

/**
 * Handle a keypress in page picker mode.
 */
function handlePagePickerKey(key: string, state: AppState): InputAction {
  const pageSize = Math.max(1, (process.stdout.rows || 24) - 5);
  switch (key) {
    case "up":
      if (state.selectedPageIndex > 0) {
        state.selectedPageIndex--;
      }
      return { type: "render" };
    case "down":
      if (state.selectedPageIndex < state.pages.length - 1) {
        state.selectedPageIndex++;
      }
      return { type: "render" };
    case "pageup":
      state.selectedPageIndex = Math.max(0, state.selectedPageIndex - pageSize);
      return { type: "render" };
    case "pagedown":
      state.selectedPageIndex = Math.min(state.pages.length - 1, state.selectedPageIndex + pageSize);
      return { type: "render" };
    case "home":
      state.selectedPageIndex = 0;
      return { type: "render" };
    case "end":
      state.selectedPageIndex = Math.max(0, state.pages.length - 1);
      return { type: "render" };
    case "enter":
      return { type: "select_page" };
    case "t":
      return { type: "switch_to_tables" };
    case "T":
      return { type: "cycle_theme" };
    case "q":
    case "ctrl-c":
      return { type: "quit" };
    default:
      return { type: "none" };
  }
}

/**
 * Handle a keypress in multi-pane grid mode.
 */
/**
 * Movement + edit triggers shared by the multi-pane grid and the overlay view.
 * Returns an InputAction, or "none" if the key wasn't handled here so the caller
 * can try its mode-specific bindings.
 */
function handleGridViewKey(
  key: string, state: AppState, pane: PaneState, availWidth: number,
): InputAction {
  const termRows = process.stdout.rows || 24;
  const pageSize = Math.max(1, termRows - 5);

  switch (key) {
    case "up":
      if (pane.cursorRow > 0) {
        pane.cursorRow--;
        if (pane.cursorRow < pane.scrollRow) {
          pane.scrollRow = pane.cursorRow;
        }
      }
      return { type: "render" };
    case "down":
      if (pane.cursorRow < pane.rowIds.length - 1) {
        pane.cursorRow++;
        const dataRows = Math.max(1, termRows - 5);
        if (pane.cursorRow >= pane.scrollRow + dataRows) {
          pane.scrollRow = pane.cursorRow - dataRows + 1;
        }
      }
      return { type: "render" };
    case "left":
      if (pane.cursorCol > 0) {
        pane.cursorCol--;
        ensureColVisible(pane, availWidth);
      }
      return { type: "render" };
    case "right":
      if (pane.cursorCol < pane.columns.length - 1) {
        pane.cursorCol++;
        ensureColVisible(pane, availWidth);
      }
      return { type: "render" };
    case "pageup":
      pane.cursorRow = Math.max(0, pane.cursorRow - pageSize);
      pane.scrollRow = Math.max(0, pane.scrollRow - pageSize);
      return { type: "render" };
    case "pagedown":
      pane.cursorRow = Math.min(pane.rowIds.length - 1, pane.cursorRow + pageSize);
      pane.scrollRow = Math.min(
        Math.max(0, pane.rowIds.length - pageSize),
        pane.scrollRow + pageSize
      );
      return { type: "render" };
    case "home":
      pane.cursorRow = 0;
      pane.scrollRow = 0;
      return { type: "render" };
    case "end":
      pane.cursorRow = Math.max(0, pane.rowIds.length - 1);
      pane.scrollRow = Math.max(0, pane.rowIds.length - pageSize);
      return { type: "render" };
    case "enter":
      if (pane.rowIds.length > 0 && pane.columns.length > 0) {
        enterPaneEditMode(state, pane);
      }
      return { type: "render" };
    case "a":
      return { type: "add_row" };
    case "d":
      if (pane.rowIds.length > 0) {
        state.mode = "confirm_delete";
      }
      return { type: "render" };
    case "v":
      return { type: "view_cell" };
    case "q":
    case "ctrl-c":
      return { type: "quit" };
    default:
      return { type: "none" };
  }
}

function handleMultiPaneGridKey(key: string, state: AppState): InputAction {
  const pane = state.panes[state.focusedPane];
  if (!pane) { return { type: "none" }; }

  if (isCardPane(pane)) {
    return handleCardPaneKey(key, state, pane);
  }

  switch (key) {
    case "tab":
      return { type: "focus_next_pane" };
    case "shift-tab":
      return { type: "focus_prev_pane" };
    case "u":
      return { type: "undo" };
    case "U":
      return { type: "redo" };
    case "escape":
    case "p":
      return { type: "switch_to_pages" };
    case "r":
      return { type: "refresh" };
    case "t":
      return { type: "switch_to_tables" };
    case "T":
      return { type: "cycle_theme" };
  }

  // Number keys 1-9: open collapsed widget overlay
  if (/^[1-9]$/.test(key) && state.collapsedPaneIndices.length > 0) {
    const idx = parseInt(key, 10) - 1;
    if (idx < state.collapsedPaneIndices.length) {
      state.overlayPaneIndex = state.collapsedPaneIndices[idx];
      state.mode = "overlay";
      return { type: "render" };
    }
  }

  const leaf = getLeafForPane(state, state.focusedPane);
  const availWidth = leaf?.width || (process.stdout.columns || 80);
  return handleGridViewKey(key, state, pane, availWidth);
}

/**
 * Handle keys for a card (single/detail) pane.
 * Up/down navigates fields, left/right switches records.
 */
function handleCardPaneKey(key: string, state: AppState, pane: PaneState): InputAction {
  switch (key) {
    case "tab":
      return { type: "focus_next_pane" };
    case "shift-tab":
      return { type: "focus_prev_pane" };
    case "up":
      // Move to previous field
      if (pane.cursorCol > 0) {
        pane.cursorCol--;
        if (pane.cursorCol < pane.scrollCol) {
          pane.scrollCol = pane.cursorCol;
        }
      }
      return { type: "render" };
    case "down":
      // Move to next field
      if (pane.cursorCol < pane.columns.length - 1) {
        pane.cursorCol++;
        // scrollCol is used as field scroll offset in card mode
        // Leaf height minus title bar = available field rows
        const leaf = getLeafForPane(state, state.focusedPane);
        const fieldRows = leaf ? leaf.height - 1 : 10;
        if (pane.cursorCol >= pane.scrollCol + fieldRows) {
          pane.scrollCol = pane.cursorCol - fieldRows + 1;
        }
      }
      return { type: "render" };
    case "left": {
      // Previous record — if linked, move the source pane's cursor instead
      const targetLeft = findCardRecordTarget(state, pane);
      if (targetLeft.cursorRow > 0) {
        targetLeft.cursorRow--;
      }
      return { type: "render" };
    }
    case "right": {
      // Next record — if linked, move the source pane's cursor instead
      const targetRight = findCardRecordTarget(state, pane);
      if (targetRight.cursorRow < targetRight.rowIds.length - 1) {
        targetRight.cursorRow++;
      }
      return { type: "render" };
    }
    case "home":
      pane.cursorCol = 0;
      pane.scrollCol = 0;
      return { type: "render" };
    case "end":
      pane.cursorCol = Math.max(0, pane.columns.length - 1);
      return { type: "render" };
    case "pageup": {
      // Previous record (same as left for cards)
      const targetPU = findCardRecordTarget(state, pane);
      if (targetPU.cursorRow > 0) { targetPU.cursorRow--; }
      return { type: "render" };
    }
    case "pagedown": {
      // Next record (same as right for cards)
      const targetPD = findCardRecordTarget(state, pane);
      if (targetPD.cursorRow < targetPD.rowIds.length - 1) { targetPD.cursorRow++; }
      return { type: "render" };
    }
    case "enter":
      if (pane.rowIds.length > 0 && pane.columns.length > 0) {
        enterPaneEditMode(state);
      }
      return { type: "render" };
    case "a":
      return { type: "add_row" };
    case "d":
      if (pane.rowIds.length > 0) {
        state.mode = "confirm_delete";
      }
      return { type: "render" };
    case "escape":
      return { type: "switch_to_pages" };
    case "r":
      return { type: "refresh" };
    case "p":
      return { type: "switch_to_pages" };
    case "t":
      return { type: "switch_to_tables" };
    case "T":
      return { type: "cycle_theme" };
    case "q":
    case "ctrl-c":
      return { type: "quit" };
    default:
      return { type: "none" };
  }
}

function enterPaneEditMode(state: AppState, overridePane?: PaneState): void {
  const pane = overridePane || state.panes[state.focusedPane];
  if (!pane) { return; }
  const col = pane.columns[pane.cursorCol];
  const values = pane.colValues[col.colId];
  const currentValue = values ? values[pane.cursorRow] : null;
  state.editValue = formatCellValue(currentValue, col.type, col.widgetOptions, col.displayValues);
  state.editCursorPos = state.editValue.length;
  state.mode = "editing";
}

/**
 * Handle keys in cell viewer mode (scrollable full cell content).
 */
function handleCellViewerKey(key: string, state: AppState): InputAction {
  const termRows = process.stdout.rows || 24;
  const dataRows = termRows - 3;
  // Count wrapped lines to know max scroll
  const wrapWidth = (process.stdout.columns || 80) - 2;
  let totalLines = 0;
  for (const rawLine of state.cellViewerContent.split("\n")) {
    const w = displayWidth(rawLine);
    totalLines += w <= wrapWidth ? 1 : Math.ceil(w / wrapWidth);
  }
  const maxScroll = Math.max(0, totalLines - dataRows);

  switch (key) {
    case "escape":
    case "v":
    case "q":
      // Return to previous mode
      state.mode = state.overlayPaneIndex !== null ? "overlay" : "grid";
      state.cellViewerContent = "";
      state.cellViewerScroll = 0;
      state.cellViewerLinkIndex = -1;
      return { type: "render" };
    case "up":
      if (state.cellViewerScroll > 0) { state.cellViewerScroll--; }
      return { type: "render" };
    case "down":
      if (state.cellViewerScroll < maxScroll) { state.cellViewerScroll++; }
      return { type: "render" };
    case "pageup":
      state.cellViewerScroll = Math.max(0, state.cellViewerScroll - dataRows);
      return { type: "render" };
    case "pagedown":
      state.cellViewerScroll = Math.min(maxScroll, state.cellViewerScroll + dataRows);
      return { type: "render" };
    case "home":
      state.cellViewerScroll = 0;
      return { type: "render" };
    case "end":
      state.cellViewerScroll = maxScroll;
      return { type: "render" };
    case "enter": {
      // If a link is selected, open it; otherwise switch to editing
      if (state.cellViewerLinkIndex >= 0) {
        const urls = extractUrls(state.cellViewerContent);
        if (state.cellViewerLinkIndex < urls.length) {
          return { type: "open_url", url: urls[state.cellViewerLinkIndex] };
        }
      }
      // Enter edit mode -- keep cellViewerContent so we stay in the viewer
      state.cellViewerLinkIndex = -1;
      const pane = activeView(state);
      if (pane && pane.rowIds.length > 0 && pane.columns.length > 0) {
        enterPaneEditMode(state, pane);
      }
      return { type: "render" };
    }
    case "o": {
      // Cycle through URLs found in cell content
      const urls = extractUrls(state.cellViewerContent);
      if (urls.length === 0) { return { type: "none" }; }
      state.cellViewerLinkIndex = (state.cellViewerLinkIndex + 1) % urls.length;
      return { type: "render" };
    }
    default:
      return { type: "none" };
  }
}

/**
 * Handle keys in overlay mode (full-screen view of a collapsed widget).
 */
function handleOverlayKey(key: string, state: AppState): InputAction {
  if (state.overlayPaneIndex === null) {
    state.mode = "grid";
    return { type: "render" };
  }
  const pane = state.panes[state.overlayPaneIndex];
  if (!pane) {
    state.mode = "grid";
    state.overlayPaneIndex = null;
    return { type: "render" };
  }

  if (key === "escape") { return { type: "close_overlay" }; }

  if (isCardPane(pane)) {
    // Card-pane handler reads state.focusedPane; in overlay mode the user is
    // interacting with the overlay pane, so pretend it's focused for this call.
    const savedFocused = state.focusedPane;
    state.focusedPane = state.overlayPaneIndex;
    const result = handleCardPaneKey(key, state, pane);
    state.focusedPane = savedFocused;
    return result;
  }

  return handleGridViewKey(key, state, pane, process.stdout.columns || 80);
}

/**
 * Process a raw keypress buffer and return the action to take.
 */
export function handleKeypress(buf: Buffer, state: AppState): InputAction {
  const key = parseKey(buf);
  switch (state.mode) {
    case "table_picker":
      return handleTablePickerKey(key, state);
    case "page_picker":
      return handlePagePickerKey(key, state);
    case "grid":
      return handleMultiPaneGridKey(key, state);
    case "editing":
      return handleEditKey(key, state);
    case "confirm_delete":
      return handleConfirmDeleteKey(key, state);
    case "overlay":
      return handleOverlayKey(key, state);
    case "cell_viewer":
      return handleCellViewerKey(key, state);
    default:
      return { type: "none" };
  }
}

/**
 * Execute a save_edit action: send the edit to the server.
 */
export async function executeSaveEdit(state: AppState, conn: ConsoleConnection): Promise<void> {
  const pane = activeView(state);
  if (!pane) { return; }
  const tableId = pane.sectionInfo?.tableId || state.currentTableId;
  const col = pane.columns[pane.cursorCol];
  const rowId = pane.rowIds[pane.cursorRow];

  const parsed = parseCellInput(state.editValue, col.type);
  try {
    await conn.applyUserActions([
      ["UpdateRecord", tableId, rowId, { [col.colId]: parsed }],
    ]);
    state.statusMessage = "Saved";
  } catch (e: any) {
    state.statusMessage = `Error: ${e.message}`;
  }
  // Return to cell viewer/overlay/grid as appropriate
  state.mode = editReturnMode(state);
  // If returning to cell viewer, update the content with the saved value
  if (state.mode === "cell_viewer") {
    state.cellViewerContent = state.editValue;
  }
}

/**
 * Execute an add_row action.
 */
export async function executeAddRow(state: AppState, conn: ConsoleConnection): Promise<void> {
  const pane = activeView(state);
  if (!pane) { return; }
  const tableId = pane.sectionInfo?.tableId || state.currentTableId;
  const manualSort = computeInsertManualSort(pane.colValues.manualSort, pane.cursorRow, pane.rowIds.length);
  try {
    const payload: Record<string, any> = {};
    if (manualSort !== undefined) { payload.manualSort = manualSort; }
    await conn.applyUserActions([
      ["AddRecord", tableId, null, payload],
    ]);
    state.statusMessage = "Row added";
  } catch (e: any) {
    state.statusMessage = `Error: ${e.message}`;
  }
}

/**
 * Compute a manualSort value for a new row inserted ABOVE the cursor
 * position. Matches the web client's behavior: pass the cursor row's
 * current manualSort value; the server's position-assignment algorithm
 * places the new row just before it (midpoint with the row above, or
 * relabels if needed).
 *
 * Returns undefined to mean "insert at end" (no position hint) when we
 * can't determine a manualSort (empty table, no manualSort column, or
 * non-numeric value).
 */
export function computeInsertManualSort(
  sortCol: CellValue[] | undefined, cursorRow: number, rowCount: number,
): number | undefined {
  if (!sortCol || rowCount === 0) { return undefined; }
  const cursor = sortCol[cursorRow];
  if (typeof cursor !== "number") { return undefined; }
  return cursor;
}

/**
 * Execute a delete_row action.
 */
export async function executeDeleteRow(state: AppState, conn: ConsoleConnection): Promise<void> {
  const pane = activeView(state);
  if (!pane) { return; }
  const tableId = pane.sectionInfo?.tableId || state.currentTableId;
  const rowId = pane.rowIds[pane.cursorRow];

  try {
    await conn.applyUserActions([
      ["RemoveRecord", tableId, rowId],
    ]);
    state.statusMessage = `Row ${rowId} deleted`;
    if (pane.cursorRow >= pane.rowIds.length - 1 && pane.cursorRow > 0) {
      pane.cursorRow--;
    }
  } catch (e: any) {
    state.statusMessage = `Error: ${e.message}`;
  }
}
