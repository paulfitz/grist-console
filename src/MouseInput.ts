/**
 * Mouse input parsing and dispatch.
 *
 * Terminals report mouse events as escape sequences once the program has
 * asked for it (see ENABLE_MOUSE in ConsoleDisplay). We use SGR encoding
 * (?1006) so coordinates above column 223 work and press / release are
 * unambiguous: press/wheel arrives as `ESC [ < B ; X ; Y M`, release as
 * the same with a trailing `m`. X and Y are 1-based columns and rows.
 *
 * Button codes (after stripping modifier bits 4=shift, 8=alt, 16=ctrl
 * and the 32=motion bit we ignore):
 *   0=left, 1=middle, 2=right, 64=wheel-up, 65=wheel-down.
 *
 * Holding Shift (Linux/Windows) or Option (macOS) bypasses mouse
 * reporting entirely in most terminals, so the user can still drag to
 * select text -- no extra work on our side.
 */

import { AppState, HelpHit, PaneState, isCardPane, activeView, paneTitle } from "./ConsoleAppState.js";
import { collectLeaves, computeColLayout, LayoutNode } from "./ConsoleLayout.js";
import { displayWidth } from "./ConsoleDisplay.js";
import { buildDisplayRows, computePaletteScroll, filterCommands } from "./CommandPalette.js";
import { ensureColVisible } from "./ConsoleInput.js";
import type { InputAction } from "./ConsoleInput.js";

/**
 * One entry in the bottom help bar. Entries with an `action` are
 * clickable; entries without are pure reminders (e.g. "type:edit",
 * "↑↓:select"). Empty `label`s are skipped, which lets callers build
 * conditional bars without conditional concatenation:
 *
 *   formatHelpBar(state, t, footerRow, [
 *     { label: "↑↓:select" },
 *     { label: "Enter:open", action: { type: "select_table" } },
 *     { label: pages.length ? "Tab:pages" : "",
 *       action: { type: "switch_to_pages" } },
 *     ...
 *   ])
 */
export interface HelpEntry {
  label: string;
  action?: InputAction;
}

/**
 * Style help-bar entries into a single line AND register their screen-x
 * ranges so a click at row `footerRow` can dispatch the matching action.
 * Entries with no `action` show as plain text; empty `label`s are
 * skipped, which lets callers do conditional bars without conditional
 * concatenation. Two-space separator matches the visual style the rest
 * of the renderer expects.
 */
export function formatHelpBar(
  state: AppState, t: { helpBar(s: string): string },
  footerRow: number, entries: HelpEntry[],
): string {
  state.helpHits = [];
  state.helpHitRow = footerRow;
  let result = "";
  let cursor = 0;
  let first = true;
  for (const entry of entries) {
    if (!entry.label) { continue; }
    if (!first) {
      result += "  ";
      cursor += 2;
    }
    first = false;
    const w = displayWidth(entry.label);
    if (entry.action) {
      state.helpHits.push({ x: cursor, width: w, action: entry.action });
    }
    result += entry.label;
    cursor += w;
  }
  return t.helpBar(result);
}

export function clearHelpHits(state: AppState): void {
  state.helpHits = [];
  state.helpHitRow = -1;
}

/** Look up the action under a click, or null if the click missed. */
function helpHitAt(state: AppState, x: number, y: number): InputAction | null {
  if (y !== state.helpHitRow) { return null; }
  for (const h of state.helpHits as HelpHit[]) {
    if (x >= h.x && x < h.x + h.width) { return h.action as InputAction; }
  }
  return null;
}

export interface MouseEvent {
  /** 0=left, 1=middle, 2=right, 64=wheel-up, 65=wheel-down */
  button: number;
  /** 1-based column (terminal cell) */
  x: number;
  /** 1-based row (terminal cell) */
  y: number;
  /** True for press / wheel; false for release. */
  press: boolean;
  shift: boolean;
  alt: boolean;
  ctrl: boolean;
}

/**
 * Try to parse an SGR mouse sequence from the start of `buf`. Returns the
 * decoded event plus the number of bytes consumed, or null if `buf`
 * doesn't start with one. Caller can keep parsing the rest of the buffer
 * if multiple events arrived together (common with fast wheel scrolling).
 */
