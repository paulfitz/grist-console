import { AppState, isCardPane, PaneState, activeView, editReturnMode } from "./ConsoleAppState.js";
import { displayWidth, extractUrls } from "./ConsoleDisplay.js";
import { collectLeaves, computeColLayout, LayoutNode } from "./ConsoleLayout.js";
import { formatCellValue } from "./ConsoleCellFormat.js";

/**
 * Ensure scrollCol is adjusted so cursorCol is visible.
 * Uses the same column-width computation as the grid renderer.
 */
export function ensureColVisible(pane: PaneState, availWidth: number): void {
  if (pane.cursorCol < pane.scrollCol) {
    pane.scrollCol = pane.cursorCol;
    return;
  }
  const colLayout = computeColLayout(pane);
  const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);
  const sepLen = 3; // " | "

  // Check if cursorCol is visible from current scrollCol
  let used = rowNumWidth;
  for (let c = pane.scrollCol; c <= pane.cursorCol; c++) {
    used += sepLen + (colLayout[c]?.width || 4);
  }
  if (used <= availWidth) { return; }

  // Scroll right until cursorCol fits
  while (pane.scrollCol < pane.cursorCol) {
    pane.scrollCol++;
    used = rowNumWidth;
    for (let c = pane.scrollCol; c <= pane.cursorCol; c++) {
      used += sepLen + (colLayout[c]?.width || 4);
    }
    if (used <= availWidth) { return; }
  }
  // Last resort: cursor is the first visible column
  pane.scrollCol = pane.cursorCol;
}

function getLeafForPane(state: AppState, paneIndex: number): LayoutNode | undefined {
  if (!state.layout) { return undefined; }
  return collectLeaves(state.layout).find(l => l.paneIndex === paneIndex);
}

/**
 * For a linked card pane, find the pane whose cursorRow should be moved
 * when navigating records. Walks up the link chain to find the source.
 * For unlinked card panes, returns the pane itself.
 */
function findCardRecordTarget(state: AppState, pane: PaneState): PaneState {
  const srcRef = pane.sectionInfo?.linkSrcSectionRef;
  if (!srcRef) { return pane; }
  const srcPane = state.panes.find(p => p.sectionInfo?.sectionId === srcRef);
  if (!srcPane) { return pane; }
  // If the source is also a card pane, recurse up the chain
  if (isCardPane(srcPane)) {
    return findCardRecordTarget(state, srcPane);
  }
  return srcPane;
}

export type InputAction =
  | { type: "none" }
  | { type: "quit" }
  | { type: "render" }
  | { type: "select_table" }
  | { type: "select_page" }
  | { type: "refresh" }
  | { type: "save_edit" }
  | { type: "add_row" }
  | { type: "delete_row" }
  | { type: "switch_to_tables" }
  | { type: "switch_to_pages" }
  | { type: "focus_next_pane" }
  | { type: "focus_prev_pane" }
  | { type: "cycle_theme" }
  | { type: "close_overlay" }
  | { type: "view_cell" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "paste"; content: string }
  | { type: "open_url"; url: string };

/**
 * Insert pasted text at the edit cursor. Shared by direct paste (in
 * editing mode) and "start-editing-with-paste" (in grid mode, where
 * the pasted content replaces the cell's prior value).
 */
export function applyPasteToEdit(state: AppState, content: string): void {
  const before = state.editValue.slice(0, state.editCursorPos);
  const after = state.editValue.slice(state.editCursorPos);
  state.editValue = before + content + after;
  state.editCursorPos = before.length + content.length;
}

/**
 * Map a CSI/SS3 modifier digit to a prefix string. xterm uses 1+(shift|alt|ctrl)
 * with shift=1, alt=2, ctrl=4: `2`=shift, `3`=alt, `5`=ctrl, `6`=ctrl-shift, etc.
 */
function modifierPrefix(mod: number): string {
  switch (mod) {
    case 2: return "shift-";
    case 3: return "alt-";
    case 4: return "shift-alt-";
    case 5: return "ctrl-";
    case 6: return "ctrl-shift-";
    case 7: return "ctrl-alt-";
    case 8: return "ctrl-shift-alt-";
    default: return "";
  }
}

