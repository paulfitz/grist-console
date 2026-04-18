/**
 * Pure display / ANSI helpers -- string width measurement, truncation,
 * padding, color helpers, edit-window scrolling, and the ANSI escape
 * constants used by the renderer and input modules.
 *
 * Nothing in here touches AppState or reads from stdout; it's all
 * string-in-string-out.
 */

import stringWidth from "string-width";
import { CellValue } from "./types.js";
import { getTermWidthOverride, getFlagPairDelta, getVs16Delta, hasOverrides } from "./termWidth.js";

// ANSI escape codes (non-stylistic, always needed)
const ESC = "\x1b[";
export const CLEAR_LINE = `${ESC}K`; // clear from cursor to end of line
export const MOVE_TO = (row: number, col: number) => `${ESC}${row + 1};${col + 1}H`;
export const HIDE_CURSOR = `${ESC}?25l`;
export const SHOW_CURSOR = `${ESC}?25h`;
export const ENTER_ALT_SCREEN = `${ESC}?1049h`;
export const EXIT_ALT_SCREEN = `${ESC}?1049l`;
export const ANSI_RESET = "\x1b[0m";

/**
 * Extract every http/https URL from a string. Used by the cell viewer to
 * enumerate openable links.
 */
export function extractUrls(s: string): string[] {
  return [...s.matchAll(/https?:\/\/[^\s)>\]]+/g)].map(m => m[0]);
}

/**
 * Return the display width of a string in terminal cells.
 * Uses string-width, with terminal-measured overrides for known-problematic characters.
 */
