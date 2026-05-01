/**
 * Command palette: a runnable, filterable list that doubles as the help
 * screen. The user opens it with F1, ?, Ctrl+P, or `:` (where `:` isn't
 * needed for cell typing). Typing filters the list; ↑↓ pick; Tab
 * completes the typed query into the highlighted name; Enter runs.
 *
 * Each command names an InputAction so the main loop can dispatch it
 * through its existing switch -- no new action plumbing.
 *
 * Pure-info entries (action.type === "none") let common shortcuts
 * (arrows, type-to-edit, Backspace) show up alongside real commands so
 * the palette also works as the keymap reference. Picking one is a
 * no-op.
 */

import { AppMode, AppState } from "./ConsoleAppState.js";
import { InputAction } from "./ConsoleInput.js";

export interface Command {
  /** Name shown in the list and matched against the query. */
  name: string;
  /** One-line summary, shown next to the name. */
  description: string;
  /** Default keybinding(s), shown right-aligned. Documentation only. */
  bindings: string;
  /** Action dispatched when the user picks this command. "none" makes it a
   *  pure help row that does nothing on Enter. */
  action: InputAction;
  /** Modes in which this command makes sense. Undefined = everywhere. */
  availableIn?: AppMode[];
  /** Hand-picked cluster label, shown as a bold header above the first
   *  command in each group when the user hasn't typed a query yet.
   *  Order in COMMANDS is the visible order; group changes mark a header. */
  group: string;
}

const GRID_MODES: AppMode[] = ["grid", "overlay"];
const PICKER_MODES: AppMode[] = ["site_picker", "table_picker", "page_picker"];

/**
 * The command list. Order is editorial -- the user sees this verbatim
 * when the query is empty, so put the most-asked-for things first.
 */
export const COMMANDS: Command[] = [
  // ── Rows ──
  { name: "add-row",        description: "Add a row at the bottom",
    bindings: "F7  /  ^Enter",
    action: { type: "add_row" }, availableIn: GRID_MODES, group: "Rows" },
  { name: "delete-row",     description: "Delete the focused row",
    bindings: "F8  /  ^Delete",
    action: { type: "delete_row" }, availableIn: GRID_MODES, group: "Rows" },

  // ── Cells ──
  { name: "edit-cell",      description: "Type any character, or press Enter / F2",
    bindings: "<type>  /  Enter  /  F2",
    action: { type: "none" }, availableIn: GRID_MODES, group: "Cells" },
  { name: "view-cell",      description: "Open the focused cell full-screen",
    bindings: "F3",
    action: { type: "view_cell" }, availableIn: GRID_MODES, group: "Cells" },
  { name: "clear-cell",     description: "Set the focused cell to empty",
    bindings: "Delete",
    action: { type: "none" }, availableIn: GRID_MODES, group: "Cells" },
  { name: "toggle-bool",    description: "Flip a Boolean cell (Enter, Space, any key)",
    bindings: "Enter  /  Space",
    action: { type: "none" }, availableIn: GRID_MODES, group: "Cells" },

  // ── History ──
  { name: "undo",           description: "Undo your last change (this session)",
    bindings: "^Z",
    action: { type: "undo" }, availableIn: GRID_MODES, group: "History" },
  { name: "redo",           description: "Redo",
    bindings: "^Y  /  ^Shift+Z",
    action: { type: "redo" }, availableIn: GRID_MODES, group: "History" },
  { name: "refresh",        description: "Reload the current view from the server",
    bindings: "F5  /  ^R",
    action: { type: "refresh" }, availableIn: GRID_MODES, group: "History" },

  // ── Navigation ──
  { name: "tables",         description: "Open the table picker",
    bindings: "F4",
    action: { type: "switch_to_tables" }, availableIn: GRID_MODES, group: "Navigation" },
  { name: "pages",          description: "Open the page picker",
    bindings: "Esc",
    action: { type: "switch_to_pages" }, availableIn: GRID_MODES, group: "Navigation" },
  { name: "site",           description: "Back to the site's doc list",
    bindings: "s  (in pickers)",
    action: { type: "switch_to_site" }, group: "Navigation" },
  { name: "next-pane",      description: "Move focus to the next section",
    bindings: "F6",
    action: { type: "focus_next_pane" }, availableIn: GRID_MODES, group: "Navigation" },
  { name: "prev-pane",      description: "Move focus to the previous section",
    bindings: "Shift-F6",
    action: { type: "focus_prev_pane" }, availableIn: GRID_MODES, group: "Navigation" },

  // ── Movement (info-only) ──
  { name: "move-cursor",    description: "Move the cell cursor",
    bindings: "Arrows  /  Tab",
    action: { type: "none" }, availableIn: GRID_MODES, group: "Movement" },
  { name: "row-edges",      description: "First / last column of the row",
    bindings: "Home  /  End",
    action: { type: "none" }, availableIn: GRID_MODES, group: "Movement" },
  { name: "table-edges",    description: "First / last cell of the table",
    bindings: "^Home  /  ^End",
    action: { type: "none" }, availableIn: GRID_MODES, group: "Movement" },
  { name: "first-record",   description: "Jump to the first record",
    bindings: "^↑",
    action: { type: "none" }, availableIn: GRID_MODES, group: "Movement" },
  { name: "last-record",    description: "Jump to the last record",
    bindings: "^↓",
    action: { type: "none" }, availableIn: GRID_MODES, group: "Movement" },

  // ── Picker conveniences ──
  { name: "swap-pickers",   description: "Switch between tables and pages",
    bindings: "Tab",
    action: { type: "none" }, availableIn: PICKER_MODES, group: "Pickers" },

  // ── Cell viewer ──
  { name: "next-url",       description: "Cycle to the next URL in the cell",
    bindings: "Tab",
    action: { type: "none" }, availableIn: ["cell_viewer"], group: "Cell viewer" },
  { name: "open-url",       description: "Open the selected URL in your browser",
    bindings: "Enter",
    action: { type: "none" }, availableIn: ["cell_viewer"], group: "Cell viewer" },
  { name: "close-cell-viewer", description: "Back to the grid",
    bindings: "Esc  /  F3",
    action: { type: "none" }, availableIn: ["cell_viewer"], group: "Cell viewer" },

  // ── Session ──
  { name: "theme",          description: "Cycle to the next color theme",
    bindings: "T  /  F12",
    action: { type: "cycle_theme" }, group: "Session" },
  { name: "quit",           description: "Quit grist-console",
    bindings: "^C  /  ^Q",
    action: { type: "quit" }, group: "Session" },
];

