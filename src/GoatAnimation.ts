/**
 * A goat ambles horizontally along the focused pane, bouncing off the
 * left and right edges. Pops a bigger jgs sprite when the pane is tall
 * enough; otherwise a compact walker. A timer in ConsoleMain advances
 * the goat every ~900ms.
 */

import { AppState, PaneState } from "./ConsoleAppState.js";
import { formatCellValue } from "./ConsoleCellFormat.js";
import { ANSI_RESET, displayWidth, flattenToLine, hexToAnsi, MOVE_TO, stripAnsi } from "./ConsoleDisplay.js";
import { collectLeaves, computeColLayout } from "./ConsoleLayout.js";
import { Theme } from "./ConsoleTheme.js";

type GoatDir = "left" | "right";

interface GoatState {
  paneIdx: number;
  /** Horizontal cell offset from the pane's left edge. Walk bounces in [0, walkMax]. */
  x: number;
  /** Facing direction; follows the walk. */
  dir: GoatDir;
  /** Step counter -- drives the animation frame cycle. */
  frame: number;
  /** Running tally of steps taken (munches). */
  munchCount: number;
  /** Column the goat is peeking at (for the status line). */
  colIdx: number;
  /** Cell content near the peek, for flavor text. */
  snack: string;
}

// Ambles this many cells per step. Big enough to be visibly moving,
// small enough not to teleport.
const WALK_STEP = 3;

// Cushion kept between the goat's far edge and the cursor column when
// the goat scurries past. A few cells so the sprite clearly clears the
// cursor cell rather than straddling its neighbour.
const SCURRY_GAP = 4;

// White background + black foreground, so the goat stands out as a
// light patch against any theme background. 24-bit truecolor; terminals
// without truecolor fall back to the default SGR (still legible).
const GOAT_STYLE = hexToAnsi("#FFFFFF", true) + hexToAnsi("#000000", false);

// ---------------------------------------------------------------------------
// Big goat -- Joan Stark's 12/96 goat.cow, used verbatim when the terminal is
// tall enough. Head/eyes are at the upper-LEFT and the tail (`\_}`) is far
// right, so this sprite FACES LEFT. The right-facing variant is derived by
// mirroring (see BIG_FRAMES_RIGHT below). Two frames animate a subtle
// jaw-chew; the goat ambles horizontally via _goat.x in stepGoat.
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

// Pad every line to the frame's max width before reversing -- otherwise
// lines of different lengths reverse around their own center and break
// vertical alignment between rows (e.g. horns drift off the head).
const MIRROR_MAP: Record<string, string> = {
  "/": "\\", "\\": "/",
  "(": ")", ")": "(",
  "<": ">", ">": "<",
  "{": "}", "}": "{",
  "[": "]", "]": "[",
  "`": "'", "'": "`",
};
function mirrorFrame(frame: string[]): string[] {
  const maxW = Math.max(...frame.map(l => l.length));
  return frame.map(line => {
    const padded = line.padEnd(maxW, " ");
    return [...padded].reverse().map(c => MIRROR_MAP[c] ?? c).join("");
  });
}
const BIG_FRAMES_RIGHT: string[][] = BIG_FRAMES.map(mirrorFrame);

// Pane must have at least this many visible data rows to show the big goat.
// Otherwise we fall back to the compact sprite.
const BIG_MIN_ROWS = BIG_HEIGHT + 4;

