#!/usr/bin/env node

import { Command } from "commander";
import { consoleMain } from "./ConsoleMain";
import { getTheme, getThemeNames } from "./ConsoleTheme";

/**
 * Parse a Grist document URL into server URL and doc ID.
 * Handles URLs like:
 *   https://docs.getgrist.com/docId/slug/p/1
 *   https://server/o/org/doc/docId/p/1
 *   https://server/doc/docId
 *   https://server/docId/slug
 */
function parseGristDocUrl(urlStr: string): { serverUrl: string, docId: string } | null {
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
  return { serverUrl, docId };
}

const program = new Command();
program
  .name("grist-console")
  .description("Terminal UI for viewing and editing Grist documents")
  .argument("<url-or-server>", "Grist document URL, or server URL (with doc-id as second arg)")
  .argument("[doc-id]", "Document ID (when first arg is a server URL)")
  .option("--api-key <key>", "API key (or set GRIST_API_KEY env var)")
  .option("--table <table>", "open this table directly (skip table picker)")
  .option(`--theme <name>`, `color theme (${getThemeNames().join(", ")})`, "default")
  .action(async (urlOrServer: string, docIdArg: string | undefined,
                 options: { apiKey?: string, table?: string, theme?: string }) => {
    const apiKey = options.apiKey || process.env.GRIST_API_KEY;
    let theme;
    try {
      theme = getTheme(options.theme || "default");
    } catch (e: any) {
      console.error(e.message);
      process.exit(1);
    }
    let serverUrl: string;
    let docId: string;
    if (docIdArg) {
      serverUrl = urlOrServer;
      docId = docIdArg;
    } else {
      const parsed = parseGristDocUrl(urlOrServer);
      if (!parsed) {
        console.error("Could not parse document URL. Expected a Grist document URL or use: grist-console <server-url> <doc-id>");
        process.exit(1);
      }
      serverUrl = parsed.serverUrl;
      docId = parsed.docId;
    }
    await consoleMain({ serverUrl, docId, apiKey, table: options.table, theme });
  });

program.parse();
