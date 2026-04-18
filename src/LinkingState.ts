/**
 * Section sorting, filtering, and cursor linking.
 *
 * Rhymes with grist-core's LinkingState: when one section's cursor moves or
 * when server data changes, every dependent section refilters/sorts itself
 * from its unmodified all* arrays. This module owns that recomputation.
 *
 * - reapplySortAndFilter: copy all* -> visible, apply _grist_Filters, then sort.
 * - applyAllSectionLinks: entry point called from the event loop. Runs
 *   reapplySortAndFilter on every pane, then applies section linking
 *   (filter-by-source-cursor or cursor-sync) across panes.
 * - applySortSpec / applySectionFilters / compareCellValues: pure helpers,
 *   exported for tests.
 */

import { BulkColValues, CellValue } from "./types.js";
import { AppState, PaneState } from "./ConsoleAppState.js";
import { extractFiltersForSection, getColIdByRef, getColumnInfo } from "./ConsoleLayout.js";

/**
 * Copy all* to visible, then apply sorting and filtering to the visible copy.
 * This keeps all* as the unmodified server data so it can be re-applied safely.
 */
export function reapplySortAndFilter(pane: PaneState, metaTables: any): void {
  pane.rowIds = [...pane.allRowIds];
  pane.colValues = copyColValues(pane.allColValues);
  const sec = pane.sectionInfo;
  if (sec) {
    applySectionFilters(pane, sec.sectionId, metaTables);
  }
  const spec = sec?.sortColRefs;
  const hasSort = spec && spec !== "[]";
  if (hasSort) {
    applySortSpec(pane, spec, metaTables);
  } else if (pane.colValues.manualSort) {
    // Default: sort by manualSort column (Grist's natural ordering)
    applySortByColumn(pane, "manualSort", 1);
  }
}

/**
 * Apply section linking across all panes.
 * For each pane with linkSrcSectionRef, filter its rows based on the source pane's cursor.
 */
export function applyAllSectionLinks(state: AppState, metaTables: any): void {
  // Re-apply sort/filter to all panes before linking
  for (const pane of state.panes) {
    reapplySortAndFilter(pane, metaTables);
  }

  for (const pane of state.panes) {
    const sec = pane.sectionInfo;
    if (!sec) { continue; } // single-pane mode: no linking
    const srcRef = sec.linkSrcSectionRef;
    if (!srcRef) { continue; }

    // Find source pane
    const srcPane = state.panes.find(p => p.sectionInfo?.sectionId === srcRef);
    if (!srcPane) { continue; }

    const srcColRef = sec.linkSrcColRef;
    const tgtColRef = sec.linkTargetColRef;

    if (srcPane.rowIds.length === 0) {
      // No source rows — show nothing
      pane.rowIds = [];
      pane.cursorRow = 0;
      continue;
    }

    const srcRowIdx = srcPane.cursorRow;
    const srcRowId = srcPane.rowIds[srcRowIdx];

    if (srcColRef === 0 && tgtColRef > 0) {
      // Filter target rows where tgtCol == srcRowId
      const tgtColId = getColIdByRef(metaTables, tgtColRef);
      filterPaneRows(pane, tgtColId, srcRowId);
    } else if (srcColRef > 0 && tgtColRef > 0) {
      // Filter where tgtCol == srcColValue
      const srcColId = getColIdByRef(metaTables, srcColRef);
      const srcValues = srcPane.colValues[srcColId];
      const srcValue = srcValues ? srcValues[srcRowIdx] : null;
      const tgtColId = getColIdByRef(metaTables, tgtColRef);
      filterPaneRows(pane, tgtColId, srcValue);
    } else if (srcColRef === 0 && tgtColRef === 0) {
      // Cursor sync -- all rows visible, sync cursor position
      const idx = pane.rowIds.indexOf(srcRowId);
      if (idx >= 0) {
        pane.cursorRow = idx;
      }
    } else if (srcColRef > 0 && tgtColRef === 0) {
      // Cursor follows ref value
      const srcColId = getColIdByRef(metaTables, srcColRef);
      const srcValues = srcPane.colValues[srcColId];
      const refValue = srcValues ? srcValues[srcRowIdx] : null;
      if (typeof refValue === "number" && refValue > 0) {
        const idx = pane.rowIds.indexOf(refValue);
        if (idx >= 0) {
          pane.cursorRow = idx;
        }
      }
    }
  }
}