export function parseMouseEvent(
  buf: Buffer
): { event: MouseEvent; consumed: number } | null {
  // SGR mouse: ESC [ < B ; X ; Y M-or-m
  if (buf.length < 6) { return null; }
  if (buf[0] !== 0x1b || buf[1] !== 0x5b || buf[2] !== 0x3c) { return null; }

  // Find terminating M or m.
  let end = -1;
  for (let i = 3; i < buf.length; i++) {
    if (buf[i] === 0x4d || buf[i] === 0x6d) { end = i; break; }
  }
  if (end < 0) { return null; }

  const inner = buf.slice(3, end).toString("ascii");
  const parts = inner.split(";");
  if (parts.length !== 3) { return null; }
  const raw = parseInt(parts[0], 10);
  const x = parseInt(parts[1], 10);
  const y = parseInt(parts[2], 10);
  if (!Number.isFinite(raw) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return null;
  }

  const press = buf[end] === 0x4d;
  // Strip modifier and motion bits to get the button.
  const shift = (raw & 4) !== 0;
  const alt   = (raw & 8) !== 0;
  const ctrl  = (raw & 16) !== 0;
  // Motion bit (32): we don't act on drag, so ignore by masking it out.
  const button = raw & ~(4 | 8 | 16 | 32);

  return {
    event: { button, x, y, press, shift, alt, ctrl },
    consumed: end + 1,
  };
}

/**
 * Walk the layout tree to find the leaf (and its pane) that contains
 * the given terminal cell. Returns null if the cell is outside any pane
 * (e.g. in the title bar or footer of a multi-pane page).
 */
function findLeafAt(
  state: AppState, x: number, y: number, trayHeight: number
): { leaf: LayoutNode; paneIndex: number } | null {
  if (!state.layout) { return null; }
  // Layout coords are 0-based and don't include the tray; translate.
  const lx = x - 1;
  const ly = y - 1 - trayHeight;
  const leaves = collectLeaves(state.layout);
  for (const leaf of leaves) {
    if (leaf.paneIndex === undefined) { continue; }
    if (lx >= leaf.left && lx < leaf.left + leaf.width
        && ly >= leaf.top && ly < leaf.top + leaf.height) {
      return { leaf, paneIndex: leaf.paneIndex };
    }
  }
  return null;
}

/**
 * Map a click within a grid pane's leaf to a (row, col) cell, or null
 * if the click landed in the title bar / column header / past the data.
 *
 * Mirrors the row-number / separator / data-row offsets from
 * renderPaneInto in ConsoleMultiPane.ts. Callers must keep these in
 * sync with the renderer.
 */
function gridCellAtPaneCoord(
  pane: PaneState, leafWidth: number, paneRow: number, paneCol: number,
  hasHeaderSep: boolean, sepWidth: number,
): { row: number; col: number } | null {
  const headerRows = hasHeaderSep ? 3 : 2; // title, header, [sep]
  if (paneRow < headerRows) { return null; }
  const dataRow = paneRow - headerRows;
  const rowIdx = pane.scrollRow + dataRow;
  if (rowIdx >= pane.rowIds.length) { return null; }

  const colLayout = computeColLayout(pane);
  const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);
  if (paneCol < rowNumWidth) { return { row: rowIdx, col: 0 }; }

  let cursor = rowNumWidth;
  for (let c = pane.scrollCol; c < pane.columns.length; c++) {
    cursor += sepWidth;
    const w = colLayout[c]?.width ?? 4;
    if (paneCol < cursor + w) { return { row: rowIdx, col: c }; }
    cursor += w;
    if (cursor >= leafWidth) { break; }
  }
  return { row: rowIdx, col: Math.max(0, pane.columns.length - 1) };
}

/**
 * Map a click within a card pane to a field. Each row of a card pane
 * shows one field (label + value), starting after the title bar.
 */
function cardFieldAtPaneCoord(
  pane: PaneState, paneRow: number,
): { col: number } | null {
  if (paneRow < 1) { return null; } // row 0 is the title bar
  const fieldIdx = pane.scrollCol + (paneRow - 1);
  if (fieldIdx < 0 || fieldIdx >= pane.columns.length) { return null; }
  return { col: fieldIdx };
}

/**
 * Reset scrollRow if cursor moved off-screen. Used by wheel scrolling
 * so the cursor follows when the visible window scrolls past it.
 */
