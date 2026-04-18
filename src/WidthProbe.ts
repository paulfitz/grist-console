/**
 * Background terminal-width probing.
 *
 * As the user navigates the UI, non-ASCII characters visible on screen get
 * scheduled for cursor-position-report measurement. When the terminal's
 * actual rendered width differs from string-width's prediction, an override
 * is stored and the UI re-renders.
 *
 * Input events arriving during a probe are buffered and replayed after the
 * probe completes, with any CPR response bytes stripped out.
 */

import { AppState } from "./ConsoleRenderer.js";
import { BulkColValues, ColumnInfo } from "./types.js";
import { probeChar, hasProbed, getWidthReport, getMode2027Status } from "./termWidth.js";

// Coordination state shared by the main event loop and the probe.
let _probing = false;
const _probingBuffer: Buffer[] = [];
let _probeTimer: ReturnType<typeof setTimeout> | null = null;
let _replayToHandler: ((data: Buffer) => Promise<void>) | null = null;

/** True while a probe is in flight. Input events should be buffered. */
export function isProbing(): boolean {
  return _probing;
}

/** Queue a raw input buffer to be replayed when the current probe finishes. */
export function bufferInput(data: Buffer): void {
  _probingBuffer.push(data);
}

/**
 * Install the handler that buffered input is replayed through after a
 * probe completes. The main event loop sets this once.
 */
export function setReplayHandler(fn: (data: Buffer) => Promise<void>): void {
  _replayToHandler = fn;
}

/**
 * Schedule a probe for unmeasured characters in the current view.
 * Debounced so it only fires when the UI is quiet (~400ms idle).
 */
export function scheduleProbe(state: AppState, doRender: (s: AppState) => void): void {
  if (_probeTimer) { clearTimeout(_probeTimer); }
  _probeTimer = setTimeout(() => runProbe(state, doRender), 400);
}

/**
 * Collect unusual characters from visible data that haven't been probed yet.
 * Extracts full composed units (ZWJ sequences, skin-tone-modified emoji,
 * flag pairs, keycaps, char+VS16) so they can be measured atomically.
 */
function collectUnprobedChars(state: AppState): string[] {
  const seen = new Set<string>();
  const isSkinTone = (code: number) => code >= 0x1F3FB && code <= 0x1F3FF;
  const extract = (s: string) => {
    const cps = [...s];
    for (let i = 0; i < cps.length; i++) {
      const code = cps[i].codePointAt(0)!;
      // Keycap sequences (1 + VS16 + U+20E3) even for ASCII base chars
      if (i + 2 < cps.length
          && cps[i + 1].codePointAt(0) === 0xFE0F
          && cps[i + 2].codePointAt(0) === 0x20E3) {
        const unit = cps[i] + cps[i + 1] + cps[i + 2];
        if (!hasProbed(unit)) { seen.add(unit); }
        i += 2;
        continue;
      }
      if (code < 0x2000) { continue; }

      // Extend over VS16, skin tone modifiers, and ZWJ+following emoji
      let end = i + 1;
      while (end < cps.length) {
        const c = cps[end].codePointAt(0)!;
        if (c === 0xFE0F || isSkinTone(c)) { end++; continue; }
        if (c === 0x200D && end + 1 < cps.length) {
          end += 2;
          while (end < cps.length) {
            const cc = cps[end].codePointAt(0)!;
            if (cc === 0xFE0F || isSkinTone(cc)) { end++; continue; }
            break;
          }
          continue;
        }
        break;
      }
      if (end > i + 1) {
        const unit = cps.slice(i, end).join("");
        if (!hasProbed(unit)) { seen.add(unit); }
        i = end - 1;
        continue;
      }

      // Regional indicator pair (flag)
      if (code >= 0x1F1E6 && code <= 0x1F1FF && i + 1 < cps.length) {
        const nextCode = cps[i + 1].codePointAt(0)!;
        if (nextCode >= 0x1F1E6 && nextCode <= 0x1F1FF) {
          const pair = cps[i] + cps[i + 1];
          if (!hasProbed(pair)) { seen.add(pair); }
          i++;
          continue;
        }
      }
      if (!hasProbed(cps[i])) { seen.add(cps[i]); }
    }
  };
  const collectFrom = (colValues: BulkColValues, rowIds: number[], cols: ColumnInfo[]) => {
    for (const col of cols) {
      const vals = colValues[col.colId];
      if (!vals) { continue; }
      for (let i = 0; i < Math.min(rowIds.length, 100); i++) {
        const v = vals[i];
        if (typeof v !== "string") { continue; }
        extract(v);
      }
    }
  };
  for (const pane of state.panes) {
    collectFrom(pane.colValues, pane.rowIds, pane.columns);
  }
  return [...seen];
}

/**
 * Run a probe batch: measure unprobed characters in the visible data,
 * updating overrides if the terminal disagrees with string-width. If any
 * overrides change, call doRender to refresh the UI.
 */
