import { AppState, isCardPane, PaneState } from "./ConsoleRenderer";
import { collectLeaves, LayoutNode } from "./ConsoleLayout";
import { parseCellInput } from "./ConsoleCellFormat";
import { formatCellValue } from "./ConsoleCellFormat";
import { ConsoleConnection } from "./ConsoleConnection";

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
  const srcRef = pane.sectionInfo.linkSrcSectionRef;
  if (!srcRef) { return pane; }
  const srcPane = state.panes.find(p => p.sectionInfo.sectionId === srcRef);
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
  | { type: "cycle_theme" };

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
    case "enter":
      return { type: "select_table" };
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
 * Handle a keypress in grid mode.
 */
function handleGridKey(key: string, state: AppState): InputAction {
  const termRows = process.stdout.rows || 24;
  const pageSize = Math.max(1, termRows - 5);

  switch (key) {
    case "up":
      if (state.cursorRow > 0) {
        state.cursorRow--;
        if (state.cursorRow < state.scrollRow) {
          state.scrollRow = state.cursorRow;
        }
      }
      return { type: "render" };
    case "down":
      if (state.cursorRow < state.rowIds.length - 1) {
        state.cursorRow++;
        const dataRows = Math.max(1, termRows - 5);
        if (state.cursorRow >= state.scrollRow + dataRows) {
          state.scrollRow = state.cursorRow - dataRows + 1;
        }
      }
      return { type: "render" };
    case "left":
      if (state.cursorCol > 0) {
        state.cursorCol--;
        if (state.cursorCol < state.scrollCol) {
          state.scrollCol = state.cursorCol;
        }
      }
      return { type: "render" };
    case "right":
      if (state.cursorCol < state.columns.length - 1) {
        state.cursorCol++;
        // Scroll horizontally if needed
        if (state.cursorCol > state.scrollCol + 5) {
          state.scrollCol = Math.max(0, state.cursorCol - 5);
        }
      }
      return { type: "render" };
    case "pageup":
      state.cursorRow = Math.max(0, state.cursorRow - pageSize);
      state.scrollRow = Math.max(0, state.scrollRow - pageSize);
      return { type: "render" };
    case "pagedown":
      state.cursorRow = Math.min(state.rowIds.length - 1, state.cursorRow + pageSize);
      state.scrollRow = Math.min(
        Math.max(0, state.rowIds.length - pageSize),
        state.scrollRow + pageSize
      );
      return { type: "render" };
    case "home":
      state.cursorRow = 0;
      state.scrollRow = 0;
      return { type: "render" };
    case "end":
      state.cursorRow = Math.max(0, state.rowIds.length - 1);
      state.scrollRow = Math.max(0, state.rowIds.length - pageSize);
      return { type: "render" };
    case "enter":
      if (state.rowIds.length > 0 && state.columns.length > 0) {
        enterEditMode(state);
      }
      return { type: "render" };
    case "a":
      return { type: "add_row" };
    case "d":
      if (state.rowIds.length > 0) {
        state.mode = "confirm_delete";
      }
      return { type: "render" };
    case "r":
      return { type: "refresh" };
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

function enterEditMode(state: AppState): void {
  const col = state.columns[state.cursorCol];
  const values = state.colValues[col.colId];
  const currentValue = values ? values[state.cursorRow] : null;
  state.editValue = formatCellValue(currentValue, col.type, col.widgetOptions, col.displayValues);
  state.editCursorPos = state.editValue.length;
  state.mode = "editing";
}

/**
 * Handle a keypress in edit mode.
 */
function handleEditKey(key: string, state: AppState): InputAction {
  switch (key) {
    case "escape":
      state.mode = "grid";
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
  switch (key) {
    case "y":
      state.mode = "grid";
      return { type: "delete_row" };
    case "n":
    case "escape":
      state.mode = "grid";
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
function handleMultiPaneGridKey(key: string, state: AppState): InputAction {
  const pane = state.panes[state.focusedPane];
  if (!pane) { return { type: "none" }; }

  if (isCardPane(pane)) {
    return handleCardPaneKey(key, state, pane);
  }

  const termRows = process.stdout.rows || 24;
  const pageSize = Math.max(1, termRows - 5);

  switch (key) {
    case "tab":
      return { type: "focus_next_pane" };
    case "shift-tab":
      return { type: "focus_prev_pane" };
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
        if (pane.cursorCol < pane.scrollCol) {
          pane.scrollCol = pane.cursorCol;
        }
      }
      return { type: "render" };
    case "right":
      if (pane.cursorCol < pane.columns.length - 1) {
        pane.cursorCol++;
        if (pane.cursorCol > pane.scrollCol + 5) {
          pane.scrollCol = Math.max(0, pane.cursorCol - 5);
        }
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

function enterPaneEditMode(state: AppState): void {
  const pane = state.panes[state.focusedPane];
  if (!pane) { return; }
  const col = pane.columns[pane.cursorCol];
  const values = pane.colValues[col.colId];
  const currentValue = values ? values[pane.cursorRow] : null;
  state.editValue = formatCellValue(currentValue, col.type, col.widgetOptions, col.displayValues);
  state.editCursorPos = state.editValue.length;
  state.mode = "editing";
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
      if (state.panes.length > 0) {
        return handleMultiPaneGridKey(key, state);
      }
      return handleGridKey(key, state);
    case "editing":
      return handleEditKey(key, state);
    case "confirm_delete":
      return handleConfirmDeleteKey(key, state);
    default:
      return { type: "none" };
  }
}

/**
 * Execute a save_edit action: send the edit to the server.
 */
export async function executeSaveEdit(state: AppState, conn: ConsoleConnection): Promise<void> {
  let tableId: string;
  let col: { colId: string; type: string };
  let rowId: number;

  if (state.panes.length > 0) {
    const pane = state.panes[state.focusedPane];
    tableId = pane.sectionInfo.tableId;
    col = pane.columns[pane.cursorCol];
    rowId = pane.rowIds[pane.cursorRow];
  } else {
    tableId = state.currentTableId;
    col = state.columns[state.cursorCol];
    rowId = state.rowIds[state.cursorRow];
  }

  const parsed = parseCellInput(state.editValue, col.type);
  try {
    await conn.applyUserActions([
      ["UpdateRecord", tableId, rowId, { [col.colId]: parsed }],
    ]);
    state.statusMessage = "Saved";
  } catch (e: any) {
    state.statusMessage = `Error: ${e.message}`;
  }
  state.mode = "grid";
}

/**
 * Execute an add_row action.
 */
export async function executeAddRow(state: AppState, conn: ConsoleConnection): Promise<void> {
  let tableId: string;
  if (state.panes.length > 0) {
    tableId = state.panes[state.focusedPane].sectionInfo.tableId;
  } else {
    tableId = state.currentTableId;
  }
  try {
    await conn.applyUserActions([
      ["AddRecord", tableId, null, {}],
    ]);
    state.statusMessage = "Row added";
  } catch (e: any) {
    state.statusMessage = `Error: ${e.message}`;
  }
}

/**
 * Execute a delete_row action.
 */
export async function executeDeleteRow(state: AppState, conn: ConsoleConnection): Promise<void> {
  let tableId: string;
  let rowId: number;
  let cursorRow: number;
  let rowIds: number[];

  if (state.panes.length > 0) {
    const pane = state.panes[state.focusedPane];
    tableId = pane.sectionInfo.tableId;
    rowId = pane.rowIds[pane.cursorRow];
    cursorRow = pane.cursorRow;
    rowIds = pane.rowIds;
  } else {
    tableId = state.currentTableId;
    rowId = state.rowIds[state.cursorRow];
    cursorRow = state.cursorRow;
    rowIds = state.rowIds;
  }

  try {
    await conn.applyUserActions([
      ["RemoveRecord", tableId, rowId],
    ]);
    state.statusMessage = `Row ${rowId} deleted`;
    if (cursorRow >= rowIds.length - 1 && cursorRow > 0) {
      if (state.panes.length > 0) {
        state.panes[state.focusedPane].cursorRow--;
      } else {
        state.cursorRow--;
      }
    }
  } catch (e: any) {
    state.statusMessage = `Error: ${e.message}`;
  }
}