export function displayWidth(s: string): number {
  // Strip ANSI escape codes before measuring
  const clean = s.replace(/\x1b\[[0-9;]*m/g, "");
  const flagPairDelta = getFlagPairDelta();
  const vs16Delta = getVs16Delta();
  // When no calibration has detected any discrepancy, trust string-width fully
  // (handles composing terminals correctly for ZWJ, flags, etc.)
  if (!hasOverrides() && flagPairDelta === 0 && vs16Delta === 0) {
    return stringWidth(clean);
  }

  // Walk through the string char-by-char. For non-composing terminals this
  // naturally gives the correct width (each emoji counted individually,
  // ZWJ counted as 0). Flags need a delta since walking gives 1+1=2 for an
  // RI pair, but the terminal may render them as 4 cells unjoined.
  let w = 0;
  const chars = [...clean];
  let i = 0;
  while (i < chars.length) {
    // Check multi-codepoint overrides first, PREFERRING longer matches so that
    // e.g. a "❤️" (2-char) override beats a bare "❤" (1-char) override, and
    // a full ZWJ sequence beats individual components.
    let matched = false;
    for (let len = Math.min(chars.length - i, 8); len >= 2; len--) {
      const candidate = chars.slice(i, i + len).join("");
      const override = getTermWidthOverride(candidate);
      if (override !== undefined) {
        w += override;
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) { continue; }

    // Regional-indicator pair (flag emoji) -- check BEFORE single-char overrides
    const code = chars[i].codePointAt(0)!;
    const isRI = code >= 0x1F1E6 && code <= 0x1F1FF;
    if (isRI && i + 1 < chars.length) {
      const nextCode = chars[i + 1].codePointAt(0)!;
      if (nextCode >= 0x1F1E6 && nextCode <= 0x1F1FF) {
        w += 2 + flagPairDelta;
        i += 2;
        continue;
      }
    }

    // Character followed by VS16: handle as emoji-composed BEFORE single-char
    // override, because the same base char can render differently with VS16
    // (e.g. ❤ alone = 1 cell text, ❤+VS16 = 2 cells emoji).
    if (i + 1 < chars.length && chars[i + 1].codePointAt(0) === 0xFE0F) {
      w += stringWidth(chars[i] + chars[i + 1]) + vs16Delta;
      i += 2;
      continue;
    }

    // Single-char override, or fall back to string-width.
    // For ZWJ sequences / skin tones, we walk char-by-char. This matches
    // partial-compose and non-composing terminals naturally (e.g.
    // 🧙+ZWJ+♀+VS16 = 2+0+1+0 = 3 cells). Fully-composing terminals get
    // walked overcount, but the background probe catches and stores an
    // override for the exact composed sequence.
    const override = getTermWidthOverride(chars[i]);
    if (override !== undefined) {
      w += override;
    } else {
      w += stringWidth(chars[i]);
    }
    i++;
  }
  return w;
}

/**
 * Replace newlines and other control characters with spaces for single-line display.
 */
export function flattenToLine(s: string): string {
  return s.replace(/[\n\r\t]/g, " ");
}

/**
 * Truncate a string to fit within maxLen display cells.
 */
export function truncate(s: string, maxLen: number): string {
  if (displayWidth(s) <= maxLen) { return s; }
  // Binary-ish search: try progressively shorter slices
  const chars = [...s]; // split into codepoints
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (displayWidth(chars.slice(0, mid).join("")) + 1 <= maxLen) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return chars.slice(0, lo).join("") + "\u2026";
}

export function padRight(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) { return s; }
  return s + " ".repeat(width - w);
}

export function padLeft(s: string, width: number): string {
  const w = displayWidth(s);
  if (w >= width) { return s; }
  return " ".repeat(width - w) + s;
}

/** Strip ANSI SGR escape codes from a string. */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Convert a hex color like "#2486FB" to an ANSI 24-bit color escape.
 */
export function hexToAnsi(hex: string, bg: boolean): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) { return ""; }
  return bg ? `\x1b[48;2;${r};${g};${b}m` : `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Apply choice color styling to a cell value string if the column has choiceOptions.
 */
export function applyChoiceColor(formatted: string, value: CellValue, colType: string, widgetOpts?: Record<string, any>): string {
  if (!widgetOpts?.choiceOptions) { return formatted; }
  const baseType = colType.split(":")[0];
  const opts = widgetOpts.choiceOptions as Record<string, { fillColor?: string; textColor?: string }>;

  if (baseType === "Choice") {
    const key = typeof value === "string" ? value : String(value);
    const colors = opts[key];
    if (!colors) { return formatted; }
    let ansi = "";
    if (colors.fillColor) { ansi += hexToAnsi(colors.fillColor, true); }
    if (colors.textColor) { ansi += hexToAnsi(colors.textColor, false); }
    if (!ansi) { return formatted; }
    return ansi + formatted + ANSI_RESET;
  }

  if (baseType === "ChoiceList" && Array.isArray(value) && value[0] === "L") {
    const items = value.slice(1) as string[];
    const fullJoined = items.map(v => String(v)).join(", ");
    // If the formatted string was truncated, we can't reliably color per-item
    // while preserving alignment -- return plain formatted text instead.
    if (formatted !== fullJoined) {
      return formatted;
    }
    // Color each choice in the comma-separated list
    const colored = items.map(item => {
      const colors = opts[item];
      if (!colors) { return String(item); }
      let ansi = "";
      if (colors.fillColor) { ansi += hexToAnsi(colors.fillColor, true); }
      if (colors.textColor) { ansi += hexToAnsi(colors.textColor, false); }
      if (!ansi) { return String(item); }
      return ansi + String(item) + ANSI_RESET;
    });
    return colored.join(", ");
  }

  return formatted;
}

/**
 * Return a visible window of the edit text that keeps the cursor in view,
 * plus the cursor's column offset within that window.
 */
export function editWindow(editValue: string, cursorPos: number, width: number): { text: string; cursorOffset: number } {
  const chars = [...editValue];
  // Find the display width up to the cursor
  const beforeCursor = chars.slice(0, cursorPos).join("");
  const cursorDisplayPos = displayWidth(beforeCursor);

  if (cursorDisplayPos < width) {
    // Cursor fits -- show from the start, truncate at width
    return { text: padRight(truncate(editValue, width), width), cursorOffset: cursorDisplayPos };
  }

  // Cursor is past visible area -- scroll so cursor is near the right edge
  const margin = Math.max(1, Math.floor(width / 4));
  const targetStart = cursorDisplayPos - width + margin;

  // Find the character index where display width >= targetStart
  let w = 0;
  let startCharIdx = 0;
  for (const ch of chars) {
    if (w >= targetStart) { break; }
    w += displayWidth(ch);
    startCharIdx++;
  }

  const visible = chars.slice(startCharIdx).join("");
  const truncated = truncate(visible, width);
  const offsetInWindow = cursorDisplayPos - displayWidth(chars.slice(0, startCharIdx).join(""));
  return { text: padRight(truncated, width), cursorOffset: Math.min(offsetInWindow, width - 1) };
}
