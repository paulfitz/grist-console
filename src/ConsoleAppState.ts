/**
 * Application state types shared across the input, renderer, and main
 * event-loop modules. Kept separate from rendering so input/data-action
 * code can import state types without pulling in ANSI output code.
 */

import { BulkColValues, ColumnInfo } from "./types.js";
import { BoxSpec, LayoutNode, PageInfo, SectionInfo } from "./ConsoleLayout.js";
import { Theme, defaultTheme } from "./ConsoleTheme.js";

export type AppMode =
  | "table_picker"
  | "page_picker"
  | "grid"
  | "editing"
  | "confirm_delete"
  | "overlay"
  | "cell_viewer";

export interface PaneState {
  sectionInfo: SectionInfo;
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
  columns: ColumnInfo[];
  rowIds: number[];
  colValues: BulkColValues;
  cursorRow: number;
  cursorCol: number;
  scrollRow: number;
  scrollCol: number;
  editValue: string;
  editCursorPos: number;
  statusMessage: string;
  docId: string;
  // Multi-pane page layout state
  pages: PageInfo[];
  selectedPageIndex: number;
  currentPageId: number;
  panes: PaneState[];
  layout: LayoutNode | null;
  boxSpec: BoxSpec | null;
  focusedPane: number;
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
}

export function createInitialState(docId: string, theme?: Theme): AppState {
  return {
    mode: "table_picker",
    tableIds: [],
    selectedTableIndex: 0,
    currentTableId: "",
    columns: [],
    rowIds: [],
    colValues: {},
    cursorRow: 0,
    cursorCol: 0,
    scrollRow: 0,
    scrollCol: 0,
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
    collapsedPaneIndices: [],
    overlayPaneIndex: null,
    cellViewerContent: "",
    cellViewerScroll: 0,
    cellViewerLinkIndex: -1,
    undoStack: [],
    undoPointer: 0,
    theme: theme || defaultTheme,
  };
}

export function isCardPane(pane: PaneState): boolean {
  const pk = pane.sectionInfo.parentKey;
  return pk === "single" || pk === "detail";
}
