import { BulkColValues, ColumnInfo } from "./types.js";
import { ConsoleConnection } from "./ConsoleConnection.js";
import { AppState, PaneState, createInitialState, activeView } from "./ConsoleAppState.js";
import { render, showCursor, ENTER_ALT_SCREEN, EXIT_ALT_SCREEN } from "./ConsoleRenderer.js";
import {
  executeAddRow, executeDeleteRow, executeSaveEdit, handleKeypress
} from "./ConsoleInput.js";
import {
  extractPages, extractSectionsForView,
  extractCollapsedSectionIds, getLayoutSpecForView,
  parseLayoutSpec, computeLayout, getColumnInfo, collectLeaves, Rect,
} from "./ConsoleLayout.js";
import { formatCellValue } from "./ConsoleCellFormat.js";
import { Theme, defaultTheme, cycleTheme } from "./ConsoleTheme.js";
import { exec } from "child_process";
import { calibrateTermWidth, disableMode2027 } from "./termWidth.js";
import { handleOwnActionGroup, executeUndo, executeRedo } from "./UndoStack.js";
import {
  scheduleProbe, bufferInput, setReplayHandler, isProbing, printWidthReport,
} from "./WidthProbe.js";
import { applyDocActions } from "./ActionDispatcher.js";
import { applyAllSectionLinks as _applyAllSectionLinks, copyColValues } from "./LinkingState.js";