/**
 * Map a tilde-style CSI code (the N in `ESC [ N ~`) to a key name.
 */
function tildeCodeToKey(code: number): string {
  switch (code) {
    case 1:  return "home";       // some terminals
    case 2:  return "insert";
    case 3:  return "delete";
    case 4:  return "end";
    case 5:  return "pageup";
    case 6:  return "pagedown";
    case 15: return "f5";
    case 17: return "f6";
    case 18: return "f7";
    case 19: return "f8";
    case 20: return "f9";
    case 21: return "f10";
    case 23: return "f11";
    case 24: return "f12";
    default: return "";
  }
}

/**
 * Parse a raw keypress buffer into a key name. Returns one of:
 *  - a single printable codepoint (e.g. "a", "5", " "),
 *  - a multi-byte UTF-8 sequence as its decoded string,
 *  - a named key: "up" "down" "left" "right" "home" "end" "pageup" "pagedown"
 *    "delete" "insert" "tab" "shift-tab" "enter" "backspace" "escape"
 *    "f1".."f12",
 *  - a modifier-prefixed name: "ctrl-<x>", "alt-<x>", "shift-<x>",
 *    "ctrl-shift-<x>" etc. for arrows, F-keys, home/end, and ASCII letters.
 *  - "unknown" if the sequence isn't recognised.
 *
 * Modifier-prefixed Ctrl/Alt/Shift+arrow and F-key sequences require either
 * xterm's modifyOtherKeys or kitty's CSI-u protocol on the terminal side;
 * this function decodes them when present but doesn't enable them.
 */
function parseKey(buf: Buffer): string {
  if (buf[0] === 0x1b) {
    if (buf.length === 1) { return "escape"; }

    // CSI sequences: ESC [ ...
    if (buf[1] === 0x5b) {
      // Shift-Tab: ESC [ Z
      if (buf[2] === 0x5a) { return "shift-tab"; }

      // Modifier-prefixed cursor / F1-F4 keys: ESC [ 1 ; M <letter>
      if (buf[2] === 0x31 && buf[3] === 0x3b && buf.length >= 6) {
        const prefix = modifierPrefix(buf[4] - 0x30);
        if (prefix) {
          switch (buf[5]) {
            case 0x41: return prefix + "up";
            case 0x42: return prefix + "down";
            case 0x43: return prefix + "right";
            case 0x44: return prefix + "left";
            case 0x48: return prefix + "home";
            case 0x46: return prefix + "end";
            case 0x50: return prefix + "f1";
            case 0x51: return prefix + "f2";
            case 0x52: return prefix + "f3";
            case 0x53: return prefix + "f4";
          }
        }
      }

      // Tilde-form keys (with optional modifier): ESC [ N ~  or  ESC [ N ; M ~
      // Covers PgUp/PgDn/Delete/Insert/Home/End and F5-F12.
      if (buf[2] >= 0x30 && buf[2] <= 0x39) {
        let i = 2;
        while (i < buf.length && buf[i] !== 0x7e) { i++; }
        if (i < buf.length && i > 2) {
          const inner = buf.slice(2, i).toString("ascii");
          const parts = inner.split(";");
          const code = parseInt(parts[0], 10);
          const key = tildeCodeToKey(code);
          if (key) {
            const mod = parts[1] ? parseInt(parts[1], 10) : 1;
            return modifierPrefix(mod) + key;
          }
        }
      }

      // Plain CSI single-letter cursor keys: ESC [ <letter>
      switch (buf[2]) {
        case 0x41: return "up";
        case 0x42: return "down";
        case 0x43: return "right";
        case 0x44: return "left";
        case 0x48: return "home";
        case 0x46: return "end";
      }
      return "unknown";
    }

    // SS3 sequences: ESC O ...  -- F1-F4 commonly arrive this way.
    if (buf[1] === 0x4f) {
      switch (buf[2]) {
        case 0x50: return "f1";
        case 0x51: return "f2";
        case 0x52: return "f3";
        case 0x53: return "f4";
      }
      return "unknown";
    }

    // ESC + printable = Alt+<char>. Distinguishes from the ESC-followed-by-CSI
    // forms above by buffer length: those start with ESC [ or ESC O.
    if (buf.length === 2 && buf[1] >= 0x20 && buf[1] < 0x7f) {
      return "alt-" + String.fromCharCode(buf[1]);
    }

    return "unknown";
  }

  if (buf[0] === 0x03) { return "ctrl-c"; }
  if (buf[0] === 0x0d) { return "enter"; }
  if (buf[0] === 0x7f) { return "backspace"; }
  if (buf[0] === 0x08) { return "backspace"; }   // Ctrl-H is also backspace
  if (buf[0] === 0x09) { return "tab"; }

  // Other Ctrl+letter values. Skip ones already handled (Tab, Enter, Esc,
  // Backspace, Ctrl-C). 0x01-0x1a map to ctrl-a..ctrl-z.
  if (buf.length === 1 && buf[0] >= 0x01 && buf[0] <= 0x1a) {
    return "ctrl-" + String.fromCharCode(buf[0] + 0x60);
  }

  if (buf.length === 1 && buf[0] >= 0x20 && buf[0] < 0x7f) {
    return String.fromCharCode(buf[0]);
  }
  // Multi-byte UTF-8 character
  if (buf[0] > 0x7f) {
    return buf.toString("utf8");
  }
  return "unknown";
}

