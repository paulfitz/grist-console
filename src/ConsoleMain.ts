import { BulkColValues, ColumnInfo, DocAction } from "./types.js";
import { ConsoleConnection } from "./ConsoleConnection.js";
import { AppState, PaneState, createInitialState, render, showCursor } from "./ConsoleRenderer.js";
import {
  executeAddRow, executeDeleteRow, executeSaveEdit, handleKeypress
} from "./ConsoleInput.js";
import {
  extractPages, extractSectionsForView, extractFiltersForSection,
  extractCollapsedSectionIds, getLayoutSpecForView,
  parseLayoutSpec, computeLayout, getColumnInfo,
  getColIdByRef as layoutGetColIdByRef, Rect,
} from "./ConsoleLayout.js";
import { CellValue } from "./types.js";
import { formatCellValue } from "./ConsoleCellFormat.js";
import { Theme, defaultTheme, cycleTheme } from "./ConsoleTheme.js";
import { exec } from "child_process";
import { calibrateTermWidth } from "./termWidth.js";

/**
 * Main entry point for the console client.
 */
export async function consoleMain(options: {
  serverUrl: string;
  docId: string;
  apiKey?: string;
  table?: string;
  theme?: Theme;
  pageId?: number;
  verbose?: boolean;
}): Promise<void> {
  const conn = new ConsoleConnection(options.serverUrl, options.docId, options.apiKey, { verbose: options.verbose });
  const state: AppState = createInitialState(options.docId, options.theme || defaultTheme);

  // Calibrate terminal character widths and connect in parallel
  process.stdout.write("Connecting...\n");
  const [, connResult] = await Promise.allSettled([
    calibrateTermWidth(),
    conn.connect(),
  ]);
  if (connResult.status === "rejected") {
    process.stderr.write(`Connection failed: ${connResult.reason?.message || connResult.reason}\n`);
    process.exit(1);
  }

  // Get table list
  state.tableIds = conn.getTableIds();
  if (state.tableIds.length === 0) {
    process.stderr.write("No tables found in document.\n");
    await conn.close();
    process.exit(1);
  }

  // Extract pages from metadata
  state.pages = extractPages(conn.getMetaTables());

  // If --table was specified, skip table picker (single-pane mode)
  if (options.table) {
    if (!state.tableIds.includes(options.table)) {
      process.stderr.write(`Table "${options.table}" not found. Available: ${state.tableIds.join(", ")}\n`);
      await conn.close();
      process.exit(1);
    }
    state.currentTableId = options.table;
    await loadTable(state, conn);
    state.mode = "grid";
  } else if (options.pageId && state.pages.length > 0) {
    // Open the page specified in the URL (/p/NN)
    const pageIdx = state.pages.findIndex(p => p.pageId === options.pageId);
    if (pageIdx >= 0) {
      const page = state.pages[pageIdx];
      state.selectedPageIndex = pageIdx;
      state.currentPageId = page.pageId;
      await loadPage(state, conn, page.viewId);
      state.mode = "grid";
    } else {
      state.statusMessage = `Page ${options.pageId} not found`;
      state.mode = "page_picker";
    }
  } else if (state.pages.length > 0) {
    // Default to page picker if pages exist
    state.mode = "page_picker";
  }

  // Set up live update handler (server pushes docUserAction messages over WebSocket)
  conn.onDocAction((actions) => {
    applyDocActions(state, actions);
    if (state.panes.length > 0) {
      applyAllSectionLinks(state, conn);
    }
    doRender(state);
  });

  // Initial render
  doRender(state);

  // Return a promise that resolves only when the user quits.
  return new Promise<void>((resolve) => {
    // Set up raw mode input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Handle terminal resize
    process.stdout.on("resize", () => {
      if (state.panes.length > 0) {
        recomputeLayout(state);
      }
      doRender(state);
    });

    process.stdin.on("end", () => {
      doCleanup(state, conn, resolve);
    });

    process.stdin.on("data", async (data: Buffer) => {
      const action = handleKeypress(Buffer.from(data), state);
      switch (action.type) {
        case "quit":
          doCleanup(state, conn, resolve);
          return;
        case "render": {
          // Clear transient status on any navigation/render
          state.statusMessage = "";
          // After cursor movement in multi-pane mode, re-run linking
          if (state.panes.length > 0) {
            applyAllSectionLinks(state, conn);
          }
          doRender(state);
          break;
        }
        case "select_table":
          state.currentTableId = state.tableIds[state.selectedTableIndex];
          state.statusMessage = "Loading...";
          state.panes = [];
          state.layout = null;
          state.boxSpec = null;
          doRender(state);
          try {
            await loadTable(state, conn);
            state.mode = "grid";
            state.statusMessage = "";
          } catch (e: any) {
            state.statusMessage = `Error: ${e.message}`;
          }
          doRender(state);
          break;
        case "select_page": {
          const page = state.pages[state.selectedPageIndex];
          state.currentPageId = page.pageId;
          state.statusMessage = "Loading page...";
          doRender(state);
          try {
            await loadPage(state, conn, page.viewId);
            state.mode = "grid";
            state.statusMessage = "";
          } catch (e: any) {
            state.statusMessage = `Error: ${e.message}`;
          }
          doRender(state);
          break;
        }
        case "refresh":
          state.statusMessage = "Refreshing...";
          doRender(state);
          try {
            if (state.panes.length > 0 && state.currentPageId) {
              const page = state.pages.find(p => p.pageId === state.currentPageId);
              if (page) {
                await loadPage(state, conn, page.viewId);
              }
            } else {
              await loadTable(state, conn);
            }
            state.statusMessage = "Refreshed";
          } catch (e: any) {
            state.statusMessage = `Error: ${e.message}`;
          }
          doRender(state);
          break;
        case "save_edit":
          await executeSaveEdit(state, conn);
          if (state.panes.length > 0) {
            applyAllSectionLinks(state, conn);
          }
          doRender(state);
          break;
        case "add_row":
          await executeAddRow(state, conn);
          if (state.panes.length > 0) {
            applyAllSectionLinks(state, conn);
          }
          doRender(state);
          break;
        case "delete_row":
          await executeDeleteRow(state, conn);
          if (state.panes.length > 0) {
            applyAllSectionLinks(state, conn);
          }
          doRender(state);
          break;
        case "switch_to_tables":
          state.mode = "table_picker";
          state.panes = [];
          state.layout = null;
          state.boxSpec = null;
          state.statusMessage = "";
          doRender(state);
          break;
        case "switch_to_pages":
          state.mode = "page_picker";
          state.panes = [];
          state.layout = null;
          state.boxSpec = null;
          state.statusMessage = "";
          doRender(state);
          break;
        case "focus_next_pane": {
          const collapsedSet = new Set(state.collapsedPaneIndices);
          const visibleCount = state.panes.filter((_, i) => !collapsedSet.has(i)).length;
          if (visibleCount > 1) {
            do {
              state.focusedPane = (state.focusedPane + 1) % state.panes.length;
            } while (collapsedSet.has(state.focusedPane));
          }
          doRender(state);
          break;
        }
        case "focus_prev_pane": {
          const collapsedSet = new Set(state.collapsedPaneIndices);
          const visibleCount = state.panes.filter((_, i) => !collapsedSet.has(i)).length;
          if (visibleCount > 1) {
            do {
              state.focusedPane = (state.focusedPane + state.panes.length - 1) % state.panes.length;
            } while (collapsedSet.has(state.focusedPane));
          }
          doRender(state);
          break;
        }
        case "view_cell": {
          // Get the current cell's full content
          let col: ColumnInfo | undefined;
          let raw: CellValue = null;
          if (state.panes.length > 0) {
            const paneIdx = state.overlayPaneIndex ?? state.focusedPane;
            const pane = state.panes[paneIdx];
            if (pane && pane.cursorCol < pane.columns.length) {
              col = pane.columns[pane.cursorCol];
              const values = pane.colValues[col.colId];
              raw = values ? values[pane.cursorRow] : null;
            }
          } else {
            if (state.cursorCol < state.columns.length) {
              col = state.columns[state.cursorCol];
              const values = state.colValues[col.colId];
              raw = values ? values[state.cursorRow] : null;
            }
          }
          if (col) {
            state.cellViewerContent = formatCellValue(raw, col.type, col.widgetOptions, col.displayValues);
            state.cellViewerScroll = 0;
            state.mode = "cell_viewer";
          }
          doRender(state);
          break;
        }
        case "open_url": {
          const url = action.url;
          if (/^https?:\/\//.test(url)) {
            const cmd = process.platform === "darwin" ? "open" :
              process.platform === "win32" ? "start" : "xdg-open";
            exec(`${cmd} ${JSON.stringify(url)}`);
            state.statusMessage = `Opened ${url}`;
          }
          doRender(state);
          break;
        }
        case "close_overlay":
          state.mode = "grid";
          state.overlayPaneIndex = null;
          if (state.panes.length > 0) {
            applyAllSectionLinks(state, conn);
          }
          doRender(state);
          break;
        case "cycle_theme": {
          const next = cycleTheme(state.theme);
          state.theme = next.theme;
          state.statusMessage = `Theme: ${next.name}`;
          doRender(state);
          break;
        }
        case "none":
          break;
      }
    });
  });
}

