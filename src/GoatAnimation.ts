/**
 * A goat wanders around the focused grid pane, munching on cells it
 * passes. It avoids the user's cursor cell -- politely nibbles
 * elsewhere. Leaves a three-step fading trail of grazed grass behind it.
 *
 * State is module-level; the goat lives across renders until the theme
 * changes or the user leaves grid mode. A timer in ConsoleMain advances
 * the goat every ~1500ms.
 */

import { AppState, PaneState } from "./ConsoleAppState.js";
import { formatCellValue } from "./ConsoleCellFormat.js";
import { flattenToLine, MOVE_TO } from "./ConsoleDisplay.js";
import { collectLeaves } from "./ConsoleLayout.js";

interface GoatPos {
  paneIdx: number;
  rowIdx: number;
  colIdx: number;
}

type GoatDir = "left" | "right";

interface GoatState extends GoatPos {
  /** Oldest trail cell is last; newest first. */
  trail: GoatPos[];
  /** Step counter -- drives the animation frame cycle. */
  frame: number;
  /** What the goat is currently eating, as a short display string. */
  snack: string;
  /** Running tally of cells the goat has visited. */
  munchCount: number;
  /** Which way is the goat facing? Flips when it moves horizontally. */
  dir: GoatDir;
}

const MAX_TRAIL = 3;

// ---------------------------------------------------------------------------
// Big goat -- Joan Stark's 12/96 goat.cow, used verbatim when the terminal is
// tall enough. The face is at the upper-left, the back arches right with a
// grazing grass arc (~^~^~^), legs reach down to a grass line (""...). No
// cell-wandering in this mode: the goat is anchored at the pane bottom and
// the two frames only nudge the jaw for a subtle chew.
// ---------------------------------------------------------------------------
const BIG_FRAMES: string[][] = [
  // Frame A -- original, jaw closed
  [
    "             / /",
    "          (\\/_//`)",
    "           /   '/",
    "          0  0   \\",
    "         /        \\",
    "        /    __/   \\",
    "       /,  _/ \\     \\_",
    "       `-./ )  |     ~^~^~^~^~^~^~^~\\~.",
    "           (   /                     \\_}",
    "              |               /      |",
    "              ;     |         \\      /",
    "               \\/ ,/           \\    |",
    "               / /~~|~|~~~~~~|~|\\   |",
    "              / /   | |      | | `\\ \\",
    "             / /    | |      | |   \\ \\",
    "            / (     | |      | |    \\ \\",
    "     jgs   /,_)    /__)     /__)   /,_/",
    "    '''''\"\"\"\"\"'''\"\"\"\"\"\"'''\"\"\"\"\"\"''\"\"\"\"\"'''''",
  ],
  // Frame B -- jaw open (chewing): the `(   /` nose/mouth becomes `(  _/`
  // and the grass arc loses one curl as if the goat just took a bite.
  [
    "             / /",
    "          (\\/_//`)",
    "           /   '/",
    "          0  0   \\",
    "         /        \\",
    "        /    __/   \\",
    "       /,  _/ \\     \\_",
    "       `-./ )  |     ~^~^~^~^~^~^~\\~.",
    "           (  _/                    \\_}",
    "              |               /      |",
    "              ;     |         \\      /",
    "               \\/ ,/           \\    |",
    "               / /~~|~|~~~~~~|~|\\   |",
    "              / /   | |      | | `\\ \\",
    "             / /    | |      | |   \\ \\",
    "            / (     | |      | |    \\ \\",
    "     jgs   /,_)    /__)     /__)   /,_/",
    "    '''''\"\"\"\"\"'''\"\"\"\"\"\"'''\"\"\"\"\"\"''\"\"\"\"\"'''''",
  ],
];
const BIG_HEIGHT = BIG_FRAMES[0].length;
const BIG_WIDTH = Math.max(...BIG_FRAMES[0].map(l => l.length));

// Pane must have at least this many visible data rows to show the big goat.
// Otherwise we fall back to the compact sprite.
const BIG_MIN_ROWS = BIG_HEIGHT + 4;