/**
 * Is this key name a printable single character (or a multi-byte UTF-8
 * codepoint) that should be inserted into the focused cell when the user
 * is on a grid? True for letters, digits, punctuation, accented chars.
 * False for named keys ("up", "f5"), modifier-prefixed keys, "escape" etc.
 */
function isPrintableKey(key: string): boolean {
  if (key.length === 1) {
    const c = key.charCodeAt(0);
    return c >= 0x20 && c < 0x7f;
  }
  // Multi-byte UTF-8: first codepoint is non-ASCII printable.
  return key.length > 1 && key.charCodeAt(0) > 0x7f;
}

/**
 * Handle a keypress in table picker mode.
 */
/**
 * Move a list cursor (selectedTableIndex / selectedPageIndex) in response to
 * a navigation key. Returns the new cursor and whether the key was a
 * navigation key (so the caller knows whether to fall through).
 */
function navigateList(
  key: string, cursor: number, max: number, pageSize: number
): { cursor: number; handled: boolean } {
  if (max <= 0) { return { cursor, handled: false }; }
  switch (key) {
    case "up":       return { cursor: Math.max(0, cursor - 1), handled: true };
    case "down":     return { cursor: Math.min(max - 1, cursor + 1), handled: true };
    case "pageup":   return { cursor: Math.max(0, cursor - pageSize), handled: true };
    case "pagedown": return { cursor: Math.min(max - 1, cursor + pageSize), handled: true };
    case "home":     return { cursor: 0, handled: true };
    case "end":      return { cursor: max - 1, handled: true };
    default:         return { cursor, handled: false };
  }
}

function handleTablePickerKey(key: string, state: AppState): InputAction {
  const pageSize = Math.max(1, (process.stdout.rows || 24) - 5);
  const nav = navigateList(key, state.selectedTableIndex, state.tableIds.length, pageSize);
  if (nav.handled) {
    state.selectedTableIndex = nav.cursor;
    return { type: "render" };
  }
  switch (key) {
    case "enter":
      return { type: "select_table" };
    case "tab":
    case "p":
    case "escape":
      if (state.pages.length > 0) {
        return { type: "switch_to_pages" };
      }
      return { type: "none" };
    case "T":
    case "f12":
      return { type: "cycle_theme" };
    case "q":
    case "ctrl-q":
    case "ctrl-c":
      return { type: "quit" };
    default:
      return { type: "none" };
  }
}

/**
 * Handle a keypress in edit mode.
 */