/** A row in the rendered palette: either a runnable/info command, or a
 *  bold group header that splits clusters when the query is empty. */
export type DisplayRow =
  | { kind: "header"; group: string }
  | { kind: "command"; cmd: Command; filteredIdx: number };

/**
 * Build the list of rows to render. When `query` is empty, group headers
 * are interleaved at every group boundary -- they orient the user but
 * disappear once filtering kicks in (mixing matches with headers reads
 * worse than a flat list). The `filteredIdx` field on command rows lines
 * up with the cursor index in `paletteCursor`.
 */
export function buildDisplayRows(query: string, mode: AppMode): DisplayRow[] {
  const filtered = filterCommands(query, mode);
  if (query.trim().length > 0) {
    return filtered.map((cmd, i) => ({ kind: "command", cmd, filteredIdx: i }));
  }
  const rows: DisplayRow[] = [];
  let prevGroup = "";
  filtered.forEach((cmd, i) => {
    if (cmd.group !== prevGroup) {
      rows.push({ kind: "header", group: cmd.group });
      prevGroup = cmd.group;
    }
    rows.push({ kind: "command", cmd, filteredIdx: i });
  });
  return rows;
}

/**
 * Filter the command list against the user's query. Empty query returns
 * everything that's available in `mode`. A non-empty query does a case-
 * insensitive substring match against name + description so users can
 * type either ("add", "row", "delete") and find the right entry.
 */
export function filterCommands(query: string, mode: AppMode): Command[] {
  const q = query.trim().toLowerCase();
  return COMMANDS.filter(cmd => {
    if (cmd.availableIn && !cmd.availableIn.includes(mode)) { return false; }
    if (!q) { return true; }
    return cmd.name.toLowerCase().includes(q)
        || cmd.description.toLowerCase().includes(q);
  });
}

/**
 * Snap the cursor into the visible range of the filtered list. Caller
 * passes the freshly-filtered list so we don't compute it twice.
 */
export function clampPaletteCursor(state: AppState, filtered: Command[]): void {
  if (filtered.length === 0) { state.paletteCursor = 0; return; }
  if (state.paletteCursor < 0) { state.paletteCursor = 0; }
  if (state.paletteCursor >= filtered.length) {
    state.paletteCursor = filtered.length - 1;
  }
}

