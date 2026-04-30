import { BulkColValues, ColumnInfo, getBaseType } from "./types.js";
import { ConsoleConnection } from "./ConsoleConnection.js";
import { AppState, PaneState, createInitialState, activeView } from "./ConsoleAppState.js";
import { render, showCursor } from "./ConsoleRenderer.js";
import {
  ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, SYNC_BEGIN, SYNC_END,
  ENABLE_BRACKETED_PASTE, DISABLE_BRACKETED_PASTE, PASTE_BEGIN, PASTE_END,
} from "./ConsoleDisplay.js";
import { applyPasteToEdit, handleKeypress } from "./ConsoleInput.js";
import { executeAddRow, executeDeleteRow, executeSaveEdit } from "./Commands.js";
import {
  extractPages, extractSectionsForView,
  extractCollapsedSectionIds, getLayoutSpecForView,
  parseLayoutSpec, computeLayout, getColumnInfo, collectLeaves, Rect,
} from "./ConsoleLayout.js";
import { buildDisplayMap, formatCellValue } from "./ConsoleCellFormat.js";
import { Theme, defaultTheme, cycleTheme, isGoatTheme } from "./ConsoleTheme.js";
import { stepGoat, resetGoat } from "./GoatAnimation.js";
import { exec } from "child_process";
import { calibrateTermWidth, disableMode2027 } from "./termWidth.js";
import { handleOwnActionGroup, executeUndo, executeRedo } from "./UndoStack.js";
import {
  scheduleProbe, bufferInput, setReplayHandler, isProbing, printWidthReport,
  resetProbeState,
} from "./WidthProbe.js";
import { applyDocActions } from "./ActionDispatcher.js";
import { applyAllSectionLinks as _applyAllSectionLinks, copyColValues } from "./LinkingState.js";
import { trace } from "./Trace.js";

function applyAllSectionLinks(state: AppState, conn: ConsoleConnection): void {
  _applyAllSectionLinks(state, conn.getMetaTables());
}

/** Maps from edit-style InputAction.type to its executor in Commands.ts. */
const commandFns: Record<string, (s: AppState, c: ConsoleConnection) => Promise<void>> = {
  save_edit: executeSaveEdit,
  add_row: executeAddRow,
  delete_row: executeDeleteRow,
};

/**
 * Outcome of running the console client for one doc. "switch_to_site"
 * means the user wants to pop back to the site picker; the orchestrator
 * in index.ts loops on that and reopens the picker.
 */