function handleEditKey(key: string, state: AppState): InputAction {
  switch (key) {
    case "escape":
      state.mode = editReturnMode(state);
      state.statusMessage = "";
      return { type: "render" };
    case "enter":
      return { type: "save_edit" };
    case "backspace":
      if (state.editCursorPos > 0) {
        state.editValue =
          state.editValue.slice(0, state.editCursorPos - 1) +
          state.editValue.slice(state.editCursorPos);
        state.editCursorPos--;
      }
      return { type: "render" };
    case "delete":
      if (state.editCursorPos < state.editValue.length) {
        state.editValue =
          state.editValue.slice(0, state.editCursorPos) +
          state.editValue.slice(state.editCursorPos + 1);
      }
      return { type: "render" };
    case "left":
      if (state.editCursorPos > 0) {
        state.editCursorPos--;
      }
      return { type: "render" };
    case "right":
      if (state.editCursorPos < state.editValue.length) {
        state.editCursorPos++;
      }
      return { type: "render" };
    case "home":
      state.editCursorPos = 0;
      return { type: "render" };
    case "end":
      state.editCursorPos = state.editValue.length;
      return { type: "render" };
    default:
      // Insert character at cursor position
      if (key.length === 1 || key.charCodeAt(0) > 127) {
        state.editValue =
          state.editValue.slice(0, state.editCursorPos) +
          key +
          state.editValue.slice(state.editCursorPos);
        state.editCursorPos += key.length;
        return { type: "render" };
      }
      return { type: "none" };
  }
}

/**
 * Handle a keypress in confirm_delete mode.
 */
function handleConfirmDeleteKey(key: string, state: AppState): InputAction {
  const returnMode = state.overlayPaneIndex !== null ? "overlay" as const : "grid" as const;
  switch (key) {
    case "y":
      state.mode = returnMode;
      return { type: "delete_row" };
    case "n":
    case "escape":
      state.mode = returnMode;
      state.statusMessage = "";
      return { type: "render" };
    default:
      return { type: "none" };
  }
}

/**
 * Handle a keypress in page picker mode.
 */
function handlePagePickerKey(key: string, state: AppState): InputAction {
  const pageSize = Math.max(1, (process.stdout.rows || 24) - 5);
  const nav = navigateList(key, state.selectedPageIndex, state.pages.length, pageSize);
  if (nav.handled) {
    state.selectedPageIndex = nav.cursor;
    return { type: "render" };
  }
  switch (key) {
    case "enter":
      return { type: "select_page" };
    case "tab":
    case "t":
    case "f4":
      return { type: "switch_to_tables" };
    case "T":
    case "f12":
      return { type: "cycle_theme" };
    case "q":
    case "ctrl-q":
    case "ctrl-c":
      return { type: "quit" };
    default:
      return { type: "none" };
  }
}

/**
 * Movement + edit triggers shared by the multi-pane grid and the overlay
 * view. Returns an InputAction, or "none" if the key wasn't recognised in
 * this context.
 *
 * Keymap principle: in grid mode the user is "on" a cell, so any printable
 * character starts editing that cell with the typed character as the new
 * value (Excel/Grist parity). All commands therefore live on Ctrl-, Alt-,
 * or function keys; bare letters never trigger commands here.
 */
