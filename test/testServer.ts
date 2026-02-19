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

const GRIST_PORT = Number(process.env.GRIST_PORT || 8585);
const CONTAINER_NAME = "grist-console-test";
const API_KEY = "api_key_for_console_test";

export const SERVER_URL = process.env.GRIST_SERVER || `http://localhost:${GRIST_PORT}`;
export { API_KEY };

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
    `-e TEST_SUPPORT_API_KEY=${API_KEY} ` +
    `gristlabs/grist`,
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
 * Convenience: create a workspace and document via the REST API.
 * Returns { workspaceId, docId }.
 */
export async function createTestDoc(name: string): Promise<{ workspaceId: number; docId: string }> {
  const fetch = (await import("node-fetch")).default;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };

  // List orgs to get the default org
  const orgsResp = await fetch(`${SERVER_URL}/api/orgs`, { headers });
  const orgs = await orgsResp.json() as any[];
  const orgId = orgs[0].id;

  // Create workspace
  const wsResp = await fetch(`${SERVER_URL}/api/orgs/${orgId}/workspaces`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: `console-test-${Date.now()}` }),
  });
  const workspaceId = await wsResp.json() as number;

  // Create document
  const docResp = await fetch(`${SERVER_URL}/api/workspaces/${workspaceId}/docs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name }),
  });
  const docId = await docResp.json() as string;

  // Make the document public so WebSocket connections (which may not carry
  // the support user's session) can open it.
  await fetch(`${SERVER_URL}/api/docs/${docId}/access`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      delta: { users: { "everyone@getgrist.com": "editors" } },
    }),
  });

  return { workspaceId, docId };
}

/**
 * Apply user actions to a document via the REST API.
 */
export async function applyUserActions(docId: string, actions: any[]): Promise<any> {
  const fetch = (await import("node-fetch")).default;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
  const resp = await fetch(`${SERVER_URL}/api/docs/${docId}/apply`, {
    method: "POST",
    headers,
    body: JSON.stringify(actions),
  });
  if (!resp.ok) {
    throw new Error(`applyUserActions failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

/**
 * Add rows to a table via the REST API.
 */
export async function addRows(docId: string, tableId: string, colValues: Record<string, any[]>): Promise<void> {
  const fetch = (await import("node-fetch")).default;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
  const resp = await fetch(`${SERVER_URL}/api/docs/${docId}/tables/${tableId}/data`, {
    method: "POST",
    headers,
    body: JSON.stringify(colValues),
  });
  if (!resp.ok) {
    throw new Error(`addRows failed: ${resp.status} ${await resp.text()}`);
  }
}

/**
 * Update rows in a table via the REST API.
 */
export async function updateRows(
  docId: string, tableId: string, data: { id: number[] } & Record<string, any[]>
): Promise<void> {
  const fetch = (await import("node-fetch")).default;
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
  const resp = await fetch(`${SERVER_URL}/api/docs/${docId}/tables/${tableId}/data`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(data),
  });
  if (!resp.ok) {
    throw new Error(`updateRows failed: ${resp.status} ${await resp.text()}`);
  }
}
