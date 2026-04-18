/**
 * A goat wanders around the focused grid pane, munching on cells it
 * passes. It avoids the user's cursor cell -- politely nibbles
 * elsewhere. Leaves a three-step fading trail of grazed grass behind it.
 *
 * State is module-level; the goat lives across renders until the theme
 * changes or the user leaves grid mode. A timer in ConsoleMain advances
 * the goat every ~1500ms.
 */

import { AppState } from "./ConsoleAppState.js";
import { formatCellValue } from "./ConsoleCellFormat.js";
import { flattenToLine } from "./ConsoleDisplay.js";

interface GoatPos {
  paneIdx: number;
  rowIdx: number;
  colIdx: number;
}

interface GoatState extends GoatPos {
  /** Oldest trail cell is last; newest first. */
  trail: GoatPos[];
  /** Which frame of the chew cycle -- flips on each step so the sprite bobs. */
  frame: number;
  /** What the goat is currently eating, as a short display string. */
  snack: string;
}

const MAX_TRAIL = 3;
const SPRITE_FRAMES = ["\u{1F410}", "\u{1F33F}\u{1F410}"]; // 🐐 and 🌿🐐
const TRAIL_CHARS = ["\u{1F33B}", "\u{1F33C}", "\u{1F331}"]; // 🌻 🌼 🌱 -- newest to oldest

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
  const maxR = pane.rowIds.length;
  const maxC = pane.columns.length;

  const cursorR = pane.cursorRow;
  const cursorC = pane.cursorCol;

  const carryTrail = _goat && _goat.paneIdx === paneIdx
    ? [{ paneIdx: _goat.paneIdx, rowIdx: _goat.rowIdx, colIdx: _goat.colIdx },
       ..._goat.trail].slice(0, MAX_TRAIL)
    : [];

  const pickTeleport = (): GoatPos => {
    let r: number, c: number;
    let tries = 0;
    do {
      r = Math.floor(Math.random() * maxR);
      c = Math.floor(Math.random() * maxC);
      tries++;
    } while (r === cursorR && c === cursorC && tries < 20);
    return { paneIdx, rowIdx: r, colIdx: c };
  };

  let next: GoatPos;
  if (!_goat || _goat.paneIdx !== paneIdx) {
    next = pickTeleport();
  } else {
    // Try to wander to a random adjacent cell (4-neighbourhood), avoiding cursor.
    const dirs: Array<[number, number]> = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let i = dirs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [dirs[i], dirs[j]] = [dirs[j], dirs[i]];
    }
    next = pickTeleport(); // default if no neighbour works
    for (const [dr, dc] of dirs) {
      const nr = _goat.rowIdx + dr;
      const nc = _goat.colIdx + dc;
      if (nr < 0 || nr >= maxR || nc < 0 || nc >= maxC) { continue; }
      if (nr === cursorR && nc === cursorC) { continue; }
      next = { paneIdx, rowIdx: nr, colIdx: nc };
      break;
    }
  }

  // What's the goat munching? Pull the cell value for status-bar commentary.
  const col = pane.columns[next.colIdx];
  const raw = col ? pane.colValues[col.colId]?.[next.rowIdx] : null;
  const text = col ? flattenToLine(formatCellValue(raw, col.type, col.widgetOptions, col.displayValues)) : "";
  const snack = text ? text.slice(0, 20) : "(empty)";

  _goat = {
    ...next,
    trail: carryTrail,
    frame: (_goat?.frame ?? 0) + 1,
    snack,
  };
  return true;
}

/**
 * Return the sprite (or null) to display at (paneIdx, rowIdx, colIdx).
 * Goats at the goat's current cell; a fading flower for trail cells.
 */
export function goatSpriteFor(paneIdx: number, rowIdx: number, colIdx: number): string | null {
  if (!_goat) { return null; }
  if (_goat.paneIdx === paneIdx && _goat.rowIdx === rowIdx && _goat.colIdx === colIdx) {
    return SPRITE_FRAMES[_goat.frame % SPRITE_FRAMES.length];
  }
  const trailAge = _goat.trail.findIndex(t =>
    t.paneIdx === paneIdx && t.rowIdx === rowIdx && t.colIdx === colIdx
  );
  if (trailAge >= 0) { return TRAIL_CHARS[Math.min(trailAge, TRAIL_CHARS.length - 1)]; }
  return null;
}

/** One-line status like "🐐 nibbling on People[Alice]" for the footer. */
export function goatStatus(state: AppState): string | null {
  if (!_goat) { return null; }
  const pane = state.panes[_goat.paneIdx];
  if (!pane) { return null; }
  const col = pane.columns[_goat.colIdx];
  const tableId = pane.sectionInfo?.tableId || state.currentTableId || "";
  const colId = col?.colId || "";
  return `\u{1F410} nibbling on ${tableId}.${colId}[${_goat.snack}]`;
}