async function loadTable(state: AppState, conn: ConsoleConnection): Promise<void> {
  const data = await conn.fetchTable(state.currentTableId);
  state.columns = data.columns;
  state.rowIds = data.rowIds;
  state.colValues = data.colValues;
  state.cursorRow = 0;
  state.cursorCol = 0;
  state.scrollRow = 0;
  state.scrollCol = 0;
  await resolveDisplayValues(state.columns, conn);
}

/**
 * For Ref/RefList columns with a visibleCol, fetch the referenced table
 * and build a rowId → display string mapping.
 */
async function resolveDisplayValues(columns: ColumnInfo[], conn: ConsoleConnection): Promise<void> {
  const metaTables = conn.getMetaTables();
  for (const col of columns) {
    const baseType = col.type.split(":")[0];
    if ((baseType !== "Ref" && baseType !== "RefList") || !col.visibleCol) {
      continue;
    }
    const refTableId = col.type.split(":").slice(1).join(":");
    if (!refTableId) { continue; }

    // Resolve visibleCol ref to a colId
    const visColInfo = getColumnInfo(metaTables, col.visibleCol);
    if (!visColInfo) { continue; }

    try {
      const refData = await conn.fetchTable(refTableId);
      const displayCol = refData.colValues[visColInfo.colId];
      if (!displayCol) { continue; }

      const displayMap = new Map<number, string>();
      for (let i = 0; i < refData.rowIds.length; i++) {
        const val = displayCol[i];
        displayMap.set(refData.rowIds[i], val == null ? "" : String(val));
      }
      col.displayValues = displayMap;
    } catch {
      // Referenced table might not be accessible; fall back to row IDs
    }
  }
}

