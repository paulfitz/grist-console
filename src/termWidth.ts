/**
 * Terminal character width calibration.
 *
 * Measures actual rendered width of test characters by querying the terminal's
 * cursor position (CPR: ESC[6n). Builds a correction map so displayWidth()
 * can account for terminals that disagree with string-width's Unicode tables.
 */

import stringWidth from "string-width";

// Map from character/grapheme cluster to measured terminal width
const _overrides = new Map<string, number>();
// If regional indicator pairs (flags) render wider than predicted, store the delta
// so we can apply it to any flag, not just the one we tested.
let _flagPairDelta = 0;
// If characters with VS16 (variation selector for emoji presentation) render
// differently than string-width predicts, store the per-VS16 delta.
let _vs16Delta = 0;

/**
 * Get the measured terminal width of a character, or undefined if not calibrated.
 */
export function getTermWidthOverride(ch: string): number | undefined {
  return _overrides.get(ch);
}

/**
 * Return the extra width to add for each regional-indicator pair (flag emoji)
 * in a string, based on calibration. Zero if the terminal matches string-width.
 */
export function getFlagPairDelta(): number {
  return _flagPairDelta;
}

/**
 * Return the extra width to add for each VS16 (U+FE0F emoji variation selector)
 * following a base character. Zero if the terminal matches string-width.
 */
export function getVs16Delta(): number {
  return _vs16Delta;
}

/** Count ZWJ (U+200D) characters in a string. */
export function countZwjs(s: string): number {
  let count = 0;
  for (const ch of s) {
    if (ch.codePointAt(0) === 0x200D) { count++; }
  }
  return count;
}

/** Test-only: set the flag pair delta directly. */
export function _setFlagPairDelta(delta: number): void {
  _flagPairDelta = delta;
}

/** Test-only: set the VS16 delta directly. */
export function _setVs16Delta(delta: number): void {
  _vs16Delta = delta;
}

/**
 * Count regional-indicator pairs in a string (each pair = one flag emoji).
 */
export function countFlagPairs(s: string): number {
  let count = 0;
  let inPair = false;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    const isRI = code >= 0x1F1E6 && code <= 0x1F1FF;
    if (isRI && !inPair) {
      inPair = true;
    } else if (isRI && inPair) {
      count++;
      inPair = false;
    } else {
      inPair = false;
    }
  }
  return count;
}

/**
 * True if calibration found any differences from string-width.
 */
export function hasOverrides(): boolean {
  return _overrides.size > 0;
}

// Tracks characters we've already probed so we don't re-check them.
const _probed = new Set<string>();

/** True if this character has been probed (calibrated). */
export function hasProbed(ch: string): boolean {
  return _probed.has(ch);
}

/**
 * Probe a single character: measure its actual width and update overrides
 * if it differs from string-width's prediction. Returns true if an override
 * was added or updated.
 *
 * Caller must have already removed any conflicting stdin data listeners --
 * this function installs its own temporary listener. Cursor position is
 * saved and restored, so the character is not visible to the user after.
 */
export async function probeChar(ch: string, timeout = 200): Promise<boolean> {
  if (_probed.has(ch)) { return false; }
  _probed.add(ch);
  const expected = stringWidth(ch);
  const actual = await measureWidth(ch, timeout);
  if (actual === null || actual === expected) { return false; }
  _overrides.set(ch, actual);
  const diff = actual - expected;
  // Update deltas for pattern-based overrides
  if (countFlagPairs(ch) === 1 && countZwjs(ch) === 0) {
    _flagPairDelta = diff;
  }
  if (ch.length === 2 && ch.charCodeAt(1) === 0xFE0F) {
    _vs16Delta = diff;
  }
  return true;
}

/** Clear probe cache -- for tests only. */
export function _resetProbes(): void {
  _probed.clear();
}

/**
 * Characters to test. These are commonly problematic across terminals.
 */
const TEST_CHARS = [
  "\u2764\uFE0F",  // ❤️  heart with VS16
  "\u2764",         // ❤   heart without VS16
  "\u2705",         // ✅  checkmark
  "\u{1F680}",      // 🚀  rocket
  "\u{1F4A9}",      // 💩  pile of poo
  "\u2B50",         // ⭐  star
  "\u{1F1FA}\u{1F1F8}", // 🇺🇸  US flag (regional indicator pair)
  "\u{1F468}\u200D\u{1F4BB}", // 👨‍💻  ZWJ sequence (man technologist)
];

/**
 * Measure the actual rendered width of a string by querying cursor position.
 * Returns null if the terminal doesn't respond or stdin isn't a TTY.
 */
async function measureWidth(ch: string, timeout = 500): Promise<number | null> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { return null; }

  return new Promise<number | null>((resolve) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeout);

    const wasRaw = process.stdin.isRaw;
    if (!wasRaw) { process.stdin.setRawMode(true); }
    process.stdin.resume();

    let buf = "";
    const onData = (data: Buffer) => {
      buf += data.toString();
      // CPR response: ESC [ row ; col R
      const match = buf.match(/\x1b\[(\d+);(\d+)R/);
      if (match) {
        cleanup();
        const col = parseInt(match[2], 10);
        // We moved to column 1, printed the char, so width = col - 1
        resolve(col - 1);
      }
    };

    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      if (!wasRaw) { process.stdin.setRawMode(false); }
    };

    process.stdin.on("data", onData);

    // Move to column 1 of a high row (to avoid visible flicker), print char, query position
    // Use the last row to minimize visibility
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b[${rows};1H${ch}\x1b[6n`);
  });
}

/**
 * Run calibration: measure test characters and record any differences from string-width.
 * Should be called once at startup, before rendering.
 */
export async function calibrateTermWidth(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { return; }

  // Save cursor, do measurements, restore cursor and clear the test line
  const rows = process.stdout.rows || 24;
  process.stdout.write("\x1b[s"); // save cursor

  for (const ch of TEST_CHARS) {
    _probed.add(ch);
    const expected = stringWidth(ch);
    const actual = await measureWidth(ch);
    if (actual !== null && actual !== expected) {
      _overrides.set(ch, actual);
      const diff = actual - expected;
      // If a regional-indicator pair (flag) rendered wider than expected,
      // remember the delta to apply to all flags.
      if (countFlagPairs(ch) === 1 && countZwjs(ch) === 0) {
        _flagPairDelta = diff;
      }
      // If a single-char-plus-VS16 sequence rendered differently than expected,
      // remember the per-VS16 delta to apply to any char+VS16 combination.
      if (ch.length === 2 && ch.charCodeAt(1) === 0xFE0F) {
        _vs16Delta = diff;
      }
      // Note: ZWJ sequences don't need a separate delta. Adding the ZWJ emoji
      // to TEST_CHARS is still useful because it triggers hasOverrides(),
      // which enables the walking mode. In walking mode, each individual emoji
      // in a ZWJ sequence is counted at its own width (with ZWJ at 0), which
      // naturally matches non-composing terminals.
    }
  }

  // Restore cursor and clear the line we used for measurement
  process.stdout.write(`\x1b[${rows};1H\x1b[2K\x1b[u`);
}