function clampPaneScroll(pane: PaneState, dataRows: number): void {
  if (pane.scrollRow < 0) { pane.scrollRow = 0; }
  const maxScroll = Math.max(0, pane.rowIds.length - 1);
  if (pane.scrollRow > maxScroll) { pane.scrollRow = maxScroll; }
  if (pane.cursorRow < pane.scrollRow) { pane.cursorRow = pane.scrollRow; }
  const lastVisible = pane.scrollRow + dataRows - 1;
  if (pane.cursorRow > lastVisible) { pane.cursorRow = Math.max(0, lastVisible); }
  if (pane.cursorRow >= pane.rowIds.length) { pane.cursorRow = pane.rowIds.length - 1; }
}

/**
 * Per-mode dispatch. Returns an InputAction so the existing main-loop
 * machinery (render, select_doc, …) handles the side effects.
 */
export function handleMouseEvent(event: MouseEvent, state: AppState): InputAction {
  // Ignore button releases entirely -- we act on the press / wheel tick.
  // (Releases would otherwise re-fire the same action on click-up.)
  if (!event.press) { return { type: "none" }; }

  // Wheel events: scroll the view. Buttons 64/65 only ever arrive on press.
  if (event.button === 64 || event.button === 65) {
    return handleWheel(event, state);
  }

  // Only left clicks are wired up; middle/right are no-ops for now.
  if (event.button !== 0) { return { type: "none" }; }

  // Help-bar hits take priority over mode-specific dispatch -- the bar
  // is drawn near the bottom and would otherwise fall through to e.g.
  // grid-cell logic and miss.
  const helpAction = helpHitAt(state, event.x - 1, event.y - 1);
  if (helpAction) { return helpAction; }

  switch (state.mode) {
    case "site_picker":
      return handlePickerClick(event, state, "site");
    case "table_picker":
      return handlePickerClick(event, state, "table");
    case "page_picker":
      return handlePickerClick(event, state, "page");
    case "command_palette":
      return handlePaletteClick(event, state);
    case "grid":
    case "overlay":
      return handleGridClick(event, state);
    case "editing":
    case "confirm_delete":
    case "cell_viewer":
      // These modes are modal -- a click outside the relevant area
      // shouldn't yank the user out mid-edit.
      return { type: "none" };
    default:
      return { type: "none" };
  }
}

function handleWheel(event: MouseEvent, state: AppState): InputAction {
  const direction = event.button === 64 ? -1 : 1;
  const step = 3; // matches a typical terminal wheel notch
  const termRows = process.stdout.rows || 24;

  if (state.mode === "site_picker") {
    state.siteCursor = clampIdx(state.siteCursor + direction * step, state.siteDocs.length);
    return { type: "render" };
  }
  if (state.mode === "table_picker") {
    state.selectedTableIndex = clampIdx(
      state.selectedTableIndex + direction * step, state.tableIds.length);
    return { type: "render" };
  }
  if (state.mode === "page_picker") {
    state.selectedPageIndex = clampIdx(
      state.selectedPageIndex + direction * step, state.pages.length);
    return { type: "render" };
  }
  if (state.mode === "command_palette") {
    const filtered = filterCommands(state.paletteQuery, state.paletteReturnMode);
    state.paletteCursor = clampIdx(state.paletteCursor + direction * step, filtered.length);
    return { type: "render" };
  }
  if (state.mode === "cell_viewer") {
    state.cellViewerScroll = Math.max(0, state.cellViewerScroll + direction * step);
    return { type: "render" };
  }

  // Grid / overlay: scroll the pane the cursor is hovering over (if any),
  // falling back to the active view.
  const trayHeight = state.collapsedPaneIndices.length > 0 ? 1 : 0;
  let pane: PaneState | undefined;
  if (state.layout) {
    const hit = findLeafAt(state, event.x, event.y, trayHeight);
    if (hit) { pane = state.panes[hit.paneIndex]; }
  }
  if (!pane) { pane = activeView(state); }
  if (!pane) { return { type: "none" }; }

  // Estimate visible data rows for cursor clamping. For multi-pane this
  // is per-leaf; for single-pane it's the whole screen minus chrome.
  const dataRows = state.layout
    ? Math.max(1, termRows - 2 - trayHeight - 3)  // rough: leaf height minus header
    : Math.max(1, termRows - 5);

  pane.scrollRow += direction * step;
  clampPaneScroll(pane, dataRows);
  return { type: "render" };
}