async function runProbe(state: AppState, doRender: (s: AppState) => void): Promise<void> {
  if (_probing) { return; }
  if (!process.stdin.isTTY || !process.stdout.isTTY) { return; }
  const chars = collectUnprobedChars(state);
  if (chars.length === 0) { return; }

  _probing = true;
  try {
    const batch = chars.slice(0, 5);
    process.stdout.write("\x1b[s"); // save cursor
    let updated = false;
    for (const ch of batch) {
      const changed = await probeChar(ch);
      if (changed) { updated = true; }
    }
    const rows = process.stdout.rows || 24;
    process.stdout.write(`\x1b[${rows};1H\x1b[2K\x1b[u`);

    if (updated) {
      doRender(state);
    }
  } finally {
    _probing = false;
    const buffered = _probingBuffer.splice(0);
    if (_replayToHandler) {
      for (const data of buffered) {
        // Strip any CPR response bytes -- they were for our probe, not user input
        const str = data.toString().replace(/\x1b\[\d+;\d+R/g, "");
        if (str.length > 0) {
          await _replayToHandler(Buffer.from(str));
        }
      }
    }
    if (collectUnprobedChars(state).length > 0) {
      scheduleProbe(state, doRender);
    }
  }
}

/**
 * Print a width-mismatch report to stderr. Called on exit when --verbose.
 * Includes terminal identification (DA / DA2 / env vars), measured
 * overrides, derived deltas, and tmux / mode 2027 guidance.
 */
export function printWidthReport(): void {
  const report = getWidthReport();
  const inTmux = !!process.env.TMUX
    || (process.env.TERM || "").startsWith("screen")
    || (process.env.TERM || "").startsWith("tmux");
  const inScreen = !!process.env.STY;
  process.stderr.write("\n--- Terminal emoji width report ---\n");
  process.stderr.write("Environment:\n");
  for (const key of ["TERM", "COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION",
                     "LC_TERMINAL", "LC_TERMINAL_VERSION", "VTE_VERSION",
                     "KITTY_WINDOW_ID", "WEZTERM_VERSION", "WT_SESSION",
                     "TMUX", "STY"]) {
    if (process.env[key]) {
      process.stderr.write(`  ${key}=${process.env[key]}\n`);
    }
  }
  if (report.daResponse) {
    process.stderr.write(`  DA response: ${report.daResponse.replace(/\x1b/g, "ESC")}\n`);
  }
  if (report.da2Response) {
    process.stderr.write(`  DA2 response: ${report.da2Response.replace(/\x1b/g, "ESC")}\n`);
  }
  const m2027 = getMode2027Status();
  process.stderr.write(`  Mode 2027 (grapheme-cluster widths): ${m2027.status}${m2027.enabled ? " (enabled)" : ""}\n`);

  if (inTmux || inScreen) {
    const mux = inTmux ? "tmux" : "screen";
    process.stderr.write(`\nNOTE: running inside ${mux}. Cursor-position (CPR) responses reflect\n`);
    process.stderr.write(`${mux}'s width calculation, NOT the host terminal's actual rendering.\n`);
    process.stderr.write(`${mux} does not currently speak mode 2027, so width mismatches between\n`);
    process.stderr.write(`${mux} and the host terminal's font can cause visual misalignment that\n`);
    process.stderr.write(`this tool cannot detect or correct.\n`);
    if (inTmux) {
      process.stderr.write(`Options:\n`);
      process.stderr.write(`  * Run outside tmux to let this tool probe the host terminal directly.\n`);
      process.stderr.write(`  * Upgrade to tmux 3.6+ and try these options:\n`);
      process.stderr.write(`      set -g variation-selector-always-wide on\n`);
      process.stderr.write(`      set -g codepoint-widths "U+XXXX=2,..." (for specific problem chars)\n`);
      process.stderr.write(`  * Build tmux with --enable-utf8proc for better Unicode handling.\n`);
    }
  }

  if (report.overrides.length === 0) {
    process.stderr.write("\nNo width mismatches detected.\n");
  } else {
    process.stderr.write(`\n${report.overrides.length} character(s) rendered differently than string-width predicted:\n`);
    for (const o of report.overrides) {
      process.stderr.write(`  ${o.char}  ${o.codepoints}  expected=${o.expected}  actual=${o.actual}\n`);
    }
  }

  if (report.flagPairDelta !== 0) {
    process.stderr.write(`\nFlag pair delta: ${report.flagPairDelta > 0 ? "+" : ""}${report.flagPairDelta} (all flag emoji render ${report.flagPairDelta > 0 ? "wider" : "narrower"} than predicted)\n`);
  }
  if (report.vs16Delta !== 0) {
    process.stderr.write(`VS16 delta: ${report.vs16Delta > 0 ? "+" : ""}${report.vs16Delta} (char+VS16 sequences render ${report.vs16Delta > 0 ? "wider" : "narrower"} than predicted)\n`);
  }
  process.stderr.write("--- end ---\n");
}