// ---------------------------------------------------------------------------
// Compact side-view goat -- used when the terminal is too small for the big
// sprite. Variant 2 from goat-options.txt with curly horns (((__)))-ish
// arches) AND small ears above the face. Walk / walk / graze cycle; left
// and right facing variants.
// ---------------------------------------------------------------------------
const COMPACT_FRAMES_RIGHT: string[][] = [
  // Walk, legs spread
  [
    "   ))_((  ",
    "  /^0 0^\\__",
    "   \\_/    \\",
    "   / \\   ||",
    "   \" \"   \"\"",
  ],
  // Walk, legs crossed
  [
    "   ))_((  ",
    "  /^0 0^\\__",
    "   \\_/    \\",
    "   \\ /   ||",
    "    \"    \"\"",
  ],
  // Grazing, head tipped down, grass at feet
  [
    "    ))_((   ",
    "   /^o o^\\__",
    "   \\_/     \\_",
    "    /~~~~~~~/",
    "    \"       \"",
  ],
];
const COMPACT_FRAMES_LEFT: string[][] = [
  [
    "   ))_((  ",
    "__/^0 0^\\  ",
    "  /    \\_/",
    "  || / \\  ",
    "  \"\"  \" \" ",
  ],
  [
    "   ))_((  ",
    "__/^0 0^\\  ",
    "  /    \\_/",
    "  || \\ /  ",
    "  \"\"   \"  ",
  ],
  [
    "     ))_((  ",
    "  __/^o o^\\ ",
    "_/    \\_/   ",
    "\\~~~~~~~\\   ",
    "\"       \"   ",
  ],
];
const COMPACT_ROWS = COMPACT_FRAMES_RIGHT[0].length;
// A full cycle is walk / walk / graze, so frame 2 of every 3 is the graze.
const GRAZE_FRAME_MOD = 3;

// Trail: a small flower at cells the goat was recently on.
const TRAIL_CHARS = [",*,", ".o.", " . "];

// The goat is a ruminant of many moods. Cycles per step, never two in a row.
const MUNCH_VERBS = [
  "nibbling", "munching", "grazing on", "chomping", "rummaging through",
  "ruminating on", "tasting", "chewing", "sampling", "snacking on",
];

let _goat: GoatState | null = null;

/** Test / cleanup hook: forget where the goat is. */
export function resetGoat(): void { _goat = null; }

/** Returns the current goat state (for rendering); null if not placed. */
export function getGoat(): Readonly<GoatState> | null { return _goat; }

/**
 * Advance the goat one step: prefer a random adjacent cell within the
 * focused pane, avoiding the user's cursor. Falls back to a random
 * teleport if boxed in. Records a fading trail of the last positions.
 * Returns true if a render-visible change happened.
 */
export function stepGoat(state: AppState): boolean {
  const paneIdx = state.focusedPane;
  const pane = state.panes[paneIdx];
  if (!pane || pane.rowIds.length === 0 || pane.columns.length === 0) {
    _goat = null;
    return false;
  }

  // Keep the goat in the window the user can actually see. Without this,
  // on a 500-row table most placements land below the scroll and the
  // overlay silently clips them -- the user never sees the goat.
  // Slightly pessimistic guess for visible height: terminal rows minus
  // header/footer/chrome. Also leave a bottom margin so the 4-row
  // sprite doesn't get clipped against the footer.
  const termRows = process.stdout.rows || 24;
  const visibleRows = Math.max(1, termRows - 6 - (COMPACT_ROWS - 1));
  const rowLow = pane.scrollRow;
  const rowHigh = Math.min(pane.rowIds.length, pane.scrollRow + visibleRows);
  const colLow = pane.scrollCol;
  // Assume the user can scan ~10 columns at a time; narrower if pane is small.
  const colHigh = Math.min(pane.columns.length, pane.scrollCol + 10);

  const cursorR = pane.cursorRow;
  const cursorC = pane.cursorCol;

  const carryTrail = _goat && _goat.paneIdx === paneIdx
    ? [{ paneIdx: _goat.paneIdx, rowIdx: _goat.rowIdx, colIdx: _goat.colIdx },
       ..._goat.trail].slice(0, MAX_TRAIL)
    : [];

  // The sprite is COMPACT_ROWS tall, so it extends down from the anchor
  // cell. Reject positions whose row band would cover the cursor row,
  // so the goat never obscures what the user is working on.
  const overlapsCursor = (r: number, c: number) =>
    cursorR >= r && cursorR < r + COMPACT_ROWS && c === cursorC;

  const pickTeleport = (): GoatPos => {
    const rowRange = Math.max(1, rowHigh - rowLow);
    const colRange = Math.max(1, colHigh - colLow);
    let r: number, c: number;
    let tries = 0;
    do {
      r = rowLow + Math.floor(Math.random() * rowRange);
      c = colLow + Math.floor(Math.random() * colRange);
      tries++;
    } while (overlapsCursor(r, c) && tries < 20);
    return { paneIdx, rowIdx: r, colIdx: c };
  };

  // Is the existing goat still inside the visible window? If the user
  // scrolled, the old position may now be off-screen -- teleport to a
  // fresh spot in the visible range rather than wandering from it.
  const goatVisible = _goat && _goat.paneIdx === paneIdx
    && _goat.rowIdx >= rowLow && _goat.rowIdx < rowHigh
    && _goat.colIdx >= colLow && _goat.colIdx < colHigh;

  let next: GoatPos;
  if (!goatVisible) {
    next = pickTeleport();
  } else {
    // Try to wander to a random adjacent cell (4-neighbourhood), avoiding
    // cursor and staying within the visible window.
    const dirs: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    next = pickTeleport(); // default if no neighbour works
    for (const [dr, dc] of dirs) {
      const nr = _goat!.rowIdx + dr;
      const nc = _goat!.colIdx + dc;
      if (nr < rowLow || nr >= rowHigh || nc < colLow || nc >= colHigh) { continue; }
      if (overlapsCursor(nr, nc)) { continue; }
      next = { paneIdx, rowIdx: nr, colIdx: nc };
      break;
    }
  }

  // What's the goat munching? Pull the cell value for status-bar commentary.
  const col = pane.columns[next.colIdx];
  const raw = col ? pane.colValues[col.colId]?.[next.rowIdx] : null;
  const text = col ? flattenToLine(formatCellValue(raw, col.type, col.widgetOptions, col.displayValues)) : "";
  const snack = text ? text.slice(0, 20) : "(empty)";

  // Infer the goat's facing direction from the horizontal move. Vertical
  // moves and teleports preserve the previous direction (goat keeps
  // looking where it was looking).
  let dir: GoatDir = _goat?.dir ?? "right";
  if (_goat && _goat.paneIdx === paneIdx) {
    if (next.colIdx > _goat.colIdx) { dir = "right"; }
    else if (next.colIdx < _goat.colIdx) { dir = "left"; }
  }

  _goat = {
    ...next,
    trail: carryTrail,
    frame: (_goat?.frame ?? 0) + 1,
    snack,
    munchCount: (_goat?.munchCount ?? 0) + 1,
    dir,
  };
  return true;
}