function handleGridViewKey(
  key: string, state: AppState, pane: PaneState, availWidth: number,
): InputAction {
  const termRows = process.stdout.rows || 24;
  const dataRows = Math.max(1, termRows - 5);
  const pageSize = dataRows;
  const hasCells = pane.rowIds.length > 0 && pane.columns.length > 0;

  // Cell editing triggers.
  switch (key) {
    case "enter":
    case "f2":
      if (hasCells) { enterPaneEditMode(state, pane); }
      return { type: "render" };
    case "backspace":
      // Start editing with an empty value (Grist parity).
      if (hasCells) {
        enterPaneEditMode(state, pane);
        state.editValue = "";
        state.editCursorPos = 0;
      }
      return { type: "render" };
    case "delete":
      // Clear the cell immediately, no edit prompt.
      if (hasCells) {
        enterPaneEditMode(state, pane);
        state.editValue = "";
        state.editCursorPos = 0;
        return { type: "save_edit" };
      }
      return { type: "render" };
  }

  // Movement.
  switch (key) {
    case "up":
      if (pane.cursorRow > 0) {
        pane.cursorRow--;
        if (pane.cursorRow < pane.scrollRow) { pane.scrollRow = pane.cursorRow; }
      }
      return { type: "render" };
    case "down":
      if (pane.cursorRow < pane.rowIds.length - 1) {
        pane.cursorRow++;
        if (pane.cursorRow >= pane.scrollRow + dataRows) {
          pane.scrollRow = pane.cursorRow - dataRows + 1;
        }
      }
      return { type: "render" };
    case "left":
    case "shift-tab":
      if (pane.cursorCol > 0) {
        pane.cursorCol--;
        ensureColVisible(pane, availWidth);
      }
      return { type: "render" };
    case "right":
    case "tab":
      // Tab advances to the next cell in the row (Grist parity). The
      // pane-switching role Tab used to play has moved to F6.
      if (pane.cursorCol < pane.columns.length - 1) {
        pane.cursorCol++;
        ensureColVisible(pane, availWidth);
      }
      return { type: "render" };
    case "pageup":
      pane.cursorRow = Math.max(0, pane.cursorRow - pageSize);
      pane.scrollRow = Math.max(0, pane.scrollRow - pageSize);
      return { type: "render" };
    case "pagedown":
      pane.cursorRow = Math.min(pane.rowIds.length - 1, pane.cursorRow + pageSize);
      pane.scrollRow = Math.min(
        Math.max(0, pane.rowIds.length - pageSize),
        pane.scrollRow + pageSize
      );
      return { type: "render" };
    case "home":
      // First column of current row (Excel parity).
      pane.cursorCol = 0;
      pane.scrollCol = 0;
      return { type: "render" };
    case "end":
      // Last column of current row.
      if (pane.columns.length > 0) {
        pane.cursorCol = pane.columns.length - 1;
        ensureColVisible(pane, availWidth);
      }
      return { type: "render" };
    case "ctrl-home":
      pane.cursorRow = 0;
      pane.scrollRow = 0;
      pane.cursorCol = 0;
      pane.scrollCol = 0;
      return { type: "render" };
    case "ctrl-end":
      pane.cursorRow = Math.max(0, pane.rowIds.length - 1);
      pane.scrollRow = Math.max(0, pane.rowIds.length - pageSize);
      if (pane.columns.length > 0) {
        pane.cursorCol = pane.columns.length - 1;
        ensureColVisible(pane, availWidth);
      }
      return { type: "render" };
    case "ctrl-up":
      // First record (Grist parity).
      pane.cursorRow = 0;
      pane.scrollRow = 0;
      return { type: "render" };
    case "ctrl-down":
      pane.cursorRow = Math.max(0, pane.rowIds.length - 1);
      pane.scrollRow = Math.max(0, pane.rowIds.length - pageSize);
      return { type: "render" };
    case "ctrl-left":
      pane.cursorCol = 0;
      pane.scrollCol = 0;
      return { type: "render" };
    case "ctrl-right":
      if (pane.columns.length > 0) {
        pane.cursorCol = pane.columns.length - 1;
        ensureColVisible(pane, availWidth);
      }
      return { type: "render" };
  }

  // Row operations. The Ctrl-Enter / Ctrl-Delete bindings need a terminal
  // that supports modifyOtherKeys or the kitty keyboard protocol; F7 / F8
  // are the universal fallbacks.
  switch (key) {
    case "ctrl-enter":
    case "f7":
      return { type: "add_row" };
    case "ctrl-delete":
    case "ctrl-backspace":
    case "f8":
      if (pane.rowIds.length > 0) { state.mode = "confirm_delete"; }
      return { type: "render" };
  }

  // Top-level commands.
  switch (key) {
    case "f3":
      return { type: "view_cell" };
    case "ctrl-z":
      return { type: "undo" };
    case "ctrl-y":
    case "ctrl-shift-z":
      return { type: "redo" };
    case "ctrl-r":
    case "f5":
      return { type: "refresh" };
    case "f4":
      return { type: "switch_to_tables" };
    case "f12":
      return { type: "cycle_theme" };
    case "escape":
      return { type: "switch_to_pages" };
    case "ctrl-q":
    case "ctrl-c":
      return { type: "quit" };
  }

  // Anything printable starts editing the focused cell with that
  // character as the initial value. This is the core "spreadsheet feel"
  // change: pressing `a` no longer adds a row, it puts `a` in the cell.
  if (isPrintableKey(key) && hasCells) {
    enterPaneEditMode(state, pane);
    state.editValue = key;
    state.editCursorPos = key.length;
    return { type: "render" };
  }

  return { type: "none" };
}

