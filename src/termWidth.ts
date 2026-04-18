/**
 * Terminal character width calibration.
 *
 * Measures actual rendered width of test characters by querying the terminal's
 * cursor position (CPR: ESC[6n). Builds a correction map so displayWidth()
 * can account for terminals that disagree with string-width's Unicode tables.
 */

import stringWidth from "string-width";

// Unicode codepoints used by the emoji-width probing logic.
export const ZWJ = 0x200D;            // Zero-width joiner (ZWJ sequences)
export const VS16 = 0xFE0F;           // Variation selector 16 (emoji presentation)
export const KEYCAP = 0x20E3;         // Combining enclosing keycap
export const REGIONAL_FIRST = 0x1F1E6; // Regional Indicator A (start of flag pair range)
export const REGIONAL_LAST = 0x1F1FF;  // Regional Indicator Z
export const SKIN_TONE_FIRST = 0x1F3FB;
export const SKIN_TONE_LAST = 0x1F3FF;

/** True if the codepoint is a Regional Indicator (one half of a flag emoji). */
export function isRegionalIndicator(code: number): boolean {
  return code >= REGIONAL_FIRST && code <= REGIONAL_LAST;
}

/** True if the codepoint is a skin tone modifier (Fitzpatrick 1-2 through 5-6). */
export function isSkinTone(code: number): boolean {
  return code >= SKIN_TONE_FIRST && code <= SKIN_TONE_LAST;
}

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
    if (ch.codePointAt(0) === ZWJ) { count++; }
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
    const isRI = isRegionalIndicator(ch.codePointAt(0)!);
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
 * Record a measurement: if the terminal-rendered width differs from
 * string-width's prediction, store the override and update the pattern
 * deltas (flag-pair, VS16) as appropriate. Returns true if an override
 * was added.
 */
function recordMeasurement(ch: string, actual: number): boolean {
  const expected = stringWidth(ch);
  if (actual === expected) { return false; }
  _overrides.set(ch, actual);
  const diff = actual - expected;
  // If a regional-indicator pair (flag) rendered wider than expected,
  // remember the delta to apply to all flags.
  if (countFlagPairs(ch) === 1 && countZwjs(ch) === 0) {
    _flagPairDelta = diff;
  }
  // If a char+VS16 sequence rendered differently than expected, remember
  // the per-VS16 delta to apply to any char+VS16 combination.
  if (ch.length === 2 && ch.charCodeAt(1) === VS16) {
    _vs16Delta = diff;
  }
  return true;
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
  const actual = await measureWidth(ch, timeout);
  if (actual === null) { return false; }
  return recordMeasurement(ch, actual);
}

/** Clear probe cache -- for tests only. */
export function _resetProbes(): void {
  _probed.clear();
}

/**
 * Return a report of all characters whose terminal width differs from
 * string-width's prediction, suitable for printing as a diagnostic or
 * reporting upstream. Includes the derived deltas.
 */