// ---------------------------------------------------------------------------
// Compact side-view goat -- used when the terminal is too small for the big
// sprite. Variant 2 from goat-options.txt with curly horns (((__)))-ish
// arches) AND small ears above the face. Walk / walk / graze cycle; left
// and right facing variants.
// ---------------------------------------------------------------------------
const COMPACT_FRAMES_LEFT: string[][] = [
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
// Derive the right-facing frames by mirroring the left-facing source
// so the two stay in lockstep when the source is edited.
const COMPACT_FRAMES_RIGHT: string[][] = COMPACT_FRAMES_LEFT.map(mirrorFrame);
const COMPACT_WIDTH = Math.max(...COMPACT_FRAMES_LEFT[0].map(l => l.length));
const COMPACT_HEIGHT = COMPACT_FRAMES_LEFT[0].length;

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
 * Advance the goat one step along its horizontal walk, bouncing at the
 * pane edges. Sprite size (big / compact) is a pane-size heuristic; the
 * walk itself is identical either way. Returns true if a render-visible
 * change happened.
 */
export function stepGoat(state: AppState): boolean {
  const paneIdx = state.focusedPane;
  const pane = state.panes[paneIdx];
  if (!pane || pane.rowIds.length === 0 || pane.columns.length === 0) {
    _goat = null;
    return false;
  }

  // Resolve the pane's actual rectangle so the walk bounces at the
  // right-hand edge. Fall back to terminal size when layout is absent
  // (tests, fresh startup before first layout pass).
  const leaf = state.layout ? collectLeaves(state.layout).find(l => l.paneIndex === paneIdx) : null;
  const leafWidth = leaf ? leaf.width : (process.stdout.columns || 80);
  const leafHeight = leaf ? leaf.height : (process.stdout.rows || 24);
  const sprite = spriteDimsFor(leafWidth, leafHeight);
  const walkMax = Math.max(0, leafWidth - sprite.width - 2);

  // Reset on pane change so the goat starts at the left edge, heading right.
  const carryover = _goat && _goat.paneIdx === paneIdx;
  let x = carryover ? _goat!.x : 0;
  let dir: GoatDir = carryover ? _goat!.dir : "right";
  x += dir === "right" ? WALK_STEP : -WALK_STEP;
  if (x >= walkMax) { x = walkMax; dir = "left"; }
  else if (x <= 0) { x = 0; dir = "right"; }

  // Scurry: leap past the cursor in the current walk direction if the
  // goat's sprite would cover the cursor cell. Uses exact screen-column
  // math (same sources as the renderer) so the check agrees with what
  // the user actually sees.
  const scurryX = scurryAround(pane, state.theme, leafWidth, leafHeight, sprite, x, dir, walkMax);
  if (scurryX !== null) { x = scurryX; }

  // Snack + colIdx: peek at a random visible column for flavor text.
  // The goat's face doesn't land on a specific cell (it floats in pixel
  // space), so a random column is close enough -- and keeps the status
  // line varied turn-to-turn.
  const visCols = Math.max(1, pane.columns.length - pane.scrollCol);
  const colIdx = pane.scrollCol + Math.floor(Math.random() * visCols);
  const rowIdx = Math.min(pane.rowIds.length - 1, pane.scrollRow);
  const col = pane.columns[colIdx];
  const raw = col ? pane.colValues[col.colId]?.[rowIdx] : null;
  const text = col ? flattenToLine(formatCellValue(raw, col.type, col.widgetOptions, col.displayValues)) : "";
  const snack = text ? text.slice(0, 20) : "(empty)";

  _goat = {
    paneIdx,
    x,
    dir,
    frame: (_goat?.frame ?? 0) + 1,
    munchCount: (_goat?.munchCount ?? 0) + 1,
    colIdx,
    snack,
  };
  return true;
}

/**
 * Big sprite when the pane is tall and wide enough; compact otherwise.
 * Used by both the walk-bounds calc in stepGoat and the sprite pick in
 * renderGoatOverlay so the two agree.
 */
function spriteDimsFor(leafWidth: number, leafHeight: number): { width: number; height: number } {
  // Dataframe rows = leafHeight minus headers/footers/status, roughly.
  const approxDataRows = Math.max(0, leafHeight - 5);
  return (approxDataRows >= BIG_MIN_ROWS && leafWidth >= BIG_WIDTH + 2)
    ? { width: BIG_WIDTH, height: BIG_HEIGHT }
    : { width: COMPACT_WIDTH, height: COMPACT_HEIGHT };
}

/**
 * If the goat's sprite would land on top of the cursor cell, return a
 * new x that leaps past the cursor (in the current walk direction) with
 * a SCURRY_GAP cushion. Returns null if no overlap or no room to dart.
 *
 * All coordinates are offsets from the pane's leafLeft / leafTop.
 * Horizontal math uses real column widths and the row-number gutter so
 * the scurry trigger matches what the user sees.
 */
function scurryAround(
  pane: PaneState,
  theme: Theme,
  leafWidth: number,
  leafHeight: number,
  sprite: { width: number; height: number },
  x: number,
  dir: GoatDir,
  walkMax: number,
): number | null {
  if (walkMax <= 0) { return null; }

  // Vertical: does the cursor row fall inside the sprite's row band?
  // Sprite anchor mirrors renderGoatOverlay's logic (bottom by default,
  // top if the cursor is in the lower half of visible rows).
  const headerRows = theme.headerSepLine ? 3 : 2;
  const dataRows = Math.max(0, leafHeight - headerRows);
  const cursorRel = pane.cursorRow - pane.scrollRow;
  if (cursorRel < 0 || cursorRel >= dataRows) { return null; }
  const anchorAtTop = cursorRel > dataRows / 2;
  const spriteTop = anchorAtTop ? headerRows : leafHeight - sprite.height;
  const cursorRow = headerRows + cursorRel;
  if (cursorRow < spriteTop || cursorRow >= spriteTop + sprite.height) { return null; }

  // Horizontal: cursor cell's screen-column span relative to leafLeft.
  const cols = computeColLayout(pane);
  if (pane.cursorCol < 0 || pane.cursorCol >= cols.length) { return null; }
  const sepLen = theme.colSeparator.length;
  const maxRowId = pane.rowIds.length > 0 ? Math.max(...pane.rowIds) : 0;
  const rowNumWidth = Math.max(3, String(maxRowId).length);
  let cursorLeft = rowNumWidth;
  for (let c = pane.scrollCol; c < pane.cursorCol; c++) {
    cursorLeft += sepLen + cols[c].width;
  }
  cursorLeft += sepLen;
  const cursorRight = cursorLeft + cols[pane.cursorCol].width;

  // Goat sprite spans [x+1, x+1+width) in the same leafLeft-relative frame.
  const goatLeft = x + 1;
  const goatRight = x + 1 + sprite.width;
  if (cursorLeft >= goatRight || goatLeft >= cursorRight) { return null; }

  // Dart past the cursor in the current direction.
  return dir === "right"
    ? Math.min(walkMax, cursorRight + SCURRY_GAP - 1)
    : Math.max(0, cursorLeft - SCURRY_GAP - sprite.width - 1);
}

/**
 * Shared placement math: where does the sprite land in the pane's
 * coordinate frame (row 0 = leaf.top, col 0 = leaf.left)? Returns null
 * if the goat shouldn't render here (no goat, wrong pane type, no
 * layout match).
 *
 * `paneTop` is the caller's coordinate frame for the pane's top row.
 * Multi-pane's 2D buffer uses `leaf.top` directly; the screen-coord
 * overlay adds trayHeight.
 */
interface GoatPlacement {
  frame: string[];
  firstRow: number;    // first row in the caller's frame
  anchorCol: number;   // first col in the caller's frame
  clipTop: number;     // rows < clipTop are outside the pane
  clipBottom: number;  // rows >= clipBottom are outside the pane
  clipRight: number;   // cols >= clipRight are outside the pane
  leafLeft: number;    // pane's left col (buffer splice location)
}
function computeGoatPlacement(
  state: AppState,
  paneTop: number,
  fallbackHeight: number,
  fallbackWidth: number,
): GoatPlacement | null {
  if (!_goat) { return null; }
  const pane = state.panes[_goat.paneIdx];
  if (!pane) { return null; }
  const pk = pane.sectionInfo?.parentKey;
  if (pk === "single" || pk === "detail" || pk === "chart") { return null; }

  let leafTop = paneTop;
  let leafLeft = 0;
  let leafWidth = fallbackWidth;
  let leafHeight = fallbackHeight;
  if (state.layout) {
    const leaf = collectLeaves(state.layout).find(l => l.paneIndex === _goat!.paneIdx);
    if (!leaf) { return null; }
    leafTop = leaf.top + paneTop;
    leafLeft = leaf.left;
    leafWidth = leaf.width;
    leafHeight = leaf.height;
  }

  const t = state.theme;
  const headerRows = t.headerSepLine ? 3 : 2;
  const dataRows = Math.max(0, leafHeight - headerRows);

  const sprite = spriteDimsFor(leafWidth, leafHeight);
  const useBig = sprite.width === BIG_WIDTH;
  // BIG_FRAMES / COMPACT_FRAMES_LEFT (source) face LEFT; *_RIGHT mirrors face right.
  const frameSet = useBig
    ? (_goat.dir === "left" ? BIG_FRAMES : BIG_FRAMES_RIGHT)
    : (_goat.dir === "left" ? COMPACT_FRAMES_LEFT : COMPACT_FRAMES_RIGHT);
  const frame = frameSet[_goat.frame % frameSet.length];

  // Anchor: bottom by default; top if the cursor is in the lower half
  // of the visible rows, so the goat never covers the cell in use.
  const cursorRel = pane.cursorRow - pane.scrollRow;
  const anchorAtTop = cursorRel > dataRows / 2;
  const firstRow = anchorAtTop
    ? leafTop + headerRows
    : leafTop + leafHeight - frame.length;

  const walkMax = Math.max(0, leafWidth - sprite.width - 2);
  const x = Math.max(0, Math.min(walkMax, _goat.x));
  const anchorCol = leafLeft + 1 + x;

  return {
    frame,
    firstRow,
    anchorCol,
    clipTop: leafTop + headerRows,
    clipBottom: leafTop + leafHeight,
    clipRight: leafLeft + leafWidth,
    leafLeft,
  };
}

/**
 * Paint the goat sprite INTO the multi-pane 2D character buffer by
 * splicing goat characters into the pane's packed line (one cell per
 * pane row contains the full ANSI-wrapped line, the rest are empty).
 * Splicing preserves the surrounding SGR state so the line's coloring
 * resumes correctly after the goat.
 *
 * Doing this before the buffer flushes means each line hits the
 * terminal already containing the goat -- no "grid cleared, then goat
 * repainted" flash on terminals without DEC 2026.
 */
export function paintGoatIntoBuffer(state: AppState, buf: string[][], termCols: number): void {
  const placement = computeGoatPlacement(state, 0, buf.length, termCols);
  if (!placement) { return; }
  const { frame, firstRow, anchorCol, clipTop, clipBottom, clipRight, leafLeft } = placement;

  for (let r = 0; r < frame.length; r++) {
    const row = firstRow + r;
    if (row < clipTop || row >= clipBottom) { continue; }
    if (row < 0 || row >= buf.length) { continue; }
    const line = frame[r];
    const lineMax = Math.max(0, clipRight - anchorCol - 1);
    const end = Math.min(line.length, lineMax);
    // Body span: first and last non-space columns in this sprite row.
    let left = -1;
    let right = -1;
    for (let i = 0; i < end; i++) {
      if (line[i] !== " ") {
        if (left < 0) { left = i; }
        right = i;
      }
    }
    if (left < 0) { continue; }

    // Splice the goat body span into the pane's packed-line cell
    // (writeToBuffer contract: row content lives at buf[row][leafLeft],
    // neighbors are ""). If the row has no packed content yet -- blank
    // data rows below the last row, or rows the pane renderer skipped
    // -- synthesise one so the goat still shows.
    const packed = buf[row][leafLeft] ?? "";
    const goatBody = line.slice(left, right + 1);
    const goatStartInLine = anchorCol + left - leafLeft;
    const paneWidth = clipRight - leafLeft;

    const visibleWidth = displayWidth(stripAnsi(packed));
    if (visibleWidth < goatStartInLine + goatBody.length) {
      // Build a fresh blank line with the goat embedded, then enforce
      // writeToBuffer's one-cell-per-row convention so the join works.
      const leftFill = " ".repeat(Math.max(0, goatStartInLine - visibleWidth));
      const rightFill = " ".repeat(Math.max(0, paneWidth - goatStartInLine - goatBody.length));
      buf[row][leafLeft] = packed + leftFill
        + GOAT_STYLE + goatBody + ANSI_RESET
        + rightFill;
      for (let c = leafLeft + 1; c < Math.min(leafLeft + paneWidth, buf[row].length); c++) {
        buf[row][c] = "";
      }
      continue;
    }

    buf[row][leafLeft] = spliceGoatIntoPackedLine(packed, goatStartInLine, goatBody);
  }
}

/**
 * Insert `goatBody` into `line` starting at visual column `visualStart`
 * (measured from the line's own leftmost visible char). Walks the line
 * in codepoint units and uses displayWidth to advance the visual
 * column, so wide glyphs (emoji, CJK) don't desync the splice.
 *
 * Tracks the SGR state accumulated up to the splice point and re-emits
 * it after the goat so the line's remaining content keeps its color.
 * When the splice boundary falls inside a wide glyph we bias towards
 * preserving alignment: the pre-splice walk stops BEFORE a glyph that
 * would overshoot (so we may start 1 cell early), and the post-splice
 * walk consumes greedily (so we may eat 1 extra cell). Space padding
 * before / after the goat keeps the replaced width equal to what we
 * consumed, so every cell past the goat stays in its column.
 */
function spliceGoatIntoPackedLine(line: string, visualStart: number, goatBody: string): string {
  const goatWidth = goatBody.length;
  let visual = 0;
  let i = 0;
  let active = "";

  // Walk to the splice start. Stop BEFORE a glyph that would overshoot.
  while (i < line.length && visual < visualStart) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const endIdx = line.indexOf("m", i);
      if (endIdx < 0) { return line; }
      const sgr = line.slice(i, endIdx + 1);
      active = sgr === "\x1b[0m" ? "" : active + sgr;
      i = endIdx + 1;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const charLen = cp > 0xFFFF ? 2 : 1;
    const w = displayWidth(line.slice(i, i + charLen));
    if (visual + w > visualStart) { break; }
    visual += w;
    i += charLen;
  }
  const pos1 = i;
  const visualAtPos1 = visual;

  // Skip the region the goat replaces. Consume greedily so a glyph
  // straddling the right boundary is eaten whole.
  while (i < line.length && visual < visualStart + goatWidth) {
    if (line[i] === "\x1b" && line[i + 1] === "[") {
      const endIdx = line.indexOf("m", i);
      if (endIdx < 0) { return line; }
      const sgr = line.slice(i, endIdx + 1);
      active = sgr === "\x1b[0m" ? "" : active + sgr;
      i = endIdx + 1;
      continue;
    }
    const cp = line.codePointAt(i)!;
    const charLen = cp > 0xFFFF ? 2 : 1;
    visual += displayWidth(line.slice(i, i + charLen));
    i += charLen;
  }
  const pos2 = i;

  // Ran out of visible columns before reaching the splice -- nothing to do.
  if (pos1 === line.length && visualStart > 0) { return line; }

  // Pad to keep the replaced visual width equal to what we consumed.
  const leftPad = " ".repeat(Math.max(0, visualStart - visualAtPos1));
  const rightPad = " ".repeat(Math.max(0, visual - visualStart - goatWidth));

  return line.slice(0, pos1)
    + GOAT_STYLE + leftPad + goatBody + rightPad + ANSI_RESET
    + active
    + line.slice(pos2);
}

