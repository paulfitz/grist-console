/**
 * Standalone runner for the site picker -- the screen the user sees
 * when they pass a Grist site URL with no specific doc. Sets up its own
 * raw-mode stdin loop, calls listSiteDocs, lets the user navigate, and
 * resolves with the picked SiteDoc (or null if they quit). Does not own
 * a WebSocket connection: that comes after, when consoleMain takes over
 * with the chosen docId.
 */

import { ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, HIDE_CURSOR, SHOW_CURSOR } from "./ConsoleDisplay.js";
import { listSiteDocs, SiteDoc } from "./SiteApi.js";
import { AppState, createInitialState } from "./ConsoleAppState.js";
import { Theme } from "./ConsoleTheme.js";
import { handleKeypress } from "./ConsoleInput.js";
import { render } from "./ConsoleRenderer.js";
import { runHyperdrive } from "./HyperdriveTransition.js";
import { trace } from "./Trace.js";

export interface SitePickerOptions {
  serverUrl: string;
  orgSlug: string;
  apiKey?: string;
  theme: Theme;
  /** When true, the caller is managing alt-screen / raw-mode lifecycle
   *  -- runSitePicker only attaches its own data handler and leaves
   *  terminal-mode bytes alone. Avoids the toggle-induced stray-byte
   *  issue when transitioning between picker and consoleMain. */
  persistTerminal?: boolean;
}

export interface SitePickerResult {
  /** The doc the user picked, or null if they quit without picking. */
  pick: SiteDoc | null;
  /** The theme they ended on (may differ from options.theme if they
   *  cycled with T/F12 inside the picker). */
  theme: Theme;
}

/**
 * Run the site picker until the user picks a doc or quits.
 *
 * Throws if listSiteDocs fails (no fallback UI for "couldn't fetch") --
 * the caller surfaces the error.
 */
export async function runSitePicker(options: SitePickerOptions): Promise<SitePickerResult> {
  trace(`SitePicker: enter (server=${options.serverUrl} org=${options.orgSlug} persistTerminal=${!!options.persistTerminal})`);
  let loading = true;
  const docsPromise = listSiteDocs(options.serverUrl, options.orgSlug, options.apiKey)
    .finally(() => { loading = false; });
  // Spin a galaxy-spiral transition in the active theme's colours for as
  // long as the network call takes. No-op on non-TTY (tests).
  await runHyperdrive(options.theme, () => loading);
  let docs: SiteDoc[];
  try {
    docs = await docsPromise;
    trace(`SitePicker: listSiteDocs returned ${docs.length} docs`);
  } catch (e: any) {
    trace(`SitePicker: listSiteDocs threw: ${e.message}`);
    throw e;
  }

  // Build a minimal AppState carrying just what the picker needs.
  const state: AppState = createInitialState("", options.theme);
  state.mode = "site_picker";
  state.siteDocs = docs;
  state.siteCursor = 0;

  const isTty = !!process.stdout.isTTY;
  const manageTerminal = !options.persistTerminal;
  if (isTty && manageTerminal) { process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR); }

  const doRender = () => process.stdout.write(render(state));
  doRender();

  return new Promise<SitePickerResult>((resolve) => {
    if (process.stdin.isTTY && manageTerminal) { process.stdin.setRawMode(true); }
    process.stdin.resume();
    // Ensure stdin keeps the event loop alive while we wait for keys.
    // Startup calibration (termWidth.ts) calls unref() if there were no
    // listeners at the time, and consoleMain's WebSocket -- which is
    // gone by the time we get here on a switch_to_site handoff -- was
    // the only other thing holding the loop open.
    process.stdin.ref();

    const onResize = () => doRender();
    process.stdout.on("resize", onResize);

    const cleanup = (pick: SiteDoc | null) => {
      trace(`SitePicker: cleanup result=${pick ? `pick(${pick.id})` : "null"}`);
      process.stdin.removeListener("data", dataHandler);
      process.stdout.removeListener("resize", onResize);
      if (manageTerminal) {
        if (process.stdin.isTTY) { process.stdin.setRawMode(false); }
        process.stdin.pause();
        if (isTty) { process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN); }
      }
      resolve({ pick, theme: state.theme });
    };

    const dataHandler = (data: Buffer) => {
      const action = handleKeypress(data, state);
      switch (action.type) {
        case "quit":
          cleanup(null);
          return;
        case "select_doc":
          cleanup(state.siteDocs[state.siteCursor] ?? null);
          return;
        case "render":
          doRender();
          return;
        case "view_command_palette":
          state.paletteReturnMode = state.mode;
          state.paletteQuery = "";
          state.paletteCursor = 0;
          state.mode = "command_palette";
          doRender();
          return;
        case "close_command_palette":
          state.mode = state.paletteReturnMode;
          state.paletteQuery = "";
          state.paletteCursor = 0;
          doRender();
          return;
        case "cycle_theme": {
          // Same theme cycle as the rest of the UI; lazy-imported to
          // avoid the renderer-only module pulling theme metadata.
          import("./ConsoleTheme.js").then(({ cycleTheme }) => {
            const next = cycleTheme(state.theme);
            state.theme = next.theme;
            state.statusMessage = `Theme: ${next.name}`;
            doRender();
          });
          return;
        }
        default:
          return;
      }
    };

    process.stdin.on("data", dataHandler);
  });
}