export function getWidthReport(): {
  overrides: Array<{ char: string; codepoints: string; expected: number; actual: number }>;
  flagPairDelta: number;
  vs16Delta: number;
  daResponse?: string;
  da2Response?: string;
} {
  const overrides = Array.from(_overrides.entries()).map(([ch, actual]) => ({
    char: ch,
    codepoints: [...ch].map(c => "U+" + c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")).join(" "),
    expected: stringWidth(ch),
    actual,
  }));
  return {
    overrides,
    flagPairDelta: _flagPairDelta,
    vs16Delta: _vs16Delta,
    daResponse: _daResponse,
    da2Response: _da2Response,
  };
}

// Cached terminal identification responses
let _daResponse: string | undefined;
let _da2Response: string | undefined;
// Mode 2027 (Terminal Unicode Core): when supported and enabled, the terminal
// uses grapheme-cluster-aware widths (matches Unicode UAX#29), which means
// string-width's predictions should be trustworthy.
let _mode2027Status: "supported" | "unsupported" | "unknown" = "unknown";
let _mode2027Enabled = false;

export function getMode2027Status(): { status: string; enabled: boolean } {
  return { status: _mode2027Status, enabled: _mode2027Enabled };
}

/**
 * Write an escape sequence to the terminal, then read back the response that
 * matches a regex, with timeout. Handles raw-mode / resume / listener cleanup
 * so the calling context (including tests and probes from inside the event
 * loop) is left in the state it was in.
 *
 * Returns the RegExpMatchArray (with capture groups) or null on timeout.
 */
function queryTerminal(
  query: string, matcher: RegExp, timeoutMs: number,
): Promise<RegExpMatchArray | null> {
  return new Promise((resolve) => {
    const wasRaw = process.stdin.isRaw;
    const wasPaused = process.stdin.isPaused();
    // Remember whether anyone else was listening before us, so we know
    // whether we're the only user and can fully release stdin on cleanup.
    const hadListenersBefore = process.stdin.listenerCount("data") > 0;
    if (!wasRaw) { process.stdin.setRawMode(true); }
    process.stdin.resume();

    let buf = "";
    const onData = (data: Buffer) => {
      buf += data.toString();
      const match = buf.match(matcher);
      if (match) { cleanup(); resolve(match); }
    };
    const cleanup = () => {
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      if (!wasRaw) { process.stdin.setRawMode(false); }
      if (wasPaused) { process.stdin.pause(); }
      // If we were the only listener, fully release stdin so the event
      // loop can exit (important in test environments).
      if (!hadListenersBefore) { process.stdin.unref(); }
    };
    const timer = setTimeout(() => { cleanup(); resolve(null); }, timeoutMs);

    process.stdin.on("data", onData);
    process.stdout.write(query);
  });
}

/**
 * Query the terminal's Device Attributes (primary and secondary) to capture
 * identifying information, and probe mode 2027 support. Called during
 * calibration.
 */
async function queryDeviceAttributes(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { return; }

  // Primary DA: ESC[c -> response like ESC[?<params>c
  _daResponse = (await queryTerminal("\x1b[c", /\x1b\[\?[\d;]*c/, 200))?.[0];
  // Secondary DA: ESC[>c -> response like ESC[><model>;<version>;<options>c
  _da2Response = (await queryTerminal("\x1b[>c", /\x1b\[>[\d;]*c/, 200))?.[0];
  // Mode 2027 (Terminal Unicode Core) DECRQM query
  // Response: ESC[?2027;<n>$y where n = 0(not recognized) 1(set) 2(reset) 3(permanently set) 4(permanently reset)
  const m2027 = await queryTerminal("\x1b[?2027$p", /\x1b\[\?2027;(\d+)\$y/, 200);
  if (m2027) {
    const n = parseInt(m2027[1], 10);
    if (n === 1 || n === 2 || n === 3) {
      _mode2027Status = "supported";
      // Enable it so the terminal uses UAX#29 grapheme-cluster widths
      process.stdout.write("\x1b[?2027h");
      _mode2027Enabled = true;
    } else {
      _mode2027Status = "unsupported";
    }
  } else {
    _mode2027Status = "unsupported";
  }
}

/** Disable mode 2027 if we enabled it (call on shutdown). */
export function disableMode2027(): void {
  if (_mode2027Enabled) {
    process.stdout.write("\x1b[?2027l");
    _mode2027Enabled = false;
  }
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
  // Move to column 1 of the bottom row (minimizes visible flicker), print
  // the char, then ask the terminal for the cursor position (CPR: ESC[6n).
  // Response: ESC[row;colR -- width is col - 1 since we started at col 1.
  const rows = process.stdout.rows || 24;
  const match = await queryTerminal(
    `\x1b[${rows};1H${ch}\x1b[6n`,
    /\x1b\[(\d+);(\d+)R/,
    timeout,
  );
  return match ? parseInt(match[2], 10) - 1 : null;
}

/**
 * Run calibration: measure test characters and record any differences from string-width.
 * Should be called once at startup, before rendering.
 */
export async function calibrateTermWidth(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { return; }

  // Query Device Attributes for terminal identification (for diagnostics)
  await queryDeviceAttributes();

  // Save cursor, do measurements, restore cursor and clear the test line
  const rows = process.stdout.rows || 24;
  process.stdout.write("\x1b[s"); // save cursor

  // Note: ZWJ sequences don't need a separate delta. Adding the ZWJ emoji
  // to TEST_CHARS is still useful because any override triggers walking
  // mode in displayWidth, which then counts each emoji at its own width
  // (with ZWJ at 0) -- matching what non-composing terminals actually show.
  for (const ch of TEST_CHARS) {
    _probed.add(ch);
    const actual = await measureWidth(ch);
    if (actual !== null) { recordMeasurement(ch, actual); }
  }

  // Restore cursor and clear the line we used for measurement
  process.stdout.write(`\x1b[${rows};1H\x1b[2K\x1b[u`);
}
