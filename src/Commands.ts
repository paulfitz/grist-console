/**
 * User-action commands: save edit, add row, delete row.
 *
 * Each command translates an in-progress UI intent into a Grist
 * applyUserActions RPC and records a status message. Rhymes with
 * grist-core's command/UserActions split: the keymap dispatches an
 * action type (save_edit, add_row, ...), and these executors carry
 * out the corresponding write.
 */

import { CellValue } from "./types.js";
import { AppState, activeView, editReturnMode, paneTableId } from "./ConsoleAppState.js";
import { ConsoleConnection } from "./ConsoleConnection.js";
import { parseCellInput, ParseError } from "./ConsoleCellFormat.js";

/**
 * Persist the current edit buffer for the focused cell, then leave edit mode.
 * The new value re-syncs the cell viewer if we returned to it.
 */
export async function executeSaveEdit(state: AppState, conn: ConsoleConnection): Promise<void> {
  const pane = activeView(state);
  if (!pane) { return; }
  const tableId = paneTableId(pane, state);
  const col = pane.columns[pane.cursorCol];
  const rowId = pane.rowIds[pane.cursorRow];

  let parsed;
  try {
    parsed = parseCellInput(state.editValue, col.type);
  } catch (e: any) {
    if (e instanceof ParseError) {
      // Reject invalid input -- stay in edit mode so the user can fix it.
      state.statusMessage = e.message;
      return;
    }
    throw e;
  }
  try {
    await conn.applyUserActions([
      ["UpdateRecord", tableId, rowId, { [col.colId]: parsed }],
    ]);
    state.statusMessage = "Saved";
  } catch (e: any) {
    state.statusMessage = `Error: ${e.message}`;
  }
  state.mode = editReturnMode(state);
  if (state.mode === "cell_viewer") {
    state.cellViewerContent = state.editValue;
  }
}

/**
 * Insert a new row, hinting position from the cursor row's manualSort so
 * the server can place it just before the cursor (matching the web client).
 */
export async function executeAddRow(state: AppState, conn: ConsoleConnection): Promise<void> {
  const pane = activeView(state);
  if (!pane) { return; }
  const tableId = paneTableId(pane, state);
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
 * Remove the row at the cursor; back up the cursor if it would land past
 * the new end of the table.
 */
export async function executeDeleteRow(state: AppState, conn: ConsoleConnection): Promise<void> {
  const pane = activeView(state);
  if (!pane) { return; }
  const tableId = paneTableId(pane, state);
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
