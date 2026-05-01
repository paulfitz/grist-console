/**
 * Application state types shared across the input, renderer, and main
 * event-loop modules. Kept separate from rendering so input/data-action
 * code can import state types without pulling in ANSI output code.
 */

import { BulkColValues, ColumnInfo } from "./types.js";
import { BoxSpec, LayoutNode, PageInfo, SectionInfo } from "./ConsoleLayout.js";
import { SiteDoc } from "./SiteApi.js";
import { Theme, defaultTheme } from "./ConsoleTheme.js";

export type AppMode =
  | "site_picker"
  | "table_picker"
  | "page_picker"
  | "grid"
  | "editing"
  | "confirm_delete"
  | "overlay"
  | "cell_viewer"
  | "command_palette";

/**
 * A view of one section's data. Used for both multi-pane page layouts and
 * single-table grid mode. In single-table mode, `sectionInfo` is absent and
 * `allRowIds` / `allColValues` (the link-linking "master" copies) are unused.
 */
export interface PaneState {
  sectionInfo?: SectionInfo;
  columns: ColumnInfo[];
  rowIds: number[];
  allRowIds: number[];
  colValues: BulkColValues;
  allColValues: BulkColValues;
  cursorRow: number;
  cursorCol: number;
  scrollRow: number;
  scrollCol: number;
}

export interface AppState {
  mode: AppMode;
  tableIds: string[];
  selectedTableIndex: number;
  currentTableId: string;
  // Edit buffer (shared between single-pane and multi-pane edit modes).
  editValue: string;
  editCursorPos: number;
  statusMessage: string;
  docId: string;
  // View state. `panes` is the data source of truth for both single-table
  // mode (one synthetic pane, no sectionInfo) and multi-section pages
  // (multiple PaneStates). `focusedPane` indexes `panes`; `layout` describes
  // how they're arranged on screen.
  pages: PageInfo[];
  selectedPageIndex: number;
  currentPageId: number;
  panes: PaneState[];
  layout: LayoutNode | null;
  boxSpec: BoxSpec | null;
  focusedPane: number;
  // Set true when a server-side schema change (Add/Remove/Rename/ModifyColumn)
  // arrives. Subsequent data actions are skipped (they may reference columns
  // we no longer know about) until the user refreshes via loadTable/loadPage.
  schemaStale: boolean;
  // Collapsed widget tray
  collapsedPaneIndices: number[];
  overlayPaneIndex: number | null;
  // Cell viewer
  cellViewerContent: string;
  cellViewerScroll: number;
  cellViewerLinkIndex: number;  // -1 = no link selected, 0+ = selected link
  // Undo/redo stack of (actionNum, actionHash) for actions this client made.
  // Pointer indicates current position; items past pointer are "redo" candidates.
  undoStack: Array<{ actionNum: number; actionHash: string }>;
  undoPointer: number; // index of next action that would be undone; 0 = nothing to undo
  // Theme
  theme: Theme;
  // Site picker (mode "site_picker"). Empty when navigating inside a doc;
  // populated when the user launched grist-console against a site URL or
  // popped back to the picker via Ctrl-F.
  siteDocs: SiteDoc[];
  siteCursor: number;
  // Command palette (mode "command_palette"). Doubles as the help screen:
  // every keybinding lives here as a runnable command, and typing into the
  // query box filters the list. paletteReturnMode is the mode to restore
  // when the user closes the palette without picking a command.
  paletteQuery: string;
  paletteCursor: number;
  paletteReturnMode: AppMode;
  /** True when the app was launched via a site URL, so the table/page
   *  pickers should offer "s" to pop back to the site picker. */
  hasSiteContext: boolean;
}

export function createInitialState(docId: string, theme?: Theme): AppState {
  return {
    mode: "table_picker",
    tableIds: [],
    selectedTableIndex: 0,
    currentTableId: "",
    editValue: "",
    editCursorPos: 0,
    statusMessage: "",
    docId,
    pages: [],
    selectedPageIndex: 0,
    currentPageId: 0,
    panes: [],
    layout: null,
    boxSpec: null,
    focusedPane: 0,
    schemaStale: false,
    collapsedPaneIndices: [],
    overlayPaneIndex: null,
    cellViewerContent: "",
    cellViewerScroll: 0,
    cellViewerLinkIndex: -1,
    undoStack: [],
    undoPointer: 0,
    theme: theme || defaultTheme,
    siteDocs: [],
    siteCursor: 0,
    hasSiteContext: false,
    paletteQuery: "",
    paletteCursor: 0,
    paletteReturnMode: "table_picker",
  };
}

export function isCardPane(pane: PaneState): boolean {
  const pk = pane.sectionInfo?.parentKey;
  return pk === "single" || pk === "detail";
}

/**
 * Return the pane the user is currently interacting with: the overlay pane
 * if one is open, else the focused pane. Returns undefined only if there
 * are no panes (e.g. picker modes before data loads).
 */
export function activeView(state: AppState): PaneState | undefined {
  if (state.overlayPaneIndex !== null && state.panes[state.overlayPaneIndex]) {
    return state.panes[state.overlayPaneIndex];
  }
  return state.panes[state.focusedPane];
}

/**
 * Mode to switch back to when leaving edit mode -- preserves the underlying
 * view (cell viewer takes precedence, then overlay, then grid).
 */
export function editReturnMode(state: AppState): AppMode {
  if (state.cellViewerContent) { return "cell_viewer"; }
  if (state.overlayPaneIndex !== null) { return "overlay"; }
  return "grid";
}

/**
 * Resolve the Grist tableId backing a pane. Multi-section panes carry it
 * on their sectionInfo; single-table mode falls back to the loaded table.
 */
export function paneTableId(pane: PaneState, state: AppState): string {
  return pane.sectionInfo?.tableId || state.currentTableId;
}

/**
 * Human-readable title for a pane: the section's display title if set,
 * else the tableId, else empty.
 */
export function paneTitle(pane: PaneState): string {
  return pane.sectionInfo?.title || pane.sectionInfo?.tableId || "";
}