/**
 * Parse sortColRefs JSON (e.g. '[2, -3, "4:emptyLast"]') and sort pane's visible
 * data (rowIds/colValues) in place. Positive colRef = ascending, negative = descending.
 */
export function applySortSpec(
  pane: PaneState, sortColRefs: string, metaTables: any
): void {
  let sortSpec: Array<number | string>;
  try {
    sortSpec = JSON.parse(sortColRefs);
  } catch {
    return;
  }
  if (!Array.isArray(sortSpec) || sortSpec.length === 0) { return; }

  // Parse each sort entry into { colId, direction }
  const sortCols: Array<{ colId: string; direction: 1 | -1 }> = [];
  for (const entry of sortSpec) {
    let colRef: number;
    let direction: 1 | -1;
    if (typeof entry === "number") {
      colRef = Math.abs(entry);
      direction = entry >= 0 ? 1 : -1;
    } else {
      // String form: "-3:emptyLast;naturalSort" -- strip flags, parse sign + ref
      const match = String(entry).match(/^(-)?(\d+)/);
      if (!match) { continue; }
      direction = match[1] ? -1 : 1;
      colRef = parseInt(match[2], 10);
    }
    const colId = getColIdByRef(metaTables, colRef);
    if (colId && pane.colValues[colId]) {
      sortCols.push({ colId, direction });
    }
  }
  if (sortCols.length === 0) { return; }

  // Build index array sorted by the sort columns
  const len = pane.rowIds.length;
  const indices = Array.from({ length: len }, (_, i) => i);
  indices.sort((a, b) => {
    for (const { colId, direction } of sortCols) {
      const va = pane.colValues[colId][a];
      const vb = pane.colValues[colId][b];
      const cmp = compareCellValues(va, vb);
      if (cmp !== 0) { return cmp * direction; }
    }
    return 0;
  });

  // Reorder rowIds and colValues by sorted indices
  pane.rowIds = indices.map(i => pane.rowIds[i]);
  for (const colId of Object.keys(pane.colValues)) {
    pane.colValues[colId] = indices.map(i => pane.colValues[colId][i]);
  }
}

/**
 * Apply _grist_Filters to a pane's visible rowIds/colValues, removing rows that
 * don't pass the filter. Does not modify allRowIds/allColValues.
 */
export function applySectionFilters(
  pane: PaneState, sectionId: number, metaTables: any
): void {
  const filterMap = extractFiltersForSection(metaTables, sectionId);
  if (filterMap.size === 0) { return; }

  // Build a filter function for each column
  const colFilters: Array<{ colId: string; test: (val: CellValue) => boolean }> = [];
  for (const [colRef, filterJson] of filterMap) {
    const colInfo = getColumnInfo(metaTables, colRef);
    const colId = colInfo?.colId;
    if (!colId || !pane.colValues[colId]) { continue; }
    const colType = colInfo.type || "";
    const isListCol = colType === "ChoiceList" || colType.startsWith("RefList:");

    let spec: any;
    try {
      spec = JSON.parse(filterJson);
    } catch {
      continue;
    }
    if (!spec || typeof spec !== "object") { continue; }

    if (spec.min !== undefined || spec.max !== undefined) {
      // Range filter
      const min = typeof spec.min === "number" ? spec.min : undefined;
      const max = typeof spec.max === "number" ? spec.max : undefined;
      colFilters.push({
        colId,
        test: (val) => {
          if (typeof val !== "number") { return false; }
          if (min !== undefined && val < min) { return false; }
          if (max !== undefined && val > max) { return false; }
          return true;
        },
      });
    } else if (spec.included) {
      const values = new Set(spec.included.map(
        (v: CellValue) => Array.isArray(v) ? JSON.stringify(v) : v
      ));
      colFilters.push({
        colId,
        test: (val) => testListAwareFilter(val, values, true, isListCol, colType),
      });
    } else if (spec.excluded) {
      if (spec.excluded.length === 0) { continue; } // empty excluded = no filter
      const values = new Set(spec.excluded.map(
        (v: CellValue) => Array.isArray(v) ? JSON.stringify(v) : v
      ));
      colFilters.push({
        colId,
        test: (val) => testListAwareFilter(val, values, false, isListCol, colType),
      });
    }
  }

  if (colFilters.length === 0) { return; }

  // Filter rows
  const newRowIds: number[] = [];
  const newColValues: BulkColValues = {};
  for (const colId of Object.keys(pane.colValues)) {
    newColValues[colId] = [];
  }

  for (let i = 0; i < pane.rowIds.length; i++) {
    const pass = colFilters.every(({ colId, test }) => test(pane.colValues[colId][i]));
    if (pass) {
      newRowIds.push(pane.rowIds[i]);
      for (const colId of Object.keys(pane.colValues)) {
        newColValues[colId].push(pane.colValues[colId][i]);
      }
    }
  }

  pane.rowIds = newRowIds;
  pane.colValues = newColValues;
}

