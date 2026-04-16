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

/**
 * Get the measured terminal width of a character, or undefined if not calibrated.
 */
export function getTermWidthOverride(ch: string): number | undefined {
  return _overrides.get(ch);
}

/**
 * True if calibration found any differences from string-width.
 */
export function hasOverrides(): boolean {
  return _overrides.size > 0;
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
    const expected = stringWidth(ch);
    const actual = await measureWidth(ch);
    if (actual !== null && actual !== expected) {
      _overrides.set(ch, actual);
    }
  }

  // Restore cursor and clear the line we used for measurement
  process.stdout.write(`\x1b[${rows};1H\x1b[2K\x1b[u`);
}
