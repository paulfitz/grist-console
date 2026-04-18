import { BulkColValues, ColumnInfo, DocAction, isHiddenCol } from "./types.js";
import { extractFieldsForSection, getColumnInfo, readMetaTable } from "./ConsoleLayout.js";
import WS from "ws";
import fetch from "node-fetch";

export interface TableData {
  tableId: string;
  rowIds: number[];
  columns: ColumnInfo[];
  colValues: BulkColValues;
}

interface GristResponse {
  reqId: number;
  error?: string;
  data?: any;
}

export interface ActionGroup {
  actionNum: number;
  actionHash: string;
  fromSelf: boolean;
  linkId?: number;
  otherId?: number;
  rowIdHint?: number;
  isUndo?: boolean;
}

export type DocActionCallback = (actions: DocAction[], actionGroup?: ActionGroup) => void;

export class ConsoleConnection {
  private _ws: WS | null = null;
  private _reqId: number = 0;
  private _docFD: number = 0;
  private _pending: Map<number, { resolve: (v: GristResponse) => void, reject: (e: Error) => void, timer: ReturnType<typeof setTimeout> }> = new Map();
  private _onDocAction: DocActionCallback | null = null;
  private _onClientConnect: (() => void) | null = null;
  private _serverUrl: string;
  private _docId: string;
  private _apiKey: string | undefined;
  private _verbose: boolean;
  private _metaTables: any = null;

  constructor(serverUrl: string, docId: string, apiKey?: string, options?: { verbose?: boolean }) {
    this._serverUrl = serverUrl.replace(/\/$/, "");
    this._docId = docId;
    this._apiKey = apiKey;
    this._verbose = options?.verbose ?? false;
  }

  private _log(msg: string) {
    if (this._verbose) { console.error(`[grist-console] ${msg}`); }
  }

  public onDocAction(cb: DocActionCallback) {
    this._onDocAction = cb;
  }