/**
 * Load a page: extract sections, fetch data, build layout, apply linking.
 */
async function loadPage(state: AppState, conn: ConsoleConnection, viewId: number): Promise<void> {
  const metaTables = conn.getMetaTables();
  const sections = extractSectionsForView(metaTables, viewId);

  if (sections.length === 0) {
    state.panes = [];
    state.layout = null;
    state.statusMessage = "No sections on this page";
    return;
  }

  // Fetch data for each unique table
  const tableDataCache = new Map<string, { rowIds: number[]; colValues: BulkColValues }>();
  for (const sec of sections) {
    if (!tableDataCache.has(sec.tableId)) {
      const data = await conn.fetchTable(sec.tableId);
      tableDataCache.set(sec.tableId, { rowIds: data.rowIds, colValues: data.colValues });
    }
  }

  // Build PaneState for each section
  const panes: PaneState[] = [];
  const sectionIdToPaneIndex = new Map<number, number>();

  for (const sec of sections) {
    const columns = conn.getColumnsForSection(sec.sectionId);
    await resolveDisplayValues(columns, conn);
    const tableData = tableDataCache.get(sec.tableId)!;
    const paneIndex = panes.length;
    sectionIdToPaneIndex.set(sec.sectionId, paneIndex);
    panes.push({
      sectionInfo: sec,
      columns,
      rowIds: [...tableData.rowIds],
      allRowIds: [...tableData.rowIds],
      colValues: copyColValues(tableData.colValues),
      allColValues: copyColValues(tableData.colValues),
      cursorRow: 0,
      cursorCol: 0,
      scrollRow: 0,
      scrollCol: 0,
    });
  }

  state.panes = panes;
  state.focusedPane = 0;

  // Parse layout spec and compute layout
  const layoutSpec = getLayoutSpecForView(metaTables, viewId);
  const sectionIds = sections.map(s => s.sectionId);
  state.boxSpec = parseLayoutSpec(layoutSpec, sectionIds);

  // Identify collapsed sections
  const collapsedIds = extractCollapsedSectionIds(state.boxSpec);
  state.collapsedPaneIndices = collapsedIds
    .map(id => sectionIdToPaneIndex.get(id))
    .filter((idx): idx is number => idx !== undefined);
  state.overlayPaneIndex = null;

  // Set focusedPane to the first visible (non-collapsed) pane
  const collapsedSet = new Set(state.collapsedPaneIndices);
  state.focusedPane = panes.findIndex((_, i) => !collapsedSet.has(i));
  if (state.focusedPane < 0) { state.focusedPane = 0; }

  const termRows = process.stdout.rows || 24;
  const termCols = process.stdout.columns || 80;
  const trayHeight = state.collapsedPaneIndices.length > 0 ? 1 : 0;
  const rect: Rect = { top: 0, left: 0, width: termCols, height: termRows - 2 - trayHeight };
  state.layout = computeLayout(state.boxSpec, rect, sectionIdToPaneIndex);

  // Apply initial section linking
  applyAllSectionLinks(state, conn);
}

