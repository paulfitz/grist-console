/**
 * Test server management — starts/stops a Grist Docker container for integration tests.
 *
 * Pattern borrowed from grist-help/api/test/helpers.js.
 *
 * Set GRIST_RUNNING=1 to skip container lifecycle (use an externally managed server).
 * Set GRIST_SERVER=http://host:port to point at a custom server (default: http://localhost:8585).
 */

import { execSync } from "child_process";
import http from "http";
import fetch from "node-fetch";
import { ConsoleConnection } from "../src/ConsoleConnection.js";

const GRIST_PORT = Number(process.env.GRIST_PORT || 8585);
const GRIST_IMAGE = process.env.GRIST_IMAGE || "gristlabs/grist";
const CONTAINER_NAME = "grist-console-test";
const API_KEY = "api_key_for_console_test";

export const SERVER_URL = process.env.GRIST_SERVER || `http://localhost:${GRIST_PORT}`;
export { API_KEY };

const AUTH_HEADERS = {
  "Authorization": `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
};

/** POST/PATCH/etc. to the Grist REST API with the support API key. */
async function apiRequest(
  method: string, path: string, body?: any,
): Promise<any> {
  const resp = await fetch(`${SERVER_URL}${path}`, {
    method,
    headers: AUTH_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`${method} ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

/**
 * Start the Grist Docker container.
 */
export function startGrist(): void {
  // Clean up any leftover test container
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
  } catch {
    // Container didn't exist, fine
  }

  console.log("    Starting Grist container...");
  execSync(
    `docker run -d --name ${CONTAINER_NAME} ` +
    `-p ${GRIST_PORT}:8484 ` +
    `-e GRIST_TEST_LOGIN=1 ` +
    `-e GRIST_IN_SERVICE=1 ` +
    `-e TEST_SUPPORT_API_KEY=${API_KEY} ` +
    `${GRIST_IMAGE}`,
    { stdio: "inherit" }
  );
}

/**
 * Stop and remove the Grist Docker container.
 */
export function stopGrist(): void {
  console.log("    Stopping Grist container...");
  try {
    execSync(`docker rm -f ${CONTAINER_NAME}`, { stdio: "ignore" });
  } catch {
    // Ignore errors
  }
}

/**
 * Wait for the Grist server to respond to health-check requests.
 */
export async function waitForGrist(maxAttempts = 60): Promise<void> {
  console.log("    Waiting for Grist to be ready...");
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const resp = await httpGet(`${SERVER_URL}/api/session/access/active`);
      if (resp.status === 200) {
        console.log("    Grist is ready");
        return;
      }
    } catch {
      // Ignore connection errors while waiting
    }
    await sleep(2000);
  }
  throw new Error("Grist did not become ready in time");
}

/**
 * Simple HTTP GET helper (low-level, for health checks).
 */
function httpGet(url: string): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (chunk: Buffer) => data += chunk);
      res.on("end", () => {
        let body;
        try { body = JSON.parse(data); } catch { body = data; }
        resolve({ status: res.statusCode || 0, body });
      });
    }).on("error", reject);
  });
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a workspace + document via the REST API. If `share` is "public",
 * grants editor access to everyone (so WebSocket connects without the
 * support user's session can open the doc).
 */
async function makeTestDoc(
  name: string, share: "public" | "private",
): Promise<{ workspaceId: number; docId: string }> {
  const orgs = await apiRequest("GET", "/api/orgs") as any[];
  const orgId = orgs[0].id;

  const wsName = `console-test${share === "private" ? "-private" : ""}-${Date.now()}`;
  const workspaceId = await apiRequest(
    "POST", `/api/orgs/${orgId}/workspaces`, { name: wsName }
  ) as number;

  const docId = await apiRequest(
    "POST", `/api/workspaces/${workspaceId}/docs`, { name }
  ) as string;

  if (share === "public") {
    await apiRequest("PATCH", `/api/docs/${docId}/access`, {
      delta: { users: { "everyone@getgrist.com": "editors" } },
    });
  }
  return { workspaceId, docId };
}

/** Create a test document accessible to everyone (default for tests). */
export function createTestDoc(name: string) { return makeTestDoc(name, "public"); }

/** Create a test document accessible only via the support API key. */
export function createPrivateTestDoc(name: string) { return makeTestDoc(name, "private"); }

/** Apply user actions to a document via the REST API. */
export function applyUserActions(docId: string, actions: any[]): Promise<any> {
  return apiRequest("POST", `/api/docs/${docId}/apply`, actions);
}

/** Add rows to a table via the REST API. */
export function addRows(
  docId: string, tableId: string, colValues: Record<string, any[]>,
): Promise<any> {
  return apiRequest("POST", `/api/docs/${docId}/tables/${tableId}/data`, colValues);
}

/** Update rows in a table via the REST API. */
export function updateRows(
  docId: string, tableId: string, data: { id: number[] } & Record<string, any[]>,
): Promise<any> {
  return apiRequest("PATCH", `/api/docs/${docId}/tables/${tableId}/data`, data);
}

/**
 * Open a ConsoleConnection, run the body with it, and always close it
 * afterward (even on exceptions). The default auth is the support API key;
 * pass `{ apiKey }` to override or pass undefined for an anonymous connection.
 */
export async function withConnection<T>(
  docId: string,
  body: (conn: ConsoleConnection) => Promise<T>,
  options: { apiKey?: string } = { apiKey: API_KEY },
): Promise<T> {
  const conn = new ConsoleConnection(SERVER_URL, docId, options.apiKey);
  await conn.connect();
  try {
    return await body(conn);
  } finally {
    await conn.close();
  }
}