  /**
   * Connect to the Grist server via WebSocket.
   * 1. Resolve the doc's org via the API
   * 2. Get a session cookie (only needed when no API key is provided)
   * 3. Resolve the doc worker URL (for multi-server deployments)
   * 4. Open WebSocket with auth (API key header, or cookie for public docs)
   * 5. Wait for clientConnect
   * 6. Send openDoc
   */
  public async connect(): Promise<void> {
    this._log(`server: ${this._serverUrl}`);
    this._log(`docId: ${this._docId}`);
    this._log(`auth: ${this._apiKey ? "api key" : "none (will use session cookie)"}`);

    // Step 1: Get an initial session cookie (only needed without an API key,
    // e.g. for publicly accessible docs)
    const initialCookie = this._apiKey ? "" : await this._getSessionCookie("");
    if (!this._apiKey) {
      this._log(`session cookie: ${initialCookie ? "obtained" : "none"}`);
    }

    // Step 2: Resolve the doc's org (API key or cookie provides auth context)
    const org = await this._getDocOrg(initialCookie);
    const orgPrefix = org ? `/o/${org}` : "";
    this._log(`org: ${org || "(none)"}, docId resolved to: ${this._docId}`);

    // Step 3: Get session cookie with org context (skip when using API key)
    const cookie = this._apiKey ? "" :
      (orgPrefix ? await this._getSessionCookie(orgPrefix) || initialCookie : initialCookie);

    // Step 4: Resolve the doc worker URL (may differ from home server)
    const workerUrl = await this._getDocWorkerUrl(orgPrefix, cookie);
    this._log(`doc worker: ${workerUrl}`);

    // Step 5: Open WebSocket -- API key in Authorization header, or cookie for public docs
    const wsUrl = workerUrl.replace(/^http/, "ws");
    const fullUrl = `${wsUrl}?clientId=console-${Date.now()}&counter=0&newClient=1&browserSettings=${
      encodeURIComponent(JSON.stringify({}))}`;

    const wsHeaders = this._authHeaders(cookie);
    this._log(`websocket: ${wsUrl}`);
    this._log(`headers: ${Object.keys(wsHeaders).join(", ") || "(none)"}`);

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      this._ws = new WS(fullUrl, undefined, {
        headers: wsHeaders,
      });

      this._ws.onmessage = (event: WS.MessageEvent) => {
        this._handleMessage(String(event.data));
      };

      this._ws.onopen = () => {
        this._ws!.onerror = () => {
          // After connect, just log errors
        };
        this._log("websocket: connected");
        if (!settled) { settled = true; resolve(); }
      };

      this._ws.on("error", (err: Error) => {
        if (!settled) {
          settled = true;
          this._log(`websocket error: ${err.message}`);
          reject(new Error(`WebSocket connection failed: ${err.message}`));
        }
      });

      // Capture HTTP-level rejection (e.g. 403, 502) from the upgrade request.
      (this._ws as any).on?.("unexpected-response", (_req: any, res: any) => {
        if (!settled) {
          settled = true;
          this._log(`websocket rejected: HTTP ${res.statusCode}`);
          const hint = (res.statusCode === 403 && !this._apiKey)
            ? "\nTry providing --api-key or setting GRIST_API_KEY." : "";
          reject(new Error(
            `Server rejected connection with HTTP ${res.statusCode}.${hint}`
          ));
        }
      });
    });

    // Step 6: Wait for clientConnect
    await this._waitForClientConnect();
    this._log("clientConnect received");

    // Step 7: Send openDoc
    const result = await this._send("openDoc", this._docId);
    if (result.error) {
      this._log(`openDoc failed: ${result.error}`);
      throw new Error(`Failed to open doc: ${result.error}`);
    }
    this._docFD = result.data?.docFD ?? 0;
    this._metaTables = result.data?.doc;
    this._log("openDoc succeeded");
  }

  /**
   * Get the list of user tables in the document.
   */
  public getTableIds(): string[] {
    const tablesT = readMetaTable(this._metaTables, "_grist_Tables");
    if (!tablesT) { return []; }
    const result: string[] = [];
    for (let i = 0; i < tablesT.ids.length; i++) {
      const tid: string = tablesT.vals.tableId[i];
      if (!tid.startsWith("GristSummary_") && !tid.startsWith("_grist_")) {
        result.push(tid);
      }
    }
    return result;
  }

  /**
   * Expose raw metadata from openDoc for layout extraction.
   */
  public getMetaTables(): any {
    return this._metaTables;
  }

  /**
   * Get ordered columns for a section, using field ordering from _grist_Views_section_field.
   * Filters out hidden columns.
   */
  public getColumnsForSection(sectionId: number): ColumnInfo[] {
    if (!this._metaTables) { return []; }
    const fields = extractFieldsForSection(this._metaTables, sectionId);
    const columns: ColumnInfo[] = [];
    for (const field of fields) {
      const col = getColumnInfo(this._metaTables, field.colRef);
      if (col && !isHiddenCol(col.colId)) {
        columns.push(col);
      }
    }
    return columns;
  }

  /**
   * Fetch table data and column metadata for a given table.
   */
  public async fetchTable(tableId: string): Promise<TableData> {
    const columns = this._getColumnsForTable(tableId);
    const result = await this._send("fetchTable", this._docFD, tableId);
    if (result.error) {
      throw new Error(`Failed to fetch table ${tableId}: ${result.error}`);
    }
    const tableData = result.data.tableData;
    // tableData is ["TableData", tableId, [rowIds], {colId: [values]}]
    const rowIds: number[] = tableData[2];
    const colValues: BulkColValues = tableData[3];
    return { tableId, rowIds, columns, colValues };
  }

  /**
   * Apply a user action (edit, add, delete).
   */
  public async applyUserActions(actions: any[]): Promise<any> {
    const result = await this._send("applyUserActions", this._docFD, actions);
    if (result.error) {
      throw new Error(`Failed to apply actions: ${result.error}`);
    }
    return result.data;
  }

  /**
   * Apply undo/redo by referencing specific historical actions.
   * Mirrors the web client's undo stack behavior.
   */
  public async applyUserActionsById(
    actionNums: number[], actionHashes: string[], undo: boolean,
    options?: { otherId?: number },
  ): Promise<any> {
    const result = await this._send(
      "applyUserActionsById", this._docFD, actionNums, actionHashes, undo, options || {},
    );
    if (result.error) {
      throw new Error(`Failed to ${undo ? "undo" : "redo"}: ${result.error}`);
    }
    return result.data;
  }

  /**
   * Close the document and disconnect immediately.
   */
  public async close(): Promise<void> {
    // Clear all pending request timers so they don't keep the event loop alive
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer);
    }
    this._pending.clear();
    if (this._ws) {
      this._ws.terminate();
      this._ws = null;
    }
  }

  private _getColumnsForTable(tableId: string): ColumnInfo[] {
    const tablesT = readMetaTable(this._metaTables, "_grist_Tables");
    const colsT = readMetaTable(this._metaTables, "_grist_Tables_column");
    if (!tablesT || !colsT) { return []; }

    // Find the table's ref
    const tableRef = tablesT.ids[(tablesT.vals.tableId as string[]).indexOf(tableId)];
    if (tableRef === undefined) { return []; }

    // Collect column refs whose parent is this table, then resolve each
    // through the shared getColumnInfo helper for consistent parsing.
    const columns: ColumnInfo[] = [];
    for (let i = 0; i < colsT.ids.length; i++) {
      if (colsT.vals.parentId[i] !== tableRef) { continue; }
      const info = getColumnInfo(this._metaTables, colsT.ids[i]);
      if (info && !isHiddenCol(info.colId)) {
        columns.push(info);
      }
    }
    return columns;
  }

  private _authHeaders(cookie?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this._apiKey) { headers.Authorization = `Bearer ${this._apiKey}`; }
    if (cookie) { headers.Cookie = cookie; }
    return headers;
  }

  /**
   * Resolve the doc's org, and also resolve urlId to full docId if needed.
   */
  private async _getDocOrg(cookie?: string): Promise<string> {
    const resp = await fetch(
      `${this._serverUrl}/api/docs/${this._docId}`, { headers: this._authHeaders(cookie) }
    );
    if (resp.ok) {
      const doc = await resp.json() as any;
      // Resolve urlId -> full docId
      if (doc.id && doc.id !== this._docId) {
        this._docId = doc.id;
      }
      if (doc.workspace?.org?.domain) {
        return doc.workspace.org.domain;
      }
    }
    return "docs";
  }

  /**
   * Resolve the doc worker URL for this document. On multi-server deployments
   * (like hosted Grist), WebSocket connections go to a specific worker, not the
   * home server. On single-server installs, this returns the home server URL
   * with a self-prefix for version tagging.
   *
   * The returned URL includes org context (either in the path or already
   * present in the worker URL).
   */
  private async _getDocWorkerUrl(orgPrefix: string, cookie: string): Promise<string> {
    // Call /api/worker/ without org prefix -- the endpoint doesn't need
    // org context, and using one that doesn't match the domain causes a 400.
    const workerApiUrl = `${this._serverUrl}/api/worker/${this._docId}`;
    try {
      this._log(`worker request: ${workerApiUrl}`);
      const resp = await fetch(workerApiUrl, { headers: this._authHeaders(cookie) });
      if (!resp.ok) {
        const body = await resp.text();
        this._log(`worker response: ${resp.status} ${body}`);
      }
      if (resp.ok) {
        const info = await resp.json() as any;
        if (info.docWorkerUrl) {
          // Multi-server: use the dedicated worker URL, add org context
          let url = info.docWorkerUrl.replace(/\/$/, "");
          if (orgPrefix && !url.includes("/o/")) {
            url += orgPrefix;
          }
          return url;
        }
        if (info.selfPrefix) {
          // Single-server: use home URL with self-prefix, add org context
          const url = new URL(this._serverUrl);
          url.pathname = info.selfPrefix + orgPrefix + url.pathname;
          return url.href.replace(/\/$/, "");
        }
        this._log(`worker response had no docWorkerUrl or selfPrefix`);
      }
    } catch (e: any) {
      this._log(`worker request failed: ${e.message}`);
    }
    // Fallback: connect directly to the home server with org prefix
    this._log(`falling back to home server for websocket`);
    return `${this._serverUrl}${orgPrefix}`;
  }

  private async _getSessionCookie(orgPrefix: string): Promise<string> {
    const headers = this._authHeaders();
    try {
      const resp = await fetch(`${this._serverUrl}${orgPrefix}/api/session/access/active`, {
        headers,
        redirect: "manual",
      });
      const setCookie = resp.headers.get("set-cookie");
      if (setCookie) { return setCookie.split(";")[0]; }
      const resp2 = await fetch(`${this._serverUrl}${orgPrefix}/api/orgs`, { headers });
      const setCookie2 = resp2.headers.get("set-cookie");
      if (setCookie2) { return setCookie2.split(";")[0]; }
    } catch {
      // Fall through
    }
    return "";
  }

  private _waitForClientConnect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout waiting for clientConnect")), 10000);
      this._onClientConnect = () => {
        clearTimeout(timeout);
        this._onClientConnect = null;
        resolve();
      };
    });
  }

  private _handleMessage(data: string): void {
    const msg = JSON.parse(data);
    if (msg.reqId !== undefined && this._pending.has(msg.reqId)) {
      const p = this._pending.get(msg.reqId)!;
      clearTimeout(p.timer);
      this._pending.delete(msg.reqId);
      p.resolve(msg);
      return;
    }
    if (msg.type === "clientConnect" && this._onClientConnect) {
      this._onClientConnect();
      return;
    }
    if (msg.type === "docUserAction" && msg.data?.docActions) {
      if (this._onDocAction) {
        this._onDocAction(msg.data.docActions as DocAction[], msg.data.actionGroup);
      }
    }
  }

  private _send(method: string, ...args: any[]): Promise<GristResponse> {
    return new Promise((resolve, reject) => {
      if (!this._ws) {
        reject(new Error("Not connected"));
        return;
      }
      this._reqId++;
      const reqId = this._reqId;
      const timer = setTimeout(() => {
        if (this._pending.has(reqId)) {
          this._pending.delete(reqId);
          reject(new Error(`Timeout on request ${method}`));
        }
      }, 30000);
      this._pending.set(reqId, { resolve, reject, timer });
      const req = { reqId, method, args };
      this._ws.send(JSON.stringify(req));
    });
  }
}