function applyAllSectionLinks(state: AppState, conn: ConsoleConnection): void {
  _applyAllSectionLinks(state, conn.getMetaTables());
}

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
  _verbose = options.verbose ?? false;

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
  conn.onDocAction((actions, actionGroup) => {
    applyDocActions(state, actions);
    applyAllSectionLinks(state, conn);
    if (actionGroup && actionGroup.fromSelf) {
      handleOwnActionGroup(state, actionGroup);
    }
    doRender(state);
    scheduleProbe(state, doRender);
  });

  // Enter the alternate screen buffer so the initial state is clean and
  // the user's scrollback isn't polluted with our rendering.
  if (process.stdout.isTTY) {
    process.stdout.write(ENTER_ALT_SCREEN);
  }

  // Initial render
  doRender(state);
  scheduleProbe(state, doRender);

  // Return a promise that resolves only when the user quits.
  return new Promise<void>((resolve) => {
    // Set up raw mode input
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Handle terminal resize
    process.stdout.on("resize", () => {
      recomputeLayout(state);
      doRender(state);
    });

    process.stdin.on("end", () => {
      doCleanup(state, conn, resolve);
    });

    const dataHandler = async (data: Buffer) => {
      // If probing is active, buffer input to replay after
      if (isProbing()) {
        bufferInput(data);
        return;
      }
      await handleData(data);
    };

    const handleData = async (data: Buffer) => {
      const action = handleKeypress(Buffer.from(data), state);
      switch (action.type) {
        case "quit":
          doCleanup(state, conn, resolve);
          return;
        case "render": {
          // Clear transient status on any navigation/render
          state.statusMessage = "";
          // After cursor movement, re-run linking (no-op if no panes)
          applyAllSectionLinks(state, conn);
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
            if (state.currentPageId) {
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
          applyAllSectionLinks(state, conn);
          doRender(state);
          break;
        case "add_row":
          await executeAddRow(state, conn);
          applyAllSectionLinks(state, conn);
          doRender(state);
          break;
        case "delete_row":
          await executeDeleteRow(state, conn);
          applyAllSectionLinks(state, conn);
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
          cyclePane(state, 1);
          doRender(state);
          break;
        }
        case "focus_prev_pane": {
          cyclePane(state, -1);
          doRender(state);
          break;
        }
        case "view_cell": {
          const pane = activeView(state);
          if (pane && pane.cursorCol < pane.columns.length) {
            const col = pane.columns[pane.cursorCol];
            const values = pane.colValues[col.colId];
            const raw = values ? values[pane.cursorRow] : null;
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
          applyAllSectionLinks(state, conn);
          doRender(state);
          break;
        case "cycle_theme": {
          const next = cycleTheme(state.theme);
          state.theme = next.theme;
          state.statusMessage = `Theme: ${next.name}`;
          doRender(state);
          break;
        }
        case "undo":
          await executeUndo(state, conn);
          doRender(state);
          break;
        case "redo":
          await executeRedo(state, conn);
          doRender(state);
          break;
        case "none":
          break;
      }
      // After every user action, consider scheduling a probe
      scheduleProbe(state, doRender);
    };

    process.stdin.on("data", dataHandler);

    // Save so probe machinery can replay buffered input through it
    setReplayHandler(handleData);
  });
}

let _verbose = false;

/**
 * Return pane indices in visual order (top-to-bottom, left-to-right),
 * excluding collapsed panes. Uses the layout tree's leaf order.
 */
export function getVisualPaneOrder(state: AppState): number[] {
  if (!state.layout) {
    // No layout yet: fall back to pane-array order, minus collapsed
    const collapsed = new Set(state.collapsedPaneIndices);
    return state.panes.map((_, i) => i).filter(i => !collapsed.has(i));
  }
  const collapsed = new Set(state.collapsedPaneIndices);
  return collectLeaves(state.layout)
    .map(l => l.paneIndex)
    .filter((idx): idx is number => idx !== undefined && !collapsed.has(idx));
}

/**
 * Move focus to the next pane in visual order. direction=1 for next, -1 for prev.
 */
function cyclePane(state: AppState, direction: 1 | -1): void {
  const order = getVisualPaneOrder(state);
  if (order.length < 2) { return; }
  const currentIdx = order.indexOf(state.focusedPane);
  const nextIdx = currentIdx < 0
    ? 0
    : (currentIdx + direction + order.length) % order.length;
  state.focusedPane = order[nextIdx];
}

async function loadTable(state: AppState, conn: ConsoleConnection): Promise<void> {
  const data = await conn.fetchTable(state.currentTableId);
  await resolveDisplayValues(data.columns, conn);
  // Single-table mode = one synthetic pane with no sectionInfo/linking data.
  state.panes = [{
    columns: data.columns,
    rowIds: [...data.rowIds],
    allRowIds: [...data.rowIds],
    colValues: data.colValues,
    allColValues: copyColValues(data.colValues),
    cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
  }];
  state.focusedPane = 0;
  state.layout = null;
  state.boxSpec = null;
  state.collapsedPaneIndices = [];
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
    const sec = state.panes[i].sectionInfo;
    if (sec) { sectionIdToPaneIndex.set(sec.sectionId, i); }
  }

  const termRows = process.stdout.rows || 24;
  const termCols = process.stdout.columns || 80;
  const trayHeight = state.collapsedPaneIndices.length > 0 ? 1 : 0;
  const rect: Rect = { top: 0, left: 0, width: termCols, height: termRows - 2 - trayHeight };
  state.layout = computeLayout(state.boxSpec, rect, sectionIdToPaneIndex);
}

function doRender(state: AppState): void {
  process.stdout.write(render(state));
}

function doCleanup(state: AppState, conn: ConsoleConnection, resolve: () => void): void {
  disableMode2027();
  process.stdout.write(showCursor());
  process.stdout.write("\x1b[0m");
  if (process.stdout.isTTY) {
    process.stdout.write(EXIT_ALT_SCREEN);
  } else {
    // No alt screen was entered (non-TTY); still clear what we wrote
    process.stdout.write("\x1b[2J\x1b[H");
  }
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.stdin.pause();
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("end");
  process.stdout.removeAllListeners("resize");

  if (_verbose) {
    printWidthReport();
  }

  conn.close().then(() => resolve()).catch(() => resolve());
}