/**
 * Compute the screen-space output that overlays the goat sprite on top of
 * the already-rendered frame, at the goat's current cell. Also overlays
 * small trail markers at the goat's recently-visited cells. Caller
 * appends the result to the render output; the sprite is positioned via
 * MOVE_TO so it doesn't care about underlying cell widths.
 *
 * Returns "" if there's no goat, no layout, or the goat's pane is the
 * overlay pane (overlay uses the full screen and has its own code path).
 */
export function renderGoatOverlay(
  state: AppState,
  trayHeight: number,
  termRows: number,
  termCols: number,
): string {
  if (!_goat) { return ""; }
  const pane = state.panes[_goat.paneIdx];
  if (!pane) { return ""; }
  // Card panes (single / detail) lay out vertically with no column
  // header row, so the overlay's grid-based math lands in the wrong
  // place. Skip them entirely.
  const pk = pane.sectionInfo?.parentKey;
  if (pk === "single" || pk === "detail" || pk === "chart") { return ""; }

  // Resolve the pane's screen rectangle (leaf) and the column layout.
  let leafTop = trayHeight;
  let leafLeft = 0;
  let leafWidth = termCols;
  let leafHeight = termRows - 2 - trayHeight;
  if (state.layout) {
    const leaf = collectLeaves(state.layout).find(l => l.paneIndex === _goat!.paneIdx);
    if (!leaf) { return ""; }
    leafTop = leaf.top + trayHeight;
    leafLeft = leaf.left;
    leafWidth = leaf.width;
    leafHeight = leaf.height;
  }

  const t = state.theme;
  const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);
  const headerRows = t.headerSepLine ? 3 : 2;
  const dataRows = Math.max(0, leafHeight - headerRows);

  // Big goat mode: pane is tall enough to hold the full jgs sprite with
  // breathing room. Anchor at the pane's bottom edge (or top if cursor
  // is in the lower half). Don't use the goat's wandering position --
  // the big goat is parked, not ambling. Only the chew frame animates.
  if (dataRows >= BIG_MIN_ROWS && leafWidth >= BIG_WIDTH + 2) {
    return renderBigGoat(leafTop, leafLeft, leafWidth, leafHeight,
                         headerRows, pane.cursorRow, pane.scrollRow, dataRows);
  }

  // Compact mode: the cell-wandering goat.
  if (_goat.rowIdx < pane.scrollRow) { return ""; }
  if (_goat.colIdx < pane.scrollCol) { return ""; }

  const colWidths = paneColWidths(pane);

  // Screen column for a given pane column index (top-left of that cell).
  const cellScreenCol = (colIdx: number): number => {
    let x = leafLeft + rowNumWidth;
    for (let c = pane.scrollCol; c < colIdx; c++) {
      x += t.colSeparator.length + colWidths[c];
    }
    return x + t.colSeparator.length;
  };

  const cellScreenRow = (rowIdx: number): number =>
    leafTop + headerRows + (rowIdx - pane.scrollRow);

  let out = "";

  // Trail markers -- tiny 3-char flowers, replacing the underlying cell
  // character briefly.
  for (let i = 0; i < _goat.trail.length; i++) {
    const t = _goat.trail[i];
    if (t.paneIdx !== _goat.paneIdx) { continue; }
    if (t.rowIdx < pane.scrollRow) { continue; }
    const sr = cellScreenRow(t.rowIdx);
    const sc = cellScreenCol(t.colIdx);
    if (sr < leafTop + headerRows || sr >= leafTop + leafHeight) { continue; }
    if (sc < leafLeft + rowNumWidth || sc >= leafLeft + leafWidth) { continue; }
    out += MOVE_TO(sr, sc) + TRAIL_CHARS[Math.min(i, TRAIL_CHARS.length - 1)];
  }

  // Goat sprite -- written line by line at the goat's anchor cell, shifted
  // one line up so the face sits roughly on the goat's row rather than
  // starting below it. Frame cycle: walk / walk / graze. Left/right
  // frame set chosen by the goat's last horizontal move.
  if (_goat.rowIdx < pane.scrollRow) { return out; }
  const frameSet = _goat.dir === "left" ? COMPACT_FRAMES_LEFT : COMPACT_FRAMES_RIGHT;
  const frame = frameSet[_goat.frame % GRAZE_FRAME_MOD];
  const anchorRow = cellScreenRow(_goat.rowIdx) - 1;
  const anchorCol = cellScreenCol(_goat.colIdx);
  for (let r = 0; r < frame.length; r++) {
    const sr = anchorRow + r;
    if (sr < leafTop + headerRows || sr >= leafTop + leafHeight) { continue; }
    const line = frame[r];
    // Clip to pane right edge
    const maxChars = Math.max(0, leafLeft + leafWidth - anchorCol);
    const clipped = line.slice(0, maxChars);
    if (clipped.length === 0) { continue; }
    out += MOVE_TO(sr, anchorCol) + clipped;
  }
  return out;
}