export type ConsoleMainResult = { kind: "quit" } | { kind: "switch_to_site" };

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
  /** Set when the app was launched against a site URL -- enables "s" in
   *  the pickers to pop back to the site picker. */
  hasSiteContext?: boolean;
  /** When true, the caller is managing alt-screen / raw-mode lifecycle.
   *  consoleMain skips entering/exiting those modes and only handles its
   *  own per-doc setup (listeners, conn). Used by index.ts so we don't
   *  toggle the terminal between consoleMain and runSitePicker. */
  persistTerminal?: boolean;
}): Promise<ConsoleMainResult> {
  const conn = new ConsoleConnection(options.serverUrl, options.docId, options.apiKey, { verbose: options.verbose });
  const state: AppState = createInitialState(options.docId, options.theme || defaultTheme);
  state.hasSiteContext = !!options.hasSiteContext;
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

  // Surface unexpected disconnects in the status line. Subsequent edits
  // will fast-fail rather than hanging for 30s waiting for a response.
  conn.onDisconnect((reason) => {
    state.statusMessage = `Disconnected: ${reason}. Press Ctrl+C to quit.`;
    doRender(state);
  });

  // Enter the alternate screen buffer so the initial state is clean and
  // the user's scrollback isn't polluted with our rendering. Also ask
  // the terminal to wrap pastes with \x1b[200~ ... \x1b[201~ so we can
  // tell paste apart from fast typing.
  const manageTerminal = !options.persistTerminal;
  if (manageTerminal && process.stdout.isTTY) {
    process.stdout.write(ENTER_ALT_SCREEN + ENABLE_BRACKETED_PASTE);
  }

  // Initial render
  doRender(state);
  scheduleProbe(state, doRender);

  // Goat animation timer: when the goat theme is active and we're in a
  // grid-ish mode, advance the wandering goat on a quick tick so it
  // visibly moves. Starts/stops as the user cycles themes; cleaned up
  // on exit.
  let goatTimer: ReturnType<typeof setInterval> | null = null;
  const syncGoatTimer = () => {
    const shouldRun = isGoatTheme(state.theme)
      && (state.mode === "grid" || state.mode === "editing");
    if (shouldRun && !goatTimer) {
      // Place the goat right away so the user sees it on the very next
      // render (otherwise they'd wait a tick wondering where the goat
      // is), then keep it wandering on the interval.
      stepGoat(state);
      doRender(state);
      goatTimer = setInterval(() => {
        stepGoat(state);
        doRender(state);
      }, 900);
      goatTimer.unref?.();
    } else if (!shouldRun && goatTimer) {
      clearInterval(goatTimer);
      goatTimer = null;
      resetGoat();
      doRender(state);
    }
  };
  syncGoatTimer();

  // Return a promise that resolves when the user quits or asks to switch
  // back to the site picker.
  return new Promise<ConsoleMainResult>((resolve) => {
    // Set up raw mode input (skip if the caller is managing terminal mode).
    if (manageTerminal && process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }
    process.stdin.resume();

    // Handle terminal resize
    process.stdout.on("resize", () => {
      recomputeLayout(state);
      doRender(state);
    });

    const cleanupGoat = () => {
      if (goatTimer) { clearInterval(goatTimer); goatTimer = null; }
      resetGoat();
    };

    process.stdin.on("end", () => {
      cleanupGoat();
      doCleanup(state, conn, resolve, { kind: "quit" }, manageTerminal);
    });

    // Bracketed-paste accumulator. While a paste is in progress, further
    // data chunks are concatenated until we see the PASTE_END sentinel
    // (the clipboard may not arrive in a single read).
    let pasteBuf: string | null = null;

    const dataHandler = async (data: Buffer) => {
      // If probing is active, buffer input to replay after
      if (isProbing()) {
        bufferInput(data);
        return;
      }

      let text = data.toString("utf8");

      // Continue an in-progress paste.
      if (pasteBuf !== null) {
        const endIdx = text.indexOf(PASTE_END);
        if (endIdx < 0) {
          pasteBuf += text;
          return;
        }
        const content = pasteBuf + text.slice(0, endIdx);
        pasteBuf = null;
        await handlePaste(content);
        text = text.slice(endIdx + PASTE_END.length);
        if (text.length === 0) { return; }
      }

      // Split out any bracketed pastes in this chunk. Non-paste bytes
      // flow through the normal handler; the paste payload becomes a
      // single action regardless of how many bytes it contains.
      let startIdx = text.indexOf(PASTE_BEGIN);
      while (startIdx >= 0) {
        const pre = text.slice(0, startIdx);
        if (pre.length > 0) { await handleData(Buffer.from(pre, "utf8")); }
        const after = text.slice(startIdx + PASTE_BEGIN.length);
        const endIdx = after.indexOf(PASTE_END);
        if (endIdx < 0) {
          // Paste spans this chunk -- buffer the tail and wait.
          pasteBuf = after;
          return;
        }
        await handlePaste(after.slice(0, endIdx));
        text = after.slice(endIdx + PASTE_END.length);
        startIdx = text.indexOf(PASTE_BEGIN);
      }

      // Belt-and-braces for terminals that don't support bracketed
      // paste: if we're in editing mode and the chunk is a run of
      // printable codepoints (no ESC, no control codes besides tab /
      // newline / CR), treat it as a paste. Confined to editing mode
      // because key-repeat in grid mode can batch navigation keys into
      // a single chunk, which would otherwise be misread as paste.
      if (text.length > 0 && state.mode === "editing") {
        const cps = [...text];
        const clean = cps.every(c => !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(c));
        if (cps.length >= 2 && clean) {
          await handlePaste(text);
          return;
        }
      }

      if (text.length > 0) { await handleData(Buffer.from(text, "utf8")); }
    };

    const handlePaste = async (content: string) => {
      // Normalise CRLF and stray CR to LF so downstream cell handling
      // doesn't see mixed line endings.
      content = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      if (state.mode === "grid") {
        // Start editing the current cell with the pasted content as the
        // initial value, mirroring what a user would expect from a
        // spreadsheet paste (overwrite cell, stay in edit mode).
        const pane = state.panes[state.focusedPane];
        if (!pane || pane.rowIds.length === 0 || pane.columns.length === 0) { return; }
        state.mode = "editing";
        state.editValue = content;
        state.editCursorPos = content.length;
      } else if (state.mode === "editing") {
        applyPasteToEdit(state, content);
      } else {
        return;
      }
      doRender(state);
    };

    const handleData = async (data: Buffer) => {
      const action = handleKeypress(Buffer.from(data), state);
      switch (action.type) {
        case "quit":
          cleanupGoat();
          doCleanup(state, conn, resolve, { kind: "quit" }, manageTerminal);
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
          clearViewState(state);
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
        case "add_row":
        case "delete_row":
          await commandFns[action.type](state, conn);
          applyAllSectionLinks(state, conn);
          doRender(state);
          break;
        case "switch_to_site":
          trace(`consoleMain: switch_to_site action received`);
          cleanupGoat();
          doCleanup(state, conn, resolve, { kind: "switch_to_site" }, manageTerminal);
          return;
        case "switch_to_tables":
        case "switch_to_pages":
          state.mode = action.type === "switch_to_tables" ? "table_picker" : "page_picker";
          clearViewState(state);
          state.statusMessage = "";
          doRender(state);
          break;
        case "focus_next_pane":
        case "focus_prev_pane":
          cyclePane(state, action.type === "focus_next_pane" ? 1 : -1);
          doRender(state);
          break;
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
          syncGoatTimer();
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
      // After every user action, consider scheduling a probe + (re)sync
      // the goat timer (starts when theme+mode permit, stops otherwise).
      scheduleProbe(state, doRender);
      syncGoatTimer();
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
 * Drop all loaded view state (panes, layout, box spec, schema-stale flag).
 * Used when leaving grid mode for a picker, or when a load is about to
 * start. Exported so tests can verify the reset shape.
 */
export function clearViewState(state: AppState): void {
  state.panes = [];
  state.layout = null;
  state.boxSpec = null;
  state.focusedPane = 0;
  state.overlayPaneIndex = null;
  state.collapsedPaneIndices = [];
  state.schemaStale = false;
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
  state.schemaStale = false;
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
    const baseType = getBaseType(col.type);
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

      // Format each display value through the display column's own type
      // + widgetOptions, so a Date display column renders as a date rather
      // than a raw timestamp (and similarly for DateTime, Numeric, etc.).
      col.displayValues = buildDisplayMap(
        refData.rowIds, displayCol, visColInfo.type, visColInfo.widgetOptions,
      );
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
    clearViewState(state);
    state.statusMessage = "No sections on this page";
    return;
  }
  state.schemaStale = false;

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
  process.stdout.write(SYNC_BEGIN + render(state) + SYNC_END);
}

function doCleanup(
  state: AppState, conn: ConsoleConnection,
  resolve: (r: ConsoleMainResult) => void,
  result: ConsoleMainResult = { kind: "quit" },
  manageTerminal = true,
): void {
  // Tear down terminal mode only when:
  //   - we own the terminal lifecycle (manageTerminal), AND
  //   - this is a real quit, not a switch_to_site handoff.
  // Toggling alt-screen / bracketed-paste / raw-mode mid-session can
  // make the TTY emit response bytes that get re-injected as keypresses,
  // silently quitting the next picker.
  const isQuit = result.kind === "quit";
  if (manageTerminal && isQuit) {
    disableMode2027();
    process.stdout.write(showCursor());
    process.stdout.write("\x1b[0m");
    if (process.stdout.isTTY) {
      process.stdout.write(DISABLE_BRACKETED_PASTE + EXIT_ALT_SCREEN);
    } else {
      process.stdout.write("\x1b[2J\x1b[H");
    }
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(false);
    }
    process.stdin.pause();
  }
  trace(`consoleMain: doCleanup kind=${result.kind} manageTerminal=${manageTerminal} dataListeners=${process.stdin.listenerCount("data")}`);
  process.stdin.removeAllListeners("data");
  process.stdin.removeAllListeners("end");
  process.stdout.removeAllListeners("resize");
  // Drop any debounced probe + replay handler so they can't fire on
  // stale state after we hand off to the site picker.
  resetProbeState();

  if (isQuit && _verbose) {
    printWidthReport();
  }

  conn.close().then(() => resolve(result)).catch(() => resolve(result));
}

