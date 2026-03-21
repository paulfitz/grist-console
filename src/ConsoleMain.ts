import { BulkColValues, DocAction } from "./types";
import { ConsoleConnection } from "./ConsoleConnection";
import { AppState, PaneState, createInitialState, render, showCursor } from "./ConsoleRenderer";
import {
  executeAddRow, executeDeleteRow, executeSaveEdit, handleKeypress
} from "./ConsoleInput";
import {
  extractPages, extractSectionsForView, getLayoutSpecForView,
  parseLayoutSpec, computeLayout,
  getColIdByRef as layoutGetColIdByRef, Rect,
} from "./ConsoleLayout";
import { Theme, defaultTheme, cycleTheme } from "./ConsoleTheme";

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
}): Promise<void> {
  const conn = new ConsoleConnection(options.serverUrl, options.docId, options.apiKey);
  const state: AppState = createInitialState(options.docId, options.theme || defaultTheme);

  // Connect
  process.stdout.write("Connecting...\n");
  try {
    await conn.connect();
  } catch (e: any) {
    process.stderr.write(`Connection failed: ${e.message}\n`);
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
        case "focus_next_pane":
          if (state.panes.length > 1) {
            state.focusedPane = (state.focusedPane + 1) % state.panes.length;
          }
          doRender(state);
          break;
        case "focus_prev_pane":
          if (state.panes.length > 1) {
            state.focusedPane = (state.focusedPane + state.panes.length - 1) % state.panes.length;
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

  const termRows = process.stdout.rows || 24;
  const termCols = process.stdout.columns || 80;
  const rect: Rect = { top: 0, left: 0, width: termCols, height: termRows - 2 };
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
  const rect: Rect = { top: 0, left: 0, width: termCols, height: termRows - 2 };
  state.layout = computeLayout(state.boxSpec, rect, sectionIdToPaneIndex);
}

/**
 * Apply section linking across all panes.
 * For each pane with linkSrcSectionRef, filter its rows based on the source pane's cursor.
 */
function applyAllSectionLinks(state: AppState, conn: ConsoleConnection): void {
  const metaTables = conn.getMetaTables();

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
      // Cursor sync — show all rows, sync cursor position
      pane.rowIds = [...pane.allRowIds];
      rebuildColValuesFromAll(pane);
      const idx = pane.rowIds.indexOf(srcRowId);
      if (idx >= 0) {
        pane.cursorRow = idx;
      }
    } else if (srcColRef > 0 && tgtColRef === 0) {
      // Cursor follows ref value
      const srcColId = layoutGetColIdByRef(metaTables, srcColRef);
      const srcValues = srcPane.colValues[srcColId];
      const refValue = srcValues ? srcValues[srcRowIdx] : null;
      pane.rowIds = [...pane.allRowIds];
      rebuildColValuesFromAll(pane);
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
 * Filter a pane's rows to those where colId == value.
 * Reads from allRowIds/allColValues, writes to rowIds/colValues.
 */
function filterPaneRows(pane: PaneState, colId: string, value: any): void {
  if (!colId) {
    rebuildColValuesFromAll(pane);
    return;
  }

  const allValues = pane.allColValues[colId];
  if (!allValues) {
    rebuildColValuesFromAll(pane);
    return;
  }

  const filteredRowIds: number[] = [];
  const filteredColValues: BulkColValues = {};
  for (const col of pane.columns) {
    filteredColValues[col.colId] = [];
  }

  for (let i = 0; i < pane.allRowIds.length; i++) {
    const cellValue = allValues[i];
    const match = cellValue === value ||
      (typeof cellValue === "number" && cellValue === value) ||
      (Array.isArray(cellValue) && cellValue[0] === "R" && cellValue[2] === value);
    if (match) {
      filteredRowIds.push(pane.allRowIds[i]);
      for (const col of pane.columns) {
        const vals = pane.allColValues[col.colId];
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

function rebuildColValuesFromAll(pane: PaneState): void {
  pane.rowIds = [...pane.allRowIds];
  pane.colValues = copyColValues(pane.allColValues);
}

function copyColValues(cv: BulkColValues): BulkColValues {
  const result: BulkColValues = {};
  for (const [k, v] of Object.entries(cv)) {
    result[k] = [...v];
  }
  return result;
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
          state.colValues[col.colId].push(colValues[col.colId] ?? null);
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
            state.colValues[col.colId].push(vals ? vals[i] : null);
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
        pane.allColValues[col.colId].push(colValues[col.colId] ?? null);
      }
      // Also add to visible (linking will re-filter next)
      pane.rowIds.push(rowId);
      for (const col of pane.columns) {
        if (!pane.colValues[col.colId]) {
          pane.colValues[col.colId] = [];
        }
        pane.colValues[col.colId].push(colValues[col.colId] ?? null);
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
          const v = vals ? vals[i] : null;
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