/**
 * Paint the big jgs goat at the pane's bottom edge. If the cursor is in
 * the lower half, paint at the top instead so we never cover it. The
 * sprite itself is static apart from the two-frame jaw-chew animation.
 */
function renderBigGoat(
  leafTop: number, leafLeft: number, leafWidth: number, leafHeight: number,
  headerRows: number, cursorRow: number, scrollRow: number, dataRows: number,
): string {
  if (!_goat) { return ""; }
  const frame = BIG_FRAMES[_goat.frame % BIG_FRAMES.length];
  // If the user's cursor is in the lower half of visible rows, anchor the
  // goat at the top instead so it never covers the cell they're on.
  const cursorRel = cursorRow - scrollRow;
  const anchorAtTop = cursorRel > dataRows / 2;
  const firstRow = anchorAtTop
    ? leafTop + headerRows
    : leafTop + leafHeight - frame.length;
  let out = "";
  for (let r = 0; r < frame.length; r++) {
    const sr = firstRow + r;
    if (sr < leafTop + headerRows || sr >= leafTop + leafHeight) { continue; }
    const line = frame[r];
    // Clip to pane right edge so we don't bleed into another pane.
    const maxChars = Math.max(0, leafWidth - 1);
    const clipped = line.slice(0, maxChars);
    out += MOVE_TO(sr, leafLeft + 1) + clipped;
  }
  return out;
}

/**
 * Column widths the same way the renderer computes them. Mirrors
 * ConsoleRenderer.computeColLayout; duplicated to avoid a circular
 * import (ConsoleRenderer imports from this module).
 */
function paneColWidths(pane: PaneState): number[] {
  return pane.columns.map(col => {
    let w = col.label.length;
    const values = pane.colValues[col.colId];
    if (values) {
      const sample = Math.min(values.length, 100);
      for (let i = 0; i < sample; i++) {
        const v = values[i];
        const s = v == null ? "" : String(v);
        if (s.length > w) { w = s.length; }
      }
    }
    return Math.max(4, Math.min(30, w));
  });
}

/**
 * One-line status like "🐐 munching People.Name[Alice] · 47 nibbles"
 * for the footer. Verb cycles deterministically with the frame counter so
 * the line reads fresh without flickering on every render.
 */
export function goatStatus(state: AppState): string | null {
  if (!_goat) { return null; }
  const pane = state.panes[_goat.paneIdx];
  if (!pane) { return null; }
  const col = pane.columns[_goat.colIdx];
  const tableId = pane.sectionInfo?.tableId || state.currentTableId || "";
  const colId = col?.colId || "";
  const verb = MUNCH_VERBS[_goat.frame % MUNCH_VERBS.length];
  return `\u{1F410} ${verb} ${tableId}.${colId}[${_goat.snack}] \u00B7 ${_goat.munchCount} nibbles`;
}