/**
 * Emit the goat as an ANSI overlay appended to already-rendered output.
 * Used by the single-pane renderer (which doesn't build a 2D buffer).
 * Prefer `paintGoatIntoBuffer` when a buffer is available -- it avoids
 * the grid-cleared-then-goat-repainted flash on non-synchronised
 * terminals.
 */
export function renderGoatOverlay(
  state: AppState,
  trayHeight: number,
  termRows: number,
  termCols: number,
): string {
  const placement = computeGoatPlacement(state, trayHeight, termRows - 2 - trayHeight, termCols);
  if (!placement) { return ""; }
  const { frame, firstRow, anchorCol, clipTop, clipBottom, clipRight } = placement;

  let out = "";
  for (let r = 0; r < frame.length; r++) {
    const sr = firstRow + r;
    if (sr < clipTop || sr >= clipBottom) { continue; }
    const line = frame[r];
    const maxChars = Math.max(0, clipRight - anchorCol - 1);
    out += emitSpriteLine(sr, anchorCol, line, maxChars);
  }
  return out;
}

/**
 * Emit a sprite line with transparent exterior: only the span between
 * the line's leftmost and rightmost non-space character is written.
 * Leading and trailing spaces are skipped so cell content shows through;
 * interior spaces inside the body span ARE written (painted blank) so
 * the goat's body isn't see-through. `maxChars` bounds the scan, so
 * callers don't need to pre-slice.
 */
function emitSpriteLine(sr: number, anchorCol: number, line: string, maxChars: number): string {
  const end = Math.min(line.length, maxChars);
  let left = -1;
  let right = -1;
  for (let i = 0; i < end; i++) {
    if (line[i] !== " ") {
      if (left < 0) { left = i; }
      right = i;
    }
  }
  if (left < 0) { return ""; }
  return MOVE_TO(sr, anchorCol + left) + GOAT_STYLE + line.slice(left, right + 1) + ANSI_RESET;
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