/**
 * Compare two cell values for sorting. Nulls sort first, then numbers, then strings.
 */
export function compareCellValues(a: CellValue, b: CellValue): number {
  if (a === b) { return 0; }
  if (a == null) { return -1; }
  if (b == null) { return 1; }
  if (typeof a === "number" && typeof b === "number") { return a - b; }
  if (typeof a === "boolean" && typeof b === "boolean") { return (a ? 1 : 0) - (b ? 1 : 0); }
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

/**
 * Sort a pane's visible data by a specific column id, in-place.
 */
function applySortByColumn(pane: PaneState, colId: string, direction: 1 | -1): void {
  const values = pane.colValues[colId];
  if (!values) { return; }
  const indices = Array.from({ length: pane.rowIds.length }, (_, i) => i);
  indices.sort((a, b) => compareCellValues(values[a], values[b]) * direction);
  pane.rowIds = indices.map(i => pane.rowIds[i]);
  for (const k of Object.keys(pane.colValues)) {
    pane.colValues[k] = indices.map(i => pane.colValues[k][i]);
  }
}

/**
 * Filter a pane's visible rows to those where colId == value.
 * Reads from rowIds/colValues (already sorted/filtered by reapplySortAndFilter),
 * writes filtered result back to rowIds/colValues.
 */
function filterPaneRows(pane: PaneState, colId: string, value: any): void {
  if (!colId) { return; }

  const colValues = pane.colValues[colId];
  if (!colValues) { return; }

  const filteredRowIds: number[] = [];
  const filteredColValues: BulkColValues = {};
  for (const col of pane.columns) {
    filteredColValues[col.colId] = [];
  }

  for (let i = 0; i < pane.rowIds.length; i++) {
    const cellValue = colValues[i];
    const match = cellValue === value ||
      (typeof cellValue === "number" && cellValue === value) ||
      (Array.isArray(cellValue) && cellValue[0] === "R" && cellValue[2] === value) ||
      // RefList: ["L", id1, id2, ...] -- check if list contains the value
      (Array.isArray(cellValue) && cellValue[0] === "L" && cellValue.indexOf(value) > 0);
    if (match) {
      filteredRowIds.push(pane.rowIds[i]);
      for (const col of pane.columns) {
        const vals = pane.colValues[col.colId];
        filteredColValues[col.colId].push(vals ? vals[i] : null);
      }
    }
  }

  pane.rowIds = filteredRowIds;
  pane.colValues = filteredColValues;
  if (pane.cursorRow >= pane.rowIds.length) {
    pane.cursorRow = Math.max(0, pane.rowIds.length - 1);
  }
}

export function copyColValues(cv: BulkColValues): BulkColValues {
  const result: BulkColValues = {};
  for (const [k, v] of Object.entries(cv)) {
    result[k] = [...v];
  }
  return result;
}

/**
 * Test whether a cell value passes a filter, with special handling for list
 * columns (ChoiceList, RefList). For list columns, at least one item must
 * be in (or out of) the included/excluded set. Empty lists get a fallback
 * value (null for RefList, "" for ChoiceList).
 */
function testListAwareFilter(
  val: CellValue, values: Set<any>, include: boolean,
  isListCol: boolean, colType: string,
): boolean {
  if (isListCol && Array.isArray(val) && val[0] === "L") {
    const items = val.slice(1);
    if (items.length === 0) {
      const fallback = colType === "ChoiceList" ? "" : null;
      return values.has(fallback) === include;
    }
    return items.some(item => values.has(item) === include);
  }
  const key = Array.isArray(val) ? JSON.stringify(val) : val;
  return values.has(key) === include;
}