function clampIdx(i: number, len: number): number {
  if (len <= 0) { return 0; }
  if (i < 0) { return 0; }
  if (i >= len) { return len - 1; }
  return i;
}

function handlePickerClick(
  event: MouseEvent, state: AppState, kind: "site" | "table" | "page",
): InputAction {
  // All three pickers share the same chrome: row 0 = title bar, row 1 =
  // blank, items start at row 2.
  const itemY = event.y - 1; // 0-based screen row
  if (itemY < 2) { return { type: "none" }; } // clicked title

  const termRows = process.stdout.rows || 24;
  const visibleCount = Math.max(0, termRows - 5);
  const slot = itemY - 2;
  if (slot < 0 || slot >= visibleCount) { return { type: "none" }; }

  if (kind === "site") {
    // Only the site picker scrolls; recompute the same scroll offset
    // the renderer uses so a click maps to the visually-clicked row.
    const total = state.siteDocs.length;
    const cap = Math.min(total, visibleCount);
    const scroll = Math.max(0, Math.min(total - cap,
      state.siteCursor - Math.floor(cap / 2)));
    const idx = scroll + slot;
    if (idx >= total) { return { type: "none" }; }
    if (idx === state.siteCursor) {
      // Second click on already-selected row activates -- mouse equivalent
      // of "click then Enter" without forcing the user to move to the
      // keyboard mid-flow.
      return { type: "select_doc" };
    }
    state.siteCursor = idx;
    return { type: "render" };
  }

  if (kind === "table") {
    const idx = slot;
    if (idx >= state.tableIds.length) { return { type: "none" }; }
    if (idx === state.selectedTableIndex) {
      return { type: "select_table" };
    }
    state.selectedTableIndex = idx;
    return { type: "render" };
  }

  // page
  const idx = slot;
  if (idx >= state.pages.length) { return { type: "none" }; }
  if (idx === state.selectedPageIndex) {
    return { type: "select_page" };
  }
  state.selectedPageIndex = idx;
  return { type: "render" };
}

function handlePaletteClick(event: MouseEvent, state: AppState): InputAction {
  // Palette layout: title (row 0), query (row 1), then list rows starting
  // at row 2. Click in title or query is a no-op.
  const itemY = event.y - 1;
  if (itemY < 2) { return { type: "none" }; }

  const termRows = process.stdout.rows || 24;
  const dataRows = Math.max(1, termRows - 4);
  const slot = itemY - 2;
  if (slot < 0 || slot >= dataRows) { return { type: "none" }; }

  // Replicate the renderer's display-row layout so a click on screen row
  // R picks the same command the user can see at row R, regardless of
  // scroll.
  const filtered = filterCommands(state.paletteQuery, state.paletteReturnMode);
  if (filtered.length === 0) { return { type: "none" }; }
  const display = buildDisplayRows(state.paletteQuery, state.paletteReturnMode);
  const focusedDisplayIdx = display.findIndex(
    row => row.kind === "command" && row.filteredIdx === state.paletteCursor
  );
  const scroll = computePaletteScroll(
    Math.max(0, focusedDisplayIdx), display.length, dataRows,
  );

  const row = display[scroll + slot];
  if (!row || row.kind !== "command") {
    // Click on a header line or past the last row: leave the cursor alone.
    return { type: "none" };
  }
  const target = row.filteredIdx;
  if (target === state.paletteCursor) {
    // Activate -- mirror the Enter handler in handlePaletteKey: dispatch
    // the command's action, or close the palette if it's a help row.
    const cmd = filtered[target];
    if (!cmd || cmd.action.type === "none") {
      return { type: "close_command_palette" };
    }
    state.mode = state.paletteReturnMode;
    state.paletteQuery = "";
    state.paletteCursor = 0;
    return cmd.action;
  }
  state.paletteCursor = target;
  return { type: "render" };
}

