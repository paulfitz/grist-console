/**
 * Cheap append-only diagnostic trace, used when --verbose is set.
 * Always kept in memory so the post-exit dump can land on stderr after
 * the alt screen restores.
 *
 * If GRIST_CONSOLE_TRACE_FILE is set, also writes synchronously to that path so
 * messages are preserved no matter how the process exits (force quit,
 * uncaught exception, terminal-wipe of stderr, etc).
 */

import { appendFileSync, writeFileSync } from "fs";

let _enabled = false;
let _path: string | null = null;
const _memBuf: string[] = [];

export function enableTrace(): void {
  _enabled = true;
  _path = process.env.GRIST_CONSOLE_TRACE_FILE || null;
  if (_path) {
    // Truncate so each run starts fresh.
    try { writeFileSync(_path, ""); } catch { _path = null; /* best-effort */ }
  }
}

export function trace(msg: string): void {
  if (!_enabled) { return; }
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${msg}`;
  _memBuf.push(line);
  if (_path) {
    try { appendFileSync(_path, line + "\n"); } catch { /* best-effort */ }
  }
}

/** Drain the in-memory buffer (for the post-exit stderr dump). */
export function drainTrace(): string {
  const out = _memBuf.join("\n");
  _memBuf.length = 0;
  return out;
}

export function getTracePath(): string | null { return _path; }