/**
 * Recompute layout after terminal resize.
 */
function recomputeLayout(state: AppState): void {
  if (!state.panes.length || !state.boxSpec) { return; }

  const sectionIdToPaneIndex = new Map<number, number>();
  for (let i = 0; i < state.panes.length; i++) {
    sectionIdToPaneIndex.set(state.panes[i].sectionInfo.sectionId, i);
  }

  const termRows = process.stdout.rows || 24;
  const termCols = process.stdout.columns || 80;
  const trayHeight = state.collapsedPaneIndices.length > 0 ? 1 : 0;
  const rect: Rect = { top: 0, left: 0, width: termCols, height: termRows - 2 - trayHeight };
  state.layout = computeLayout(state.boxSpec, rect, sectionIdToPaneIndex);
}

/**
 * Copy all* to visible, then apply sorting and filtering to the visible copy.
 * This keeps all* as the unmodified server data so it can be re-applied safely.
 */
function reapplySortAndFilter(pane: PaneState, metaTables: any): void {
  pane.rowIds = [...pane.allRowIds];
  pane.colValues = copyColValues(pane.allColValues);
  applySectionFilters(pane, pane.sectionInfo.sectionId, metaTables);
  if (pane.sectionInfo.sortColRefs) {
    applySortSpec(pane, pane.sectionInfo.sortColRefs, metaTables);
  }
}

/**
 * Apply section linking across all panes.
 * For each pane with linkSrcSectionRef, filter its rows based on the source pane's cursor.
 */
