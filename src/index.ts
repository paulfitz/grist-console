#!/usr/bin/env node

import { Command } from "commander";
import { existsSync, readFileSync } from "fs";
import { consoleMain } from "./ConsoleMain.js";
import { getTheme, getThemeNames } from "./ConsoleTheme.js";

/**
 * Parse a Grist document URL into server URL and doc ID.
 * Handles URLs like:
 *   https://docs.getgrist.com/docId/slug/p/1
 *   https://server/o/org/doc/docId/p/1
 *   https://server/doc/docId
 *   https://server/docId/slug
 */
export function parseGristDocUrl(urlStr: string): { serverUrl: string, docId: string, pageId?: number } | null {
  let url: URL;
  try {
    url = new URL(urlStr);
  } catch {
    return null;
  }
  const parts = url.pathname.slice(1).split("/");
  // Strip /o/org prefix if present
  let startIdx = 0;
  if (parts[0] === "o" && parts.length > 1) {
    startIdx = 2;
  }
  const rest = parts.slice(startIdx);
  let docId: string | undefined;
  // /doc/<docId>/... form
  if (rest[0] === "doc" && rest.length > 1) {
    docId = rest[1];
  }
  // /docs/<docId>/... form (API style)
  else if (rest[0] === "docs" && rest.length > 1) {
    docId = rest[1];
  }
  // /<docId>/slug/... form (when docId is long enough)
  else if (rest[0] && rest[0].length >= 12) {
    docId = rest[0];
  }
  if (!docId) { return null; }
  // Strip fork/snapshot suffixes to get the base doc ID
  docId = docId.split("~")[0];
  const serverUrl = `${url.protocol}//${url.host}`;
  // Extract page ID from /p/<pageId> suffix
  let pageId: number | undefined;
  const pIdx = rest.indexOf("p");
  if (pIdx >= 0 && pIdx + 1 < rest.length) {
    const parsed = parseInt(rest[pIdx + 1], 10);
    if (!isNaN(parsed)) { pageId = parsed; }
  }
  return { serverUrl, docId, pageId };
}

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
      const parsed = parseGristDocUrl(urlOrServer);
      if (!parsed) {
        console.error("Could not parse document URL. Expected a Grist document URL, JSON config file, or: grist-console <server-url> <doc-id>");
        process.exit(1);
      }
      serverUrl = parsed.serverUrl;
      docId = parsed.docId;
      pageId = parsed.pageId;
    }
    await consoleMain({ serverUrl, docId, apiKey, table: options.table, theme, pageId, verbose: options.verbose });
  });

// Only run CLI when executed directly (not when imported for testing)
const isMain = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/index.js");
if (isMain) {
  program.parse();
}
