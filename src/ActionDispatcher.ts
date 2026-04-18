/**
 * Apply Grist DocActions to local pane state for live updates.
 *
 * Grist's server pushes DocActions to connected clients; this module translates
 * those actions into in-place mutations on our pane arrays (rowIds, colValues,
 * and their unfiltered all* counterparts). The web client has an analogous
 * role in grist-core's TableData / ViewData.
 *
 * Schema-changing actions (Add/Remove/Rename/ModifyColumn) are not applied;
 * the caller sets a status message asking the user to refresh.
 */

import { BulkColValues, CellValue, ColumnInfo, DocAction, getBaseType } from "./types.js";
import { AppState, PaneState, paneTableId } from "./ConsoleAppState.js";

/**
 * Apply incoming DocActions to local state for live updates.
 * Routes each action to every pane whose table matches.
 */
export function applyDocActions(state: AppState, actions: DocAction[]): void {
  for (const action of actions) {
    const actionType = action[0];
    const tableId = action[1] as string;
    // Schema changes require a refresh; can't update in-place reliably
    if (actionType === "AddColumn" || actionType === "RemoveColumn" ||
        actionType === "RenameColumn" || actionType === "ModifyColumn") {
      state.statusMessage = "Schema changed - press r to refresh";
      continue;
    }
    for (const pane of state.panes) {
      if (paneTableId(pane, state) === tableId) {
        applyDocActionToPane(pane, action);
      }
    }
  }
}

/**
 * Apply a single DocAction to a pane's all-data (allRowIds + allColValues) and
 * its visible view. Visible rowIds/colValues will typically be rebuilt by
 * applyAllSectionLinks afterward, but mirroring here keeps the UI consistent
 * before that re-filter runs.
 */
function applyDocActionToPane(pane: PaneState, action: DocAction): void {
  const actionType = action[0];

  switch (actionType) {
    case "UpdateRecord": {
      const [, , rowId, colValues] = action as any;
      updateRowInPane(pane, rowId, colValues);
      break;
    }
    case "BulkUpdateRecord": {
      const [, , rowIds, colValues] = action as any;
      // Build row-id -> index maps once so each per-row update is O(1).
      const allIdx = indexMap(pane.allRowIds);
      const visIdx = indexMap(pane.rowIds);
      for (let i = 0; i < rowIds.length; i++) {
        const allI = allIdx.get(rowIds[i]);
        const visI = visIdx.get(rowIds[i]);
        for (const [colId, values] of Object.entries(colValues as Record<string, CellValue[]>)) {
          if (allI !== undefined && pane.allColValues[colId]) {
            pane.allColValues[colId][allI] = values[i];
          }
          if (visI !== undefined && pane.colValues[colId]) {
            pane.colValues[colId][visI] = values[i];
          }
        }
      }
      break;
    }
    case "AddRecord": {
      const [, , rowId, colValues] = action as any;
      addRowToPane(pane, rowId, colValues);
      break;
    }
    case "BulkAddRecord": {
      const [, , rowIds, colValues] = action as any;
      for (let i = 0; i < rowIds.length; i++) {
        const perRow: Record<string, CellValue> = {};
        for (const colId of Object.keys(colValues)) {
          perRow[colId] = colValues[colId]?.[i];
        }
        addRowToPane(pane, rowIds[i], perRow);
      }
      break;
    }
    case "RemoveRecord": {
      const [, , rowId] = action as any;
      removeRowFromPane(pane, rowId);
      clampCursorRow(pane);
      break;
    }
    case "BulkRemoveRecord": {
      const [, , rowIds] = action as any;
      for (const rowId of rowIds) {
        removeRowFromPane(pane, rowId);
      }
      clampCursorRow(pane);
      break;
    }
  }
}

/**
 * Append a new row's values to a BulkColValues, covering every column in the
 * map (including hidden ones like manualSort). If a column has no value in
 * the action's colValues, fall back to the typed default for visible columns
 * and null for unknown (hidden) columns.
 */
export function appendRowToColValues(
  target: BulkColValues,
  columns: ColumnInfo[],
  colValues: Record<string, CellValue>,
): void {
  const typeByColId = new Map(columns.map(c => [c.colId, c.type]));
  for (const colId of Object.keys(target)) {
    const val = colValues[colId];
    if (val !== undefined) {
      target[colId].push(val);
    } else {
      const type = typeByColId.get(colId);
      target[colId].push(type ? defaultForColumnType(type) : null);
    }
  }
  // Also cover columns present in colValues but not yet in target (rare --
  // typically the server's AddRecord includes only some columns).
  for (const colId of Object.keys(colValues)) {
    if (!target[colId]) {
      // Pad previous rows with null, then add this value
      const prevLen = Math.max(0, (target[Object.keys(target)[0]]?.length || 1) - 1);
      target[colId] = new Array(prevLen).fill(null);
      target[colId].push(colValues[colId]);
    }
  }
}

/**
 * Return the default value for a column type when the server omits it from an
 * AddRecord action.
 */
function defaultForColumnType(colType: string): CellValue {
  const baseType = getBaseType(colType);
  switch (baseType) {
    case "Bool": return false;
    case "Int":
    case "Numeric":
    case "ManualSortPos": return 0;
    case "Text":
    case "Choice": return "";
    case "ChoiceList":
    case "RefList": return null;
    default: return null;
  }
}

function updateRowInPane(pane: PaneState, rowId: number, colValues: Record<string, CellValue>): void {
  const allIdx = pane.allRowIds.indexOf(rowId);
  if (allIdx >= 0) {
    for (const [colId, value] of Object.entries(colValues)) {
      if (pane.allColValues[colId]) {
        pane.allColValues[colId][allIdx] = value;
      }
    }
  }
  const visIdx = pane.rowIds.indexOf(rowId);
  if (visIdx >= 0) {
    for (const [colId, value] of Object.entries(colValues)) {
      if (pane.colValues[colId]) {
        pane.colValues[colId][visIdx] = value;
      }
    }
  }
}

function addRowToPane(pane: PaneState, rowId: number, colValues: Record<string, CellValue>): void {
  pane.allRowIds.push(rowId);
  pane.rowIds.push(rowId);
  // Update ALL columns in allColValues/colValues (not just visible), so
  // hidden columns like manualSort stay in sync. Out-of-sync arrays
  // confuse sorting (e.g. new row with undefined manualSort sorts first).
  appendRowToColValues(pane.allColValues, pane.columns, colValues);
  appendRowToColValues(pane.colValues, pane.columns, colValues);
}

function removeRowFromPane(pane: PaneState, rowId: number): void {
  const allIdx = pane.allRowIds.indexOf(rowId);
  if (allIdx >= 0) {
    pane.allRowIds.splice(allIdx, 1);
    for (const col of pane.columns) {
      if (pane.allColValues[col.colId]) {
        pane.allColValues[col.colId].splice(allIdx, 1);
      }
    }
  }
  const visIdx = pane.rowIds.indexOf(rowId);
  if (visIdx >= 0) {
    pane.rowIds.splice(visIdx, 1);
    for (const col of pane.columns) {
      if (pane.colValues[col.colId]) {
        pane.colValues[col.colId].splice(visIdx, 1);
      }
    }
  }
}

function clampCursorRow(pane: PaneState): void {
  if (pane.cursorRow >= pane.rowIds.length && pane.cursorRow > 0) {
    pane.cursorRow = pane.rowIds.length - 1;
  }
}

function indexMap(rowIds: number[]): Map<number, number> {
  const m = new Map<number, number>();
  for (let i = 0; i < rowIds.length; i++) { m.set(rowIds[i], i); }
  return m;
}
