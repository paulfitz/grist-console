#!/usr/bin/env node

import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { consoleMain } from "./ConsoleMain.js";
import { getTheme, getThemeNames } from "./ConsoleTheme.js";
import { parseGristDocUrl, parseGristSiteUrl } from "./urlParser.js";
import { runSitePicker } from "./SitePicker.js";
import {
  ENTER_ALT_SCREEN, EXIT_ALT_SCREEN, HIDE_CURSOR, SHOW_CURSOR,
  ENABLE_BRACKETED_PASTE, DISABLE_BRACKETED_PASTE,
  ENABLE_EXTENDED_KEYS, DISABLE_EXTENDED_KEYS,
} from "./ConsoleDisplay.js";
import { drainTrace, enableTrace, getTracePath, trace } from "./Trace.js";

const program = new Command();
program
  .name("grist-console")
  .description("Terminal UI for viewing and editing Grist documents")
  .argument("<url-or-server-or-file>", "Grist document URL, server URL, or JSON config file")
  .argument("[doc-id]", "Document ID (when first arg is a server URL)")
  .option("--api-key <key>", "API key (or set GRIST_API_KEY env var)")
  .option("--table <table>", "open this table directly (skip table picker)")
  .option(`--theme <name>`, `color theme (${getThemeNames().join(", ")})`, "default")
  .option("--verbose", "log connection handshake details to stderr")
  .action(async (urlOrServer: string, docIdArg: string | undefined,
                 options: { apiKey?: string, table?: string, theme?: string, verbose?: boolean }) => {
    let apiKey = options.apiKey || process.env.GRIST_API_KEY;
    if (options.verbose) {
      enableTrace();
      // Surface every uncaught error/rejection so we can see it post-exit.
      process.on("uncaughtException", (err) => {
        trace(`uncaughtException: ${err && (err.stack || err.message || err)}`);
      });
      process.on("unhandledRejection", (reason) => {
        trace(`unhandledRejection: ${reason && ((reason as any).stack || (reason as any).message || reason)}`);
      });
    }
    let theme;
    try {
      theme = getTheme(options.theme || "default");
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
    let serverUrl: string;
    let docId: string;
    let pageId: number | undefined;
    let siteContext: { serverUrl: string; orgSlug: string } | undefined;
    if (docIdArg) {
      serverUrl = urlOrServer;
      docId = docIdArg;
    } else if (urlOrServer.endsWith(".json") && existsSync(urlOrServer)) {
      // JSON config file with "doc" (URL) and optional "key" (API key)
      let config: any;
      try {
        config = JSON.parse(readFileSync(urlOrServer, "utf-8"));
      } catch (e: any) {
        console.error(`Failed to read ${urlOrServer}: ${e.message}`);
        process.exit(1);
      }
      if (!config.doc) {
        console.error(`JSON file must have a "doc" field with a Grist document URL.`);
        process.exit(1);
      }
      const parsed = parseGristDocUrl(config.doc);
      if (!parsed) {
        console.error(`Could not parse document URL from ${urlOrServer}: ${config.doc}`);
        process.exit(1);
      }
      serverUrl = parsed.serverUrl;
      docId = parsed.docId;
      pageId = parsed.pageId;
      if (config.key && !options.apiKey) {
        apiKey = config.key;
      }
    } else {
      const parsedDoc = parseGristDocUrl(urlOrServer);
      if (parsedDoc) {
        serverUrl = parsedDoc.serverUrl;
        docId = parsedDoc.docId;
        pageId = parsedDoc.pageId;
      } else {
        // No doc in the URL -- treat as a site URL and let the loop
        // below run the picker. (No API-key gate: some sites are public,
        // e.g. templates.getgrist.com -- if the listing fails, the
        // picker surfaces the error.)
        const parsedSite = parseGristSiteUrl(urlOrServer);
        if (!parsedSite) {
          console.error("Could not parse URL. Expected a Grist document URL, a Grist site URL, a JSON config file, or: grist-console <server-url> <doc-id>");
          process.exit(1);
        }
        siteContext = { serverUrl: parsedSite.serverUrl, orgSlug: parsedSite.orgSlug };
        serverUrl = parsedSite.serverUrl;
        docId = "";
      }
    }
    // Always derive a siteContext if we don't have one yet, so "s" works
    // from inside docs launched directly via doc URL.
    if (!siteContext) {
      const guessFrom = urlOrServer.endsWith(".json") ? `${serverUrl}/` : urlOrServer;
      const parsedSite = parseGristSiteUrl(guessFrom) || parseGristSiteUrl(serverUrl);
      if (parsedSite) {
        siteContext = { serverUrl: parsedSite.serverUrl, orgSlug: parsedSite.orgSlug };
      }
    }

    // Set up terminal state once, for the lifetime of the session.
    // Both runSitePicker and consoleMain run with persistTerminal=true so
    // they don't toggle alt-screen / bracketed-paste / raw-mode under us
    // -- those toggles can provoke the TTY into emitting response bytes
    // that get re-injected as keypresses on the next handler.
    const isTty = !!process.stdout.isTTY;
    if (isTty) {
      process.stdout.write(ENTER_ALT_SCREEN + ENABLE_BRACKETED_PASTE
                           + ENABLE_EXTENDED_KEYS + HIDE_CURSOR);
    }
    if (process.stdin.isTTY) { process.stdin.setRawMode(true); }
    let exited = false;
    const restoreTerminal = () => {
      if (exited) { return; }
      exited = true;
      if (process.stdin.isTTY) { process.stdin.setRawMode(false); }
      process.stdin.pause();
      if (isTty) {
        process.stdout.write(SHOW_CURSOR + DISABLE_EXTENDED_KEYS
                             + DISABLE_BRACKETED_PASTE + EXIT_ALT_SCREEN);
      }
    };
    process.on("exit", restoreTerminal);

    let fatalError: string | null = null;
    try {
      trace(`orchestrator: starting (initial docId=${docId || "(none)"} siteContext=${siteContext ? `${siteContext.serverUrl}/o/${siteContext.orgSlug}` : "(none)"})`);
      // Loop so the user can press "s" inside an open doc to pop back to
      // the site picker and pick a different doc. We carry `theme`
      // forward across phases so theme cycles (F12) persist when the
      // user goes doc → picker → doc.
      while (true) {
        if (!docId) {
          trace(`orchestrator: invoking runSitePicker`);
          let result;
          try {
            result = await runSitePicker({
              ...siteContext!, apiKey, theme, persistTerminal: true,
            });
          } catch (e: any) {
            // listSiteDocs throws user-friendly messages (see SiteApi.ts);
            // no extra prefix needed.
            fatalError = e.message;
            trace(`orchestrator: runSitePicker threw: ${e.message}`);
            return;
          }
          theme = result.theme;
          trace(`orchestrator: runSitePicker returned ${result.pick ? `pick(${result.pick.id})` : "null"}`);
          if (!result.pick) { return; } // user quit without picking
          docId = result.pick.id;
        }
        trace(`orchestrator: invoking consoleMain (docId=${docId})`);
        const result = await consoleMain({
          serverUrl, docId, apiKey, table: options.table, theme, pageId,
          verbose: options.verbose, hasSiteContext: !!siteContext,
          persistTerminal: true,
        });
        theme = result.theme;
        trace(`orchestrator: consoleMain returned kind=${result.kind}`);
        if (result.kind === "quit" || !siteContext) { return; }
        // User asked to switch back to the site picker; clear per-doc
        // state and loop.
        docId = "";
        pageId = undefined;
        // Subsequent doc opens shouldn't auto-route to --table either:
        // the user may pick a doc that doesn't have that table.
        options.table = undefined;
      }
    } finally {
      restoreTerminal();
      // Print any error AFTER the alt screen is gone, otherwise the
      // message gets wiped when the terminal restores its main buffer.
      if (fatalError) {
        console.error(fatalError);
        process.exitCode = 1;
      }
      const dump = drainTrace();
      if (dump) {
        process.stderr.write(dump + "\n");
        const tracePath = getTracePath();
        if (tracePath) { process.stderr.write(`(also saved to ${tracePath})\n`); }
      }
    }
  });

program.parse();