function handleGridClick(event: MouseEvent, state: AppState): InputAction {
  const termRows = process.stdout.rows || 24;
  if (event.y >= termRows - 1) { return { type: "none" }; }
  if (state.mode === "overlay") { return handleOverlayClick(event, state); }

  const sepWidth = displayWidth(state.theme.colSeparator);
  const hasHeaderSep = !!state.theme.headerSepLine;

  // Single-pane (renderGrid) mode: pane fills the screen above the
  // help/status footer.
  if (!state.layout) {
    const pane = state.panes[state.focusedPane];
    if (!pane) { return { type: "none" }; }
    const fullWidth = process.stdout.columns || 80;
    const cell = gridCellAtPaneCoord(pane, fullWidth, event.y - 1, event.x - 1,
      hasHeaderSep, sepWidth);
    if (cell) {
      pane.cursorRow = cell.row;
      pane.cursorCol = cell.col;
      ensureColVisible(pane, fullWidth);
    }
    return { type: "render" };
  }

  // Multi-pane page.
  const trayHeight = state.collapsedPaneIndices.length > 0 ? 1 : 0;
  if (trayHeight && event.y - 1 < trayHeight) {
    return handleTrayClick(event, state);
  }
  const hit = findLeafAt(state, event.x, event.y, trayHeight);
  if (!hit) { return { type: "none" }; }
  const pane = state.panes[hit.paneIndex];
  if (!pane) { return { type: "none" }; }

  state.focusedPane = hit.paneIndex;
  const paneRow = (event.y - 1 - trayHeight) - hit.leaf.top;
  const paneCol = (event.x - 1) - hit.leaf.left;

  if (isCardPane(pane)) {
    const target = cardFieldAtPaneCoord(pane, paneRow);
    if (target) { pane.cursorCol = target.col; }
    return { type: "render" };
  }
  const cell = gridCellAtPaneCoord(pane, hit.leaf.width, paneRow, paneCol,
    hasHeaderSep, sepWidth);
  if (cell) {
    pane.cursorRow = cell.row;
    pane.cursorCol = cell.col;
    ensureColVisible(pane, hit.leaf.width);
  }
  return { type: "render" };
}

/**
 * Click in the collapsed-widget tray (row 0 of a multi-pane page).
 * Mirrors the layout in renderCollapsedTray (ConsoleMultiPane.ts): each
 * pill is ` <i+1>:<paneTitle> ` followed by a literal space separator.
 * Clicking a pill opens that pane full-screen as an overlay -- the
 * keyboard equivalent is Alt+1..9.
 */
function handleTrayClick(event: MouseEvent, state: AppState): InputAction {
  const x = event.x - 1; // 0-based screen column
  let cursor = 0;
  for (let i = 0; i < state.collapsedPaneIndices.length; i++) {
    const paneIdx = state.collapsedPaneIndices[i];
    const pane = state.panes[paneIdx];
    if (!pane) { continue; }
    const label = ` ${i + 1}:${paneTitle(pane)} `;
    const pillWidth = displayWidth(label);
    // The renderer adds a single space between pills; treat that gap as
    // part of the preceding pill so the user can click "near" a pill
    // without a dead zone between them.
    const slotEnd = cursor + pillWidth + 1;
    if (x >= cursor && x < slotEnd) {
      state.overlayPaneIndex = paneIdx;
      state.mode = "overlay";
      return { type: "render" };
    }
    cursor = slotEnd;
  }
  return { type: "none" };
}

function handleOverlayClick(event: MouseEvent, state: AppState): InputAction {
  if (state.overlayPaneIndex === null) { return { type: "none" }; }
  const pane = state.panes[state.overlayPaneIndex];
  if (!pane) { return { type: "none" }; }
  const termCols = process.stdout.columns || 80;
  const trayHeight = state.collapsedPaneIndices.length > 0 ? 1 : 0;
  const paneRow = event.y - 1 - trayHeight;
  const paneCol = event.x - 1;
  if (isCardPane(pane)) {
    const target = cardFieldAtPaneCoord(pane, paneRow);
    if (target) { pane.cursorCol = target.col; }
    return { type: "render" };
  }
  const cell = gridCellAtPaneCoord(pane, termCols, paneRow, paneCol,
    !!state.theme.headerSepLine, displayWidth(state.theme.colSeparator));
  if (cell) {
    pane.cursorRow = cell.row;
    pane.cursorCol = cell.col;
    ensureColVisible(pane, termCols);
  }
  return { type: "render" };
}