function applyAllSectionLinks(state: AppState, conn: ConsoleConnection): void {
  const metaTables = conn.getMetaTables();

  // Re-apply sort/filter to all panes before linking
  for (const pane of state.panes) {
    reapplySortAndFilter(pane, metaTables);
  }

  for (const pane of state.panes) {
    const srcRef = pane.sectionInfo.linkSrcSectionRef;
    if (!srcRef) { continue; }

    // Find source pane
    const srcPane = state.panes.find(p => p.sectionInfo.sectionId === srcRef);
    if (!srcPane) { continue; }

    const srcColRef = pane.sectionInfo.linkSrcColRef;
    const tgtColRef = pane.sectionInfo.linkTargetColRef;

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
      const tgtColId = layoutGetColIdByRef(metaTables, tgtColRef);
      filterPaneRows(pane, tgtColId, srcRowId);
    } else if (srcColRef > 0 && tgtColRef > 0) {
      // Filter where tgtCol == srcColValue
      const srcColId = layoutGetColIdByRef(metaTables, srcColRef);
      const srcValues = srcPane.colValues[srcColId];
      const srcValue = srcValues ? srcValues[srcRowIdx] : null;
      const tgtColId = layoutGetColIdByRef(metaTables, tgtColRef);
      filterPaneRows(pane, tgtColId, srcValue);
    } else if (srcColRef === 0 && tgtColRef === 0) {
      // Cursor sync -- all rows visible, sync cursor position
      const idx = pane.rowIds.indexOf(srcRowId);
      if (idx >= 0) {
        pane.cursorRow = idx;
      }
    } else if (srcColRef > 0 && tgtColRef === 0) {
      // Cursor follows ref value
      const srcColId = layoutGetColIdByRef(metaTables, srcColRef);
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
 * Filter a pane's visible rows to those where colId == value.
 * Reads from rowIds/colValues (already sorted/filtered by reapplySortAndFilter),
 * writes filtered result back to rowIds/colValues.
 */
function filterPaneRows(pane: PaneState, colId: string, value: any): void {
  if (!colId) {
    return;
  }

  const colValues = pane.colValues[colId];
  if (!colValues) {
    return;
  }

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

function copyColValues(cv: BulkColValues): BulkColValues {
  const result: BulkColValues = {};
  for (const [k, v] of Object.entries(cv)) {
    result[k] = [...v];
  }
  return result;
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
    const colId = layoutGetColIdByRef(metaTables, colRef);
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
      // Empty list -- use fallback
      const fallback = colType === "ChoiceList" ? "" : null;
      return values.has(fallback) === include;
    }
    return items.some(item => values.has(item) === include);
  }
  const key = Array.isArray(val) ? JSON.stringify(val) : val;
  return values.has(key) === include;
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
 * Return the default value for a column type when the server omits it from an AddRecord action.
 */
function defaultForColumnType(colType: string): CellValue {
  const baseType = colType.split(":")[0];
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

function doRender(state: AppState): void {
  process.stdout.write(render(state));
}

function doCleanup(state: AppState, conn: ConsoleConnection, resolve: () => void): void {
  process.stdout.write(showCursor());
  process.stdout.write("\x1b[0m\x1b[2J\x1b[H");
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("end");
  process.stdout.removeAllListeners("resize");
  conn.close().then(() => resolve()).catch(() => resolve());
}

/**
 * Apply incoming DocActions to local state for live updates.
 */
function applyDocActions(state: AppState, actions: DocAction[]): void {
  for (const action of actions) {
    const actionType = action[0];
    const tableId = action[1] as string;

    // In multi-pane mode, route to all matching panes
    if (state.panes.length > 0) {
      for (const pane of state.panes) {
        if (pane.sectionInfo.tableId === tableId) {
          applyDocActionToPane(pane, action);
        }
      }
      continue;
    }

    // Single-pane mode: only apply to current table
    if (tableId !== state.currentTableId) { continue; }

    switch (actionType) {
      case "UpdateRecord": {
        const [, , rowId, colValues] = action as any;
        const rowIdx = state.rowIds.indexOf(rowId);
        if (rowIdx === -1) { break; }
        for (const [colId, value] of Object.entries(colValues)) {
          if (state.colValues[colId]) {
            state.colValues[colId][rowIdx] = value as any;
          }
        }
        break;
      }
      case "BulkUpdateRecord": {
        const [, , rowIds, colValues] = action as any;
        for (let i = 0; i < rowIds.length; i++) {
          const rowIdx = state.rowIds.indexOf(rowIds[i]);
          if (rowIdx === -1) { continue; }
          for (const [colId, values] of Object.entries(colValues as Record<string, any[]>)) {
            if (state.colValues[colId]) {
              state.colValues[colId][rowIdx] = values[i];
            }
          }
        }
        break;
      }
      case "AddRecord": {
        const [, , rowId, colValues] = action as any;
        state.rowIds.push(rowId);
        for (const col of state.columns) {
          if (!state.colValues[col.colId]) {
            state.colValues[col.colId] = [];
          }
          state.colValues[col.colId].push(colValues[col.colId] ?? defaultForColumnType(col.type));
        }
        break;
      }
      case "BulkAddRecord": {
        const [, , rowIds, colValues] = action as any;
        for (let i = 0; i < rowIds.length; i++) {
          state.rowIds.push(rowIds[i]);
          for (const col of state.columns) {
            if (!state.colValues[col.colId]) {
              state.colValues[col.colId] = [];
            }
            const vals = colValues[col.colId];
            state.colValues[col.colId].push(vals ? vals[i] : defaultForColumnType(col.type));
          }
        }
        break;
      }
      case "RemoveRecord": {
        const [, , rowId] = action as any;
        const rowIdx = state.rowIds.indexOf(rowId);
        if (rowIdx === -1) { break; }
        state.rowIds.splice(rowIdx, 1);
        for (const col of state.columns) {
          if (state.colValues[col.colId]) {
            state.colValues[col.colId].splice(rowIdx, 1);
          }
        }
        if (state.cursorRow >= state.rowIds.length && state.cursorRow > 0) {
          state.cursorRow = state.rowIds.length - 1;
        }
        break;
      }
      case "BulkRemoveRecord": {
        const [, , rowIds] = action as any;
        for (const rowId of rowIds) {
          const rowIdx = state.rowIds.indexOf(rowId);
          if (rowIdx === -1) { continue; }
          state.rowIds.splice(rowIdx, 1);
          for (const col of state.columns) {
            if (state.colValues[col.colId]) {
              state.colValues[col.colId].splice(rowIdx, 1);
            }
          }
        }
        if (state.cursorRow >= state.rowIds.length && state.cursorRow > 0) {
          state.cursorRow = state.rowIds.length - 1;
        }
        break;
      }
      case "AddColumn":
      case "RemoveColumn":
      case "RenameColumn":
      case "ModifyColumn":
        state.statusMessage = "Schema changed - press r to refresh";
        break;
    }
  }
}

/**
 * Apply a single DocAction to a pane's all-data (allRowIds + allColValues).
 * Visible rowIds/colValues will be rebuilt by applyAllSectionLinks afterward.
 */
function applyDocActionToPane(pane: PaneState, action: DocAction): void {
  const actionType = action[0];

  switch (actionType) {
    case "UpdateRecord": {
      const [, , rowId, colValues] = action as any;
      const allIdx = pane.allRowIds.indexOf(rowId);
      if (allIdx === -1) { break; }
      for (const [colId, value] of Object.entries(colValues)) {
        if (pane.allColValues[colId]) {
          pane.allColValues[colId][allIdx] = value as any;
        }
      }
      // Also update visible colValues if the row is visible
      const visIdx = pane.rowIds.indexOf(rowId);
      if (visIdx >= 0) {
        for (const [colId, value] of Object.entries(colValues)) {
          if (pane.colValues[colId]) {
            pane.colValues[colId][visIdx] = value as any;
          }
        }
      }
      break;
    }
    case "BulkUpdateRecord": {
      const [, , rowIds, colValues] = action as any;
      for (let i = 0; i < rowIds.length; i++) {
        const allIdx = pane.allRowIds.indexOf(rowIds[i]);
        if (allIdx === -1) { continue; }
        for (const [colId, values] of Object.entries(colValues as Record<string, any[]>)) {
          if (pane.allColValues[colId]) {
            pane.allColValues[colId][allIdx] = values[i];
          }
        }
        const visIdx = pane.rowIds.indexOf(rowIds[i]);
        if (visIdx >= 0) {
          for (const [colId, values] of Object.entries(colValues as Record<string, any[]>)) {
            if (pane.colValues[colId]) {
              pane.colValues[colId][visIdx] = values[i];
            }
          }
        }
      }
      break;
    }
    case "AddRecord": {
      const [, , rowId, colValues] = action as any;
      pane.allRowIds.push(rowId);
      for (const col of pane.columns) {
        if (!pane.allColValues[col.colId]) {
          pane.allColValues[col.colId] = [];
        }
        pane.allColValues[col.colId].push(colValues[col.colId] ?? defaultForColumnType(col.type));
      }
      // Also add to visible (linking will re-filter next)
      pane.rowIds.push(rowId);
      for (const col of pane.columns) {
        if (!pane.colValues[col.colId]) {
          pane.colValues[col.colId] = [];
        }
        pane.colValues[col.colId].push(colValues[col.colId] ?? defaultForColumnType(col.type));
      }
      break;
    }
    case "BulkAddRecord": {
      const [, , rowIds, colValues] = action as any;
      for (let i = 0; i < rowIds.length; i++) {
        pane.allRowIds.push(rowIds[i]);
        pane.rowIds.push(rowIds[i]);
        for (const col of pane.columns) {
          if (!pane.allColValues[col.colId]) { pane.allColValues[col.colId] = []; }
          if (!pane.colValues[col.colId]) { pane.colValues[col.colId] = []; }
          const vals = colValues[col.colId];
          const v = vals ? vals[i] : defaultForColumnType(col.type);
          pane.allColValues[col.colId].push(v);
          pane.colValues[col.colId].push(v);
        }
      }
      break;
    }
    case "RemoveRecord": {
      const [, , rowId] = action as any;
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
      if (pane.cursorRow >= pane.rowIds.length && pane.cursorRow > 0) {
        pane.cursorRow = pane.rowIds.length - 1;
      }
      break;
    }
    case "BulkRemoveRecord": {
      const [, , rowIds] = action as any;
      for (const rowId of rowIds) {
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
      if (pane.cursorRow >= pane.rowIds.length && pane.cursorRow > 0) {
        pane.cursorRow = pane.rowIds.length - 1;
      }
      break;
    }
  }
}