function handleMultiPaneGridKey(key: string, state: AppState): InputAction {
  const pane = state.panes[state.focusedPane];
  if (!pane) { return { type: "none" }; }

  const leaf = getLeafForPane(state, state.focusedPane);
  if (isCardPane(pane)) {
    return handleCardPaneKey(key, state, pane, leaf);
  }

  // Pane switching: F6 / Shift-F6. Tab/Shift-Tab now advance the cell
  // cursor instead, matching how Tab behaves in a real spreadsheet.
  switch (key) {
    case "f6":
      return { type: "focus_next_pane" };
    case "shift-f6":
      return { type: "focus_prev_pane" };
  }

  // Alt+1..9: open a collapsed widget full-screen. Was 1..9, but plain
  // digits now go into the focused cell.
  const altDigit = /^alt-([1-9])$/.exec(key);
  if (altDigit && state.collapsedPaneIndices.length > 0) {
    const idx = parseInt(altDigit[1], 10) - 1;
    if (idx < state.collapsedPaneIndices.length) {
      state.overlayPaneIndex = state.collapsedPaneIndices[idx];
      state.mode = "overlay";
      return { type: "render" };
    }
  }

  const availWidth = leaf?.width || (process.stdout.columns || 80);
  return handleGridViewKey(key, state, pane, availWidth);
}

/**
 * Handle keys for a card (single/detail) pane.
 *
 * Layout: each row of the card is one field (label + value). Up/Down moves
 * between fields; Tab/Shift-Tab is a form-style alias for the same. Records
 * advance with Ctrl+Up/Ctrl+Down (mirroring grid mode), and Left/Right are
 * kept as a convenience.
 */
function handleCardPaneKey(
  key: string, state: AppState, pane: PaneState, leaf?: LayoutNode
): InputAction {
  const hasCells = pane.rowIds.length > 0 && pane.columns.length > 0;
  const fieldRows = leaf ? leaf.height - 1 : 10;

  // Cell editing triggers.
  switch (key) {
    case "enter":
    case "f2":
      if (hasCells) { enterPaneEditMode(state, pane); }
      return { type: "render" };
    case "backspace":
      if (hasCells) {
        enterPaneEditMode(state, pane);
        state.editValue = "";
        state.editCursorPos = 0;
      }
      return { type: "render" };
    case "delete":
      if (hasCells) {
        enterPaneEditMode(state, pane);
        state.editValue = "";
        state.editCursorPos = 0;
        return { type: "save_edit" };
      }
      return { type: "render" };
  }

  // Field navigation (within the current record).
  switch (key) {
    case "up":
    case "shift-tab":
      if (pane.cursorCol > 0) {
        pane.cursorCol--;
        if (pane.cursorCol < pane.scrollCol) { pane.scrollCol = pane.cursorCol; }
      }
      return { type: "render" };
    case "down":
    case "tab":
      if (pane.cursorCol < pane.columns.length - 1) {
        pane.cursorCol++;
        if (pane.cursorCol >= pane.scrollCol + fieldRows) {
          pane.scrollCol = pane.cursorCol - fieldRows + 1;
        }
      }
      return { type: "render" };
    case "home":
      pane.cursorCol = 0;
      pane.scrollCol = 0;
      return { type: "render" };
    case "end":
      pane.cursorCol = Math.max(0, pane.columns.length - 1);
      return { type: "render" };
  }

  // Record navigation. If this card pane is linked, move the source
  // pane's cursor instead so the link relation drives the change.
  switch (key) {
    case "left":
    case "ctrl-up":
    case "pageup": {
      const target = findCardRecordTarget(state, pane);
      if (target.cursorRow > 0) { target.cursorRow--; }
      return { type: "render" };
    }
    case "right":
    case "ctrl-down":
    case "pagedown": {
      const target = findCardRecordTarget(state, pane);
      if (target.cursorRow < target.rowIds.length - 1) { target.cursorRow++; }
      return { type: "render" };
    }
    case "ctrl-home": {
      const target = findCardRecordTarget(state, pane);
      target.cursorRow = 0;
      return { type: "render" };
    }
    case "ctrl-end": {
      const target = findCardRecordTarget(state, pane);
      target.cursorRow = Math.max(0, target.rowIds.length - 1);
      return { type: "render" };
    }
  }

  // Pane switching: F6 / Shift-F6 (Tab is now field-nav above).
  switch (key) {
    case "f6":
      return { type: "focus_next_pane" };
    case "shift-f6":
      return { type: "focus_prev_pane" };
  }

  // Row ops + top-level commands. Same bindings as grid mode.
  switch (key) {
    case "ctrl-enter":
    case "f7":
      return { type: "add_row" };
    case "ctrl-delete":
    case "ctrl-backspace":
    case "f8":
      if (pane.rowIds.length > 0) { state.mode = "confirm_delete"; }
      return { type: "render" };
    case "f3":
      return { type: "view_cell" };
    case "ctrl-z":
      return { type: "undo" };
    case "ctrl-y":
    case "ctrl-shift-z":
      return { type: "redo" };
    case "ctrl-r":
    case "f5":
      return { type: "refresh" };
    case "f4":
      return { type: "switch_to_tables" };
    case "f12":
      return { type: "cycle_theme" };
    case "escape":
      return { type: "switch_to_pages" };
    case "ctrl-q":
    case "ctrl-c":
      return { type: "quit" };
  }

  // Printable char → start editing the focused field with that char.
  if (isPrintableKey(key) && hasCells) {
    enterPaneEditMode(state, pane);
    state.editValue = key;
    state.editCursorPos = key.length;
    return { type: "render" };
  }

  return { type: "none" };
}

function enterPaneEditMode(state: AppState, pane: PaneState): void {
  if (!pane) { return; }
  const col = pane.columns[pane.cursorCol];
  const values = pane.colValues[col.colId];
  const currentValue = values ? values[pane.cursorRow] : null;
  state.editValue = formatCellValue(currentValue, col.type, col.widgetOptions, col.displayValues);
  state.editCursorPos = state.editValue.length;
  state.mode = "editing";
}

/**
 * Handle keys in cell viewer mode (scrollable full cell content).
 */
function handleCellViewerKey(key: string, state: AppState): InputAction {
  const termRows = process.stdout.rows || 24;
  const dataRows = termRows - 3;
  // Count wrapped lines to know max scroll
  const wrapWidth = (process.stdout.columns || 80) - 2;
  let totalLines = 0;
  for (const rawLine of state.cellViewerContent.split("\n")) {
    const w = displayWidth(rawLine);
    totalLines += w <= wrapWidth ? 1 : Math.ceil(w / wrapWidth);
  }
  const maxScroll = Math.max(0, totalLines - dataRows);

  switch (key) {
    case "escape":
    case "f3":
      // Close the viewer, return to whatever was underneath.
      state.mode = state.overlayPaneIndex !== null ? "overlay" : "grid";
      state.cellViewerContent = "";
      state.cellViewerScroll = 0;
      state.cellViewerLinkIndex = -1;
      return { type: "render" };
    case "up":
      if (state.cellViewerScroll > 0) { state.cellViewerScroll--; }
      return { type: "render" };
    case "down":
      if (state.cellViewerScroll < maxScroll) { state.cellViewerScroll++; }
      return { type: "render" };
    case "pageup":
      state.cellViewerScroll = Math.max(0, state.cellViewerScroll - dataRows);
      return { type: "render" };
    case "pagedown":
      state.cellViewerScroll = Math.min(maxScroll, state.cellViewerScroll + dataRows);
      return { type: "render" };
    case "home":
      state.cellViewerScroll = 0;
      return { type: "render" };
    case "end":
      state.cellViewerScroll = maxScroll;
      return { type: "render" };
    case "enter": {
      // If a link is selected, open it; otherwise switch to editing
      if (state.cellViewerLinkIndex >= 0) {
        const urls = extractUrls(state.cellViewerContent);
        if (state.cellViewerLinkIndex < urls.length) {
          return { type: "open_url", url: urls[state.cellViewerLinkIndex] };
        }
      }
      // Enter edit mode -- keep cellViewerContent so we stay in the viewer
      state.cellViewerLinkIndex = -1;
      const pane = activeView(state);
      if (pane && pane.rowIds.length > 0 && pane.columns.length > 0) {
        enterPaneEditMode(state, pane);
      }
      return { type: "render" };
    }
    case "tab": {
      // Cycle forward through URLs found in cell content.
      const urls = extractUrls(state.cellViewerContent);
      if (urls.length === 0) { return { type: "none" }; }
      state.cellViewerLinkIndex = (state.cellViewerLinkIndex + 1) % urls.length;
      return { type: "render" };
    }
    case "shift-tab": {
      // Shift-Tab from no selection wraps to the last link (so a user
      // who wants the last URL doesn't have to Tab through every one).
      const urls = extractUrls(state.cellViewerContent);
      if (urls.length === 0) { return { type: "none" }; }
      state.cellViewerLinkIndex = state.cellViewerLinkIndex < 0
        ? urls.length - 1
        : (state.cellViewerLinkIndex - 1 + urls.length) % urls.length;
      return { type: "render" };
    }
    case "ctrl-c":
    case "ctrl-q":
      return { type: "quit" };
    default:
      return { type: "none" };
  }
}

/**
 * Handle keys in overlay mode (full-screen view of a collapsed widget).
 */
function handleOverlayKey(key: string, state: AppState): InputAction {
  if (state.overlayPaneIndex === null) {
    state.mode = "grid";
    return { type: "render" };
  }
  const pane = state.panes[state.overlayPaneIndex];
  if (!pane) {
    state.mode = "grid";
    state.overlayPaneIndex = null;
    return { type: "render" };
  }

  if (key === "escape") { return { type: "close_overlay" }; }

  if (isCardPane(pane)) {
    // Overlay fills the screen, so the leaf is the full terminal.
    const overlayLeaf: LayoutNode = {
      top: 0, left: 0,
      width: process.stdout.columns || 80,
      height: (process.stdout.rows || 24) - 2,
      paneIndex: state.overlayPaneIndex,
    };
    return handleCardPaneKey(key, state, pane, overlayLeaf);
  }

  return handleGridViewKey(key, state, pane, process.stdout.columns || 80);
}

/**
 * Process a raw keypress buffer and return the action to take.
 */
export function handleKeypress(buf: Buffer, state: AppState): InputAction {
  const key = parseKey(buf);
  switch (state.mode) {
    case "table_picker":
      return handleTablePickerKey(key, state);
    case "page_picker":
      return handlePagePickerKey(key, state);
    case "grid":
      return handleMultiPaneGridKey(key, state);
    case "editing":
      return handleEditKey(key, state);
    case "confirm_delete":
      return handleConfirmDeleteKey(key, state);
    case "overlay":
      return handleOverlayKey(key, state);
    case "cell_viewer":
      return handleCellViewerKey(key, state);
    default:
      return { type: "none" };
  }
}

/**
 * Execute a save_edit action: send the edit to the server.
 */
