/**
 * Integration tests for ConsoleConnection against a real Grist server.
 *
 * These tests require a running Grist instance (started by hooks.ts via Docker,
 * or set GRIST_RUNNING=1 for an external server).
 */

import { assert } from "chai";
import { ConsoleConnection } from "../src/ConsoleConnection.js";
import {
  extractPages, extractSectionsForView, extractFiltersForSection,
  getLayoutSpecForView, parseLayoutSpec, computeLayout, Rect,
} from "../src/ConsoleLayout.js";
import { applySortSpec, applySectionFilters } from "../src/LinkingState.js";
import { appendRowToColValues } from "../src/ActionDispatcher.js";
import { computeInsertManualSort } from "../src/ConsoleInput.js";

function defaultVal(colType: string): any {
  const base = colType.split(":")[0];
  switch (base) {
    case "Bool": return false;
    case "Int": case "Numeric": case "ManualSortPos": return 0;
    case "Text": case "Choice": return "";
    default: return null;
  }
}
import { PaneState } from "../src/ConsoleAppState.js";
import { BulkColValues, DocAction } from "../src/types.js";
import {
  SERVER_URL, API_KEY,
  createTestDoc, createPrivateTestDoc, applyUserActions, addRows, updateRows,
} from "./testServer.js";

describe("ConsoleConnection (integration)", function() {
  this.timeout(30000);

  let docId: string;

  before(async function() {
    // Create a test document with a typed table and seed data
    const result = await createTestDoc("console-integration-test");
    docId = result.docId;

    await applyUserActions(docId, [
      ["AddTable", "People", [
        { id: "Name", type: "Text", isFormula: false, formula: "" },
        { id: "Age", type: "Int", isFormula: false, formula: "" },
      ]],
    ]);
    await addRows(docId, "People", {
      Name: ["Alice", "Bob", "Charlie"],
      Age: [30, 25, 35],
    });
  });

  it("connects via WebSocket and fetches table list", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const tableIds = conn.getTableIds();
      assert.include(tableIds, "People");
      assert.include(tableIds, "Table1");
    } finally {
      await conn.close();
    }
  });

  it("fetches table data with column metadata", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const data = await conn.fetchTable("People");
      assert.equal(data.tableId, "People");
      assert.equal(data.rowIds.length, 3);

      const colIds = data.columns.map((c: { colId: string }) => c.colId);
      assert.include(colIds, "Name");
      assert.include(colIds, "Age");

      const nameCol = data.columns.find((c: { colId: string }) => c.colId === "Name")!;
      assert.equal(nameCol.type, "Text");
      const ageCol = data.columns.find((c: { colId: string }) => c.colId === "Age")!;
      assert.equal(ageCol.type, "Int");

      assert.deepEqual(data.colValues.Name, ["Alice", "Bob", "Charlie"]);
      assert.deepEqual(data.colValues.Age, [30, 25, 35]);
    } finally {
      await conn.close();
    }
  });

  it("applies cell edit via applyUserActions", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      await conn.applyUserActions([
        ["UpdateRecord", "People", 1, { Name: "Alicia" }],
      ]);
      const data = await conn.fetchTable("People");
      assert.equal(data.colValues.Name[0], "Alicia");
    } finally {
      // Restore original
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
      await conn.close();
    }
  });

  it("adds a row and receives the new data", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      await conn.applyUserActions([
        ["AddRecord", "People", null, { Name: "Diana", Age: 28 }],
      ]);
      const data = await conn.fetchTable("People");
      assert.include(data.colValues.Name as string[], "Diana");
    } finally {
      // Clean up the added row
      const conn2 = new ConsoleConnection(SERVER_URL, docId, API_KEY);
      await conn2.connect();
      const data = await conn2.fetchTable("People");
      const idx = (data.colValues.Name as string[]).indexOf("Diana");
      if (idx >= 0) {
        await conn2.applyUserActions([
          ["RemoveRecord", "People", data.rowIds[idx]],
        ]);
      }
      await conn2.close();
      await conn.close();
    }
  });

  /**
   * Helper: run an edit and return the action group metadata, by listening for
   * the next non-undo fromSelf broadcast after the edit.
   */
  async function editAndCaptureAg(
    conn: ConsoleConnection,
    actions: any[],
  ): Promise<{ actionNum: number; actionHash: string }> {
    const agPromise = new Promise<{ actionNum: number; actionHash: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout waiting for actionGroup")), 3000);
      conn.onDocAction((_actions, ag) => {
        if (ag && ag.fromSelf && !ag.isUndo) {
          clearTimeout(timer);
          resolve({ actionNum: ag.actionNum, actionHash: ag.actionHash });
        }
      });
    });
    await conn.applyUserActions(actions);
    return agPromise;
  }

  async function getName(conn: ConsoleConnection, rowId: number): Promise<any> {
    const data = await conn.fetchTable("People");
    const idx = data.rowIds.indexOf(rowId);
    return data.colValues.Name[idx];
  }

  it("undoes and redoes via applyUserActionsById", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const ag = await editAndCaptureAg(conn, [["UpdateRecord", "People", 1, { Name: "UndoMe" }]]);

      assert.equal(await getName(conn, 1), "UndoMe");
      await conn.applyUserActionsById([ag.actionNum], [ag.actionHash], true, { otherId: ag.actionNum });
      assert.equal(await getName(conn, 1), "Alice");
      await conn.applyUserActionsById([ag.actionNum], [ag.actionHash], false, { otherId: ag.actionNum });
      assert.equal(await getName(conn, 1), "UndoMe");
    } finally {
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
      await conn.close();
    }
  });

  it("undoes multiple edits in reverse order", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const ag1 = await editAndCaptureAg(conn, [["UpdateRecord", "People", 1, { Name: "First" }]]);
      const ag2 = await editAndCaptureAg(conn, [["UpdateRecord", "People", 1, { Name: "Second" }]]);
      const ag3 = await editAndCaptureAg(conn, [["UpdateRecord", "People", 1, { Name: "Third" }]]);
      assert.equal(await getName(conn, 1), "Third");

      // Undo most recent first
      await conn.applyUserActionsById([ag3.actionNum], [ag3.actionHash], true, { otherId: ag3.actionNum });
      assert.equal(await getName(conn, 1), "Second");
      await conn.applyUserActionsById([ag2.actionNum], [ag2.actionHash], true, { otherId: ag2.actionNum });
      assert.equal(await getName(conn, 1), "First");
      await conn.applyUserActionsById([ag1.actionNum], [ag1.actionHash], true, { otherId: ag1.actionNum });
      assert.equal(await getName(conn, 1), "Alice");
    } finally {
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
      await conn.close();
    }
  });

  it("redoes multiple undos in forward order", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const ag1 = await editAndCaptureAg(conn, [["UpdateRecord", "People", 1, { Name: "First" }]]);
      const ag2 = await editAndCaptureAg(conn, [["UpdateRecord", "People", 1, { Name: "Second" }]]);

      // Undo both
      await conn.applyUserActionsById([ag2.actionNum], [ag2.actionHash], true, { otherId: ag2.actionNum });
      await conn.applyUserActionsById([ag1.actionNum], [ag1.actionHash], true, { otherId: ag1.actionNum });
      assert.equal(await getName(conn, 1), "Alice");

      // Redo in original order
      await conn.applyUserActionsById([ag1.actionNum], [ag1.actionHash], false, { otherId: ag1.actionNum });
      assert.equal(await getName(conn, 1), "First");
      await conn.applyUserActionsById([ag2.actionNum], [ag2.actionHash], false, { otherId: ag2.actionNum });
      assert.equal(await getName(conn, 1), "Second");
    } finally {
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
      await conn.close();
    }
  });

  it("undo, redo, undo, redo alternation converges", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const ag = await editAndCaptureAg(conn, [["UpdateRecord", "People", 1, { Name: "ToggleMe" }]]);
      assert.equal(await getName(conn, 1), "ToggleMe");

      for (let i = 0; i < 3; i++) {
        await conn.applyUserActionsById([ag.actionNum], [ag.actionHash], true, { otherId: ag.actionNum });
        assert.equal(await getName(conn, 1), "Alice", `after undo ${i + 1}`);
        await conn.applyUserActionsById([ag.actionNum], [ag.actionHash], false, { otherId: ag.actionNum });
        assert.equal(await getName(conn, 1), "ToggleMe", `after redo ${i + 1}`);
      }
    } finally {
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
      await conn.close();
    }
  });

  it("adding a row at top in a manualSort view stays at top after reload", async function() {
    // Cursor at row 0 (visible top). `a` passes the cursor row's manualSort
    // to AddRecord; the server's position algorithm places the new row
    // just before it. After reload, the new row should be at the top.
    const { docId: testDocId } = await createTestDoc("add-at-top-test");
    await applyUserActions(testDocId, [
      ["AddTable", "Things", [
        { id: "Label", type: "Text", isFormula: false, formula: "" },
      ]],
    ]);
    await addRows(testDocId, "Things", { Label: ["Alpha", "Bravo", "Charlie"] });

    const conn1 = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn1.connect();
    const initialData = await conn1.fetchTable("Things");

    // Sort initial data by manualSort so row 0 corresponds to the visible top
    const indices = initialData.rowIds.map((_, i) => i);
    indices.sort((a, b) =>
      (initialData.colValues.manualSort[a] as number) - (initialData.colValues.manualSort[b] as number)
    );
    const sortedManualSort = indices.map(i => initialData.colValues.manualSort[i]);

    // Compute insert hint = cursor (row 0) manualSort value
    const insertMS = computeInsertManualSort(sortedManualSort, 0, sortedManualSort.length);
    assert.equal(insertMS, sortedManualSort[0], "Hint should equal reference row's manualSort");

    await conn1.applyUserActions([
      ["AddRecord", "Things", null, { Label: "TopInsert", manualSort: insertMS }],
    ]);
    await conn1.close();

    // Reload and verify order
    const conn2 = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn2.connect();
    const reloaded = await conn2.fetchTable("Things");
    const reloadIdx = reloaded.rowIds.map((_, i) => i);
    reloadIdx.sort((a, b) =>
      (reloaded.colValues.manualSort[a] as number) - (reloaded.colValues.manualSort[b] as number)
    );
    const orderedLabels = reloadIdx.map(i => reloaded.colValues.Label[i]);
    assert.deepEqual(orderedLabels, ["TopInsert", "Alpha", "Bravo", "Charlie"]);

    await conn2.close();
  });

  it("adding a row in the middle inserts above cursor row", async function() {
    const { docId: testDocId } = await createTestDoc("add-middle-test");
    await applyUserActions(testDocId, [
      ["AddTable", "Things", [
        { id: "Label", type: "Text", isFormula: false, formula: "" },
      ]],
    ]);
    await addRows(testDocId, "Things", { Label: ["A", "B", "C", "D"] });

    const conn = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn.connect();
    const initialData = await conn.fetchTable("Things");

    const indices = initialData.rowIds.map((_, i) => i);
    indices.sort((a, b) =>
      (initialData.colValues.manualSort[a] as number) - (initialData.colValues.manualSort[b] as number)
    );
    const sortedManualSort = indices.map(i => initialData.colValues.manualSort[i]);

    // Cursor on row 2 (label "C"). Pass C's manualSort as hint.
    const insertMS = computeInsertManualSort(sortedManualSort, 2, sortedManualSort.length);
    assert.equal(insertMS, sortedManualSort[2]);

    await conn.applyUserActions([
      ["AddRecord", "Things", null, { Label: "MidInsert", manualSort: insertMS }],
    ]);
    await conn.close();

    const conn2 = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn2.connect();
    const reloaded = await conn2.fetchTable("Things");
    const reloadIdx = reloaded.rowIds.map((_, i) => i);
    reloadIdx.sort((a, b) =>
      (reloaded.colValues.manualSort[a] as number) - (reloaded.colValues.manualSort[b] as number)
    );
    const orderedLabels = reloadIdx.map(i => reloaded.colValues.Label[i]);
    // Server inserts just before row 2 ("C"), so: A B MidInsert C D
    assert.deepEqual(orderedLabels, ["A", "B", "MidInsert", "C", "D"]);
    await conn2.close();
  });

  it("deletes a row", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      // Add then delete a temporary row
      await conn.applyUserActions([
        ["AddRecord", "People", null, { Name: "Temp", Age: 99 }],
      ]);
      let data = await conn.fetchTable("People");
      const tempIdx = (data.colValues.Name as string[]).indexOf("Temp");
      assert.isAtLeast(tempIdx, 0, "Temp row should exist");
      const tempRowId = data.rowIds[tempIdx];

      await conn.applyUserActions([
        ["RemoveRecord", "People", tempRowId],
      ]);
      data = await conn.fetchTable("People");
      assert.notInclude(data.colValues.Name as string[], "Temp");
    } finally {
      await conn.close();
    }
  });

  it("receives live updates from another client's edits", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();

      // Set up a promise to capture the next docAction
      const actionPromise = new Promise<DocAction[]>((resolve) => {
        conn.onDocAction((actions: DocAction[]) => {
          resolve(actions);
        });
      });

      // Make an edit via the REST API (simulating another client)
      await updateRows(docId, "People", { id: [2], Name: ["Bobby"] });

      // Wait for the broadcast
      const actions = await actionPromise;
      assert.isArray(actions);
      assert.isAbove(actions.length, 0);
      const updateAction = actions.find(
        (a: any) => (a[0] === "UpdateRecord" || a[0] === "BulkUpdateRecord") && a[1] === "People"
      );
      assert.isOk(updateAction, "Should receive an update action for People table");
    } finally {
      await updateRows(docId, "People", { id: [2], Name: ["Bob"] });
      await conn.close();
    }
  });

  it("two WebSocket clients see each other's changes", async function() {
    const conn1 = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    const conn2 = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn1.connect();
      await conn2.connect();

      // Set up conn2 to listen for updates
      const actionPromise = new Promise<DocAction[]>((resolve) => {
        conn2.onDocAction((actions: DocAction[]) => {
          resolve(actions);
        });
      });

      // conn1 makes an edit
      await conn1.applyUserActions([
        ["UpdateRecord", "People", 3, { Name: "Chuck" }],
      ]);

      // conn2 should receive the broadcast
      const actions = await actionPromise;
      const updateAction = actions.find(
        (a: any) => (a[0] === "UpdateRecord" || a[0] === "BulkUpdateRecord") && a[1] === "People"
      );
      assert.isOk(updateAction, "conn2 should see the edit from conn1");
    } finally {
      await updateRows(docId, "People", { id: [3], Name: ["Charlie"] });
      await conn1.close();
      await conn2.close();
    }
  });

  it("connects to a public doc without an API key", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId);
    try {
      await conn.connect();
      const tableIds = conn.getTableIds();
      assert.include(tableIds, "People");
      const data = await conn.fetchTable("People");
      assert.deepEqual(data.colValues.Name, ["Alice", "Bob", "Charlie"]);
    } finally {
      await conn.close();
    }
  });

  it("connects to a private doc with an API key", async function() {
    const { docId: privateDocId } = await createPrivateTestDoc("private-test");
    await applyUserActions(privateDocId, [
      ["AddTable", "Secrets", [
        { id: "Code", type: "Text", isFormula: false, formula: "" },
      ]],
    ]);
    await addRows(privateDocId, "Secrets", { Code: ["alpha", "bravo"] });

    // Should work with API key
    const conn = new ConsoleConnection(SERVER_URL, privateDocId, API_KEY);
    try {
      await conn.connect();
      const data = await conn.fetchTable("Secrets");
      assert.deepEqual(data.colValues.Code, ["alpha", "bravo"]);
    } finally {
      await conn.close();
    }

    // Should fail without API key
    const conn2 = new ConsoleConnection(SERVER_URL, privateDocId);
    try {
      await conn2.connect();
      assert.fail("Should have thrown for private doc without API key");
    } catch (err: any) {
      assert.match(err.message, /403|access|denied|rejected/i);
    } finally {
      await conn2.close();
    }
  });

  it("exposes metadata via getMetaTables", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const meta = conn.getMetaTables();
      assert.isOk(meta);
      assert.isOk(meta._grist_Tables);
      assert.isOk(meta._grist_Pages);
      assert.isOk(meta._grist_Views);
      assert.isOk(meta._grist_Views_section);
    } finally {
      await conn.close();
    }
  });

  it("extracts pages from real metadata", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const pages = extractPages(conn.getMetaTables());
      assert.isAbove(pages.length, 0);
      const pageNames = pages.map(p => p.name);
      assert.isOk(pageNames.some(n => n.includes("People") || n.includes("Table1")),
        "Should find at least one page");
    } finally {
      await conn.close();
    }
  });

  it("extracts sections for a view", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const pages = extractPages(conn.getMetaTables());
      assert.isAbove(pages.length, 0);
      const sections = extractSectionsForView(conn.getMetaTables(), pages[0].viewId);
      assert.isAbove(sections.length, 0);
      for (const sec of sections) {
        assert.isOk(sec.tableId);
        assert.isAbove(sec.sectionId, 0);
      }
    } finally {
      await conn.close();
    }
  });

  it("computes correct layout direction from real multi-section view", async function() {
    // Create a new view with two side-by-side sections
    const r1 = await applyUserActions(docId, [
      ["CreateViewSection", 1, 0, "record", null, null],
    ]);
    const newViewId: number = r1.retValues[0].viewRef;

    // Read metadata to find People table ref
    let conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    await conn.connect();
    let meta = conn.getMetaTables();

    const tablesData = meta._grist_Tables;
    const tids: string[] = tablesData[3].tableId;
    const trefs: number[] = tablesData[2];
    let peopleTableRef = 0;
    for (let i = 0; i < tids.length; i++) {
      if (tids[i] === "People") { peopleTableRef = trefs[i]; break; }
    }
    assert.isAbove(peopleTableRef, 0, "People table should exist");
    await conn.close();

    // Add second section to the same view
    const r2 = await applyUserActions(docId, [
      ["CreateViewSection", peopleTableRef, newViewId, "record", null, null],
    ]);
    const section1Ref: number = r1.retValues[0].sectionRef;
    const section2Ref: number = r2.retValues[0].sectionRef;

    // Set the layoutSpec to a typical Grist side-by-side layout
    const sideBySpec = JSON.stringify({
      children: [
        { children: [{ leaf: section1Ref }, { leaf: section2Ref }] },
      ],
    });
    await applyUserActions(docId, [
      ["UpdateRecord", "_grist_Views", newViewId, { layoutSpec: sideBySpec }],
    ]);

    // Re-connect to get fresh metadata
    conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    await conn.connect();
    meta = conn.getMetaTables();

    const sections = extractSectionsForView(meta, newViewId);
    assert.equal(sections.length, 2, "View should have 2 record sections");

    const layoutSpec = getLayoutSpecForView(meta, newViewId);
    assert.isOk(layoutSpec, "View should have a layoutSpec");

    const sectionIds = sections.map(s => s.sectionId);
    const sectionIdToPaneIndex = new Map<number, number>();
    sectionIds.forEach((id, i) => sectionIdToPaneIndex.set(id, i));

    const boxSpec = parseLayoutSpec(layoutSpec, sectionIds);
    const rect: Rect = { top: 0, left: 0, width: 120, height: 40 };
    const layout = computeLayout(boxSpec, rect, sectionIdToPaneIndex);

    assert.isOk(layout.children, `Layout should have children. BoxSpec: ${JSON.stringify(boxSpec)}`);
    assert.equal(layout.children!.length, 2, "Should have 2 child panes");
    assert.equal(layout.direction, "horizontal",
      `Expected horizontal split but got ${layout.direction}. BoxSpec: ${JSON.stringify(boxSpec)}`);

    assert.equal(layout.children![0].top, layout.children![1].top);
    assert.isBelow(layout.children![0].left, layout.children![1].left);

    const w0 = layout.children![0].width;
    const w1 = layout.children![1].width;
    assert.equal(w0 + 1 + w1, 120, "Widths + border should equal total width");

    await conn.close();
  });

  it("computes vertical layout for stacked sections", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    await conn.connect();

    const meta = conn.getMetaTables();
    const pages = extractPages(meta);
    const peoplePage = pages.find(p => p.name.includes("People"));
    assert.isOk(peoplePage);
    const sections = extractSectionsForView(meta, peoplePage!.viewId);
    assert.isAbove(sections.length, 0);

    const sectionIds = sections.map(s => s.sectionId);
    const boxSpec = parseLayoutSpec(undefined, sectionIds);
    const sectionIdToPaneIndex = new Map<number, number>();
    sectionIds.forEach((id, i) => sectionIdToPaneIndex.set(id, i));

    if (sectionIds.length === 1) {
      const rect: Rect = { top: 0, left: 0, width: 80, height: 24 };
      const layout = computeLayout(boxSpec, rect, sectionIdToPaneIndex);
      assert.equal(layout.width, 80);
      assert.equal(layout.height, 24);
      assert.equal(layout.paneIndex, 0);
    }

    // Test with a manually stacked layout (2 sections vertical)
    const stackedSpec = { children: [{ leaf: 100 }, { leaf: 200 }] };
    const stackMap = new Map([[100, 0], [200, 1]]);
    const rect: Rect = { top: 0, left: 0, width: 80, height: 41 };
    const layout = computeLayout(stackedSpec, rect, stackMap);
    assert.equal(layout.direction, "vertical",
      "Direct children of root should be vertical");
    assert.equal(layout.children![0].left, layout.children![1].left,
      "Stacked children should have same left");
    assert.isBelow(layout.children![0].top, layout.children![1].top,
      "First child should be above second");

    await conn.close();
  });

  it("gets columns for a section using field ordering", async function() {
    const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
    try {
      await conn.connect();
      const pages = extractPages(conn.getMetaTables());
      const peoplePage = pages.find(p => p.name.includes("People"));
      assert.isOk(peoplePage, "Should find People page");
      const sections = extractSectionsForView(conn.getMetaTables(), peoplePage!.viewId);
      assert.isAbove(sections.length, 0);
      const cols = conn.getColumnsForSection(sections[0].sectionId);
      assert.isAbove(cols.length, 0);
      const colIds = cols.map(c => c.colId);
      assert.include(colIds, "Name");
      assert.include(colIds, "Age");
    } finally {
      await conn.close();
    }
  });

  // Helper: build a PaneState from fetched data + section metadata
  function buildPane(
    sectionInfo: any,
    columns: Array<{ colId: string; type: string; label: string }>,
    rowIds: number[],
    colValues: BulkColValues,
  ): PaneState {
    return {
      sectionInfo,
      columns,
      rowIds: [...rowIds],
      allRowIds: [...rowIds],
      colValues: Object.fromEntries(Object.entries(colValues).map(([k, v]) => [k, [...v]])),
      allColValues: Object.fromEntries(Object.entries(colValues).map(([k, v]) => [k, [...v]])),
      cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
    };
  }

  describe("sorting with real metadata", function() {
    it("sorts a section by Name ascending", async function() {
      // Find the People section and set sortColRefs on it
      const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
      try {
        await conn.connect();
        const meta = conn.getMetaTables();
        const pages = extractPages(meta);
        const peoplePage = pages.find(p => p.name.includes("People"))!;
        const sections = extractSectionsForView(meta, peoplePage.viewId);
        const sec = sections[0];

        // Find the Name column ref
        const colData = meta._grist_Tables_column;
        const colIds: string[] = colData[3].colId;
        const colRefs: number[] = colData[2];
        const parentIds: number[] = colData[3].parentId;
        let nameColRef = 0;
        for (let i = 0; i < colIds.length; i++) {
          if (colIds[i] === "Name" && parentIds[i] === sec.tableRef) {
            nameColRef = colRefs[i];
            break;
          }
        }
        assert.isAbove(nameColRef, 0, "Should find Name column ref");

        // Set sort on the section
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sec.sectionId,
           { sortColRefs: JSON.stringify([nameColRef]) }],
        ]);

        // Reconnect to get fresh metadata
        await conn.close();
        const conn2 = new ConsoleConnection(SERVER_URL, docId, API_KEY);
        await conn2.connect();
        const meta2 = conn2.getMetaTables();
        const sections2 = extractSectionsForView(meta2, peoplePage.viewId);
        const sec2 = sections2[0];
        assert.isOk(sec2.sortColRefs, "Section should have sortColRefs set");

        // Build a pane from the fetched data
        const data = await conn2.fetchTable("People");
        const columns = conn2.getColumnsForSection(sec2.sectionId);
        const pane = buildPane(sec2, columns, data.rowIds, data.colValues);

        // Apply sorting
        applySortSpec(pane, sec2.sortColRefs, meta2);
        assert.deepEqual(pane.colValues.Name, ["Alice", "Bob", "Charlie"]);

        // Clean up: remove sort
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sec.sectionId,
           { sortColRefs: "" }],
        ]);
        await conn2.close();
      } catch (e) {
        await conn.close().catch(() => {});
        throw e;
      }
    });

    it("sorts descending by Age", async function() {
      const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
      try {
        await conn.connect();
        const meta = conn.getMetaTables();
        const pages = extractPages(meta);
        const peoplePage = pages.find(p => p.name.includes("People"))!;
        const sections = extractSectionsForView(meta, peoplePage.viewId);
        const sec = sections[0];

        // Find Age colRef
        const colData = meta._grist_Tables_column;
        const colIds: string[] = colData[3].colId;
        const colRefs: number[] = colData[2];
        const parentIds: number[] = colData[3].parentId;
        let ageColRef = 0;
        for (let i = 0; i < colIds.length; i++) {
          if (colIds[i] === "Age" && parentIds[i] === sec.tableRef) {
            ageColRef = colRefs[i];
            break;
          }
        }

        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sec.sectionId,
           { sortColRefs: JSON.stringify([-ageColRef]) }],
        ]);

        await conn.close();
        const conn2 = new ConsoleConnection(SERVER_URL, docId, API_KEY);
        await conn2.connect();
        const meta2 = conn2.getMetaTables();
        const sections2 = extractSectionsForView(meta2, peoplePage.viewId);
        const sec2 = sections2[0];

        const data = await conn2.fetchTable("People");
        const columns = conn2.getColumnsForSection(sec2.sectionId);
        const pane = buildPane(sec2, columns, data.rowIds, data.colValues);

        applySortSpec(pane, sec2.sortColRefs, meta2);
        assert.deepEqual(pane.colValues.Age, [35, 30, 25]);
        assert.deepEqual(pane.colValues.Name, ["Charlie", "Alice", "Bob"]);

        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sec.sectionId,
           { sortColRefs: "" }],
        ]);
        await conn2.close();
      } catch (e) {
        await conn.close().catch(() => {});
        throw e;
      }
    });

    it("sorting is stable after adding a row", async function() {
      const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
      try {
        await conn.connect();
        const meta = conn.getMetaTables();
        const pages = extractPages(meta);
        const peoplePage = pages.find(p => p.name.includes("People"))!;
        const sections = extractSectionsForView(meta, peoplePage.viewId);
        const sec = sections[0];

        // Find Name colRef
        const colData = meta._grist_Tables_column;
        const colIds: string[] = colData[3].colId;
        const colRefs: number[] = colData[2];
        const parentIds: number[] = colData[3].parentId;
        let nameColRef = 0;
        for (let i = 0; i < colIds.length; i++) {
          if (colIds[i] === "Name" && parentIds[i] === sec.tableRef) {
            nameColRef = colRefs[i];
            break;
          }
        }

        // Set sort by Name ascending
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sec.sectionId,
           { sortColRefs: JSON.stringify([nameColRef]) }],
        ]);

        // Add a row
        await addRows(docId, "People", { Name: ["Aaron"], Age: [20] });

        await conn.close();
        const conn2 = new ConsoleConnection(SERVER_URL, docId, API_KEY);
        await conn2.connect();
        const meta2 = conn2.getMetaTables();
        const sections2 = extractSectionsForView(meta2, peoplePage.viewId);
        const sec2 = sections2[0];

        const data = await conn2.fetchTable("People");
        const columns = conn2.getColumnsForSection(sec2.sectionId);
        const pane = buildPane(sec2, columns, data.rowIds, data.colValues);

        // Apply sort -- Aaron should appear first
        applySortSpec(pane, sec2.sortColRefs, meta2);
        assert.deepEqual(pane.colValues.Name, ["Aaron", "Alice", "Bob", "Charlie"]);

        // Simulate what happens when a row is added to an already-sorted pane:
        // the new row lands at the end of allRowIds, then reapplySortAndFilter
        // should put it in the right place.
        const pane2 = buildPane(sec2, columns, data.rowIds, data.colValues);
        applySortSpec(pane2, sec2.sortColRefs, meta2);
        // Now simulate adding "Abe" to the *all* data (as applyDocActionToPane would)
        const newRowId = 999;
        pane2.allRowIds.push(newRowId);
        for (const col of columns) {
          if (!pane2.allColValues[col.colId]) { pane2.allColValues[col.colId] = []; }
        }
        pane2.allColValues.Name.push("Abe");
        pane2.allColValues.Age.push(18);
        // Rebuild visible from all, then re-sort (as reapplySortAndFilter does)
        pane2.rowIds = [...pane2.allRowIds];
        pane2.colValues = Object.fromEntries(
          Object.entries(pane2.allColValues).map(([k, v]) => [k, [...v]])
        );
        applySortSpec(pane2, sec2.sortColRefs, meta2);
        assert.deepEqual(
          pane2.colValues.Name,
          ["Aaron", "Abe", "Alice", "Bob", "Charlie"],
          "New row should be sorted into correct position"
        );

        // Clean up
        // Remove Aaron
        const aaronIdx = (data.colValues.Name as string[]).indexOf("Aaron");
        if (aaronIdx >= 0) {
          await applyUserActions(docId, [
            ["RemoveRecord", "People", data.rowIds[aaronIdx]],
          ]);
        }
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sec.sectionId,
           { sortColRefs: "" }],
        ]);
        await conn2.close();
      } catch (e) {
        await conn.close().catch(() => {});
        throw e;
      }
    });
  });

  it("new row has correct Bool default and is visible after sort/filter", async function() {
    // Create a doc with a Bool column and a filter that includes only false
    const { docId: testDocId } = await createTestDoc("sort-filter-add-test");
    await applyUserActions(testDocId, [
      ["AddTable", "Items", [
        { id: "Label", type: "Text", isFormula: false, formula: "" },
        { id: "Done", type: "Bool", isFormula: false, formula: "" },
      ]],
    ]);
    await addRows(testDocId, "Items", {
      Label: ["First", "Second"],
      Done: [false, false],
    });

    // Find the section and column refs
    let conn = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn.connect();
    let meta = conn.getMetaTables();
    const pages = extractPages(meta);
    const page = pages.find(p => p.name.includes("Items"))!;
    const sections = extractSectionsForView(meta, page.viewId);
    const sec = sections[0];

    const colData = meta._grist_Tables_column;
    const colIds: string[] = colData[3].colId;
    const colRefs: number[] = colData[2];
    const parentIds: number[] = colData[3].parentId;
    let labelColRef = 0, doneColRef = 0;
    for (let i = 0; i < colIds.length; i++) {
      if (parentIds[i] !== sec.tableRef) { continue; }
      if (colIds[i] === "Label") { labelColRef = colRefs[i]; }
      if (colIds[i] === "Done") { doneColRef = colRefs[i]; }
    }

    // Sort by Label ascending, filter Done == false (include only false)
    await applyUserActions(testDocId, [
      ["UpdateRecord", "_grist_Views_section", sec.sectionId,
       { sortColRefs: JSON.stringify([labelColRef]) }],
      ["AddRecord", "_grist_Filters", null, {
        viewSectionRef: sec.sectionId,
        colRef: doneColRef,
        filter: JSON.stringify({ included: [false] }),
        pinned: true,
      }],
    ]);
    await conn.close();

    // Reconnect, fetch data, build pane
    conn = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn.connect();
    meta = conn.getMetaTables();
    const sec2 = extractSectionsForView(meta, page.viewId)[0];
    let data = await conn.fetchTable("Items");
    const columns = conn.getColumnsForSection(sec2.sectionId);

    // Verify Bool values come as actual booleans
    assert.strictEqual(data.colValues.Done[0], false, "Bool should be false not 0");

    let pane = buildPane(sec2, columns, data.rowIds, data.colValues);
    applySectionFilters(pane, sec2.sectionId, meta);
    applySortSpec(pane, sec2.sortColRefs, meta);
    assert.deepEqual(pane.colValues.Label, ["First", "Second"]);
    assert.equal(pane.rowIds.length, 2);

    // Add a new row via the connection (as the TUI would)
    await conn.applyUserActions([
      ["AddRecord", "Items", null, { Label: "Third" }],
    ]);

    // Re-fetch and verify the new row appears
    data = await conn.fetchTable("Items");
    pane = buildPane(sec2, columns, data.rowIds, data.colValues);
    applySectionFilters(pane, sec2.sectionId, meta);
    applySortSpec(pane, sec2.sortColRefs, meta);
    assert.include(pane.colValues.Label as string[], "Third",
      "New row should be visible after filter+sort");
    assert.deepEqual(pane.colValues.Label, ["First", "Second", "Third"],
      "Rows should be sorted alphabetically");

    await conn.close();
  });

  it("new row is visible via live update with sort and filter", async function() {
    const { docId: testDocId } = await createTestDoc("live-add-test");
    await applyUserActions(testDocId, [
      ["AddTable", "Items", [
        { id: "Label", type: "Text", isFormula: false, formula: "" },
        { id: "Done", type: "Bool", isFormula: false, formula: "" },
      ]],
    ]);
    await addRows(testDocId, "Items", {
      Label: ["Bravo", "Alpha"],
      Done: [false, false],
    });

    let conn = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn.connect();
    let meta = conn.getMetaTables();
    const pages = extractPages(meta);
    const page = pages.find(p => p.name.includes("Items"))!;
    const sec = extractSectionsForView(meta, page.viewId)[0];

    const colData = meta._grist_Tables_column;
    const colIds: string[] = colData[3].colId;
    const colRefs: number[] = colData[2];
    const parentIds: number[] = colData[3].parentId;
    let labelColRef = 0, doneColRef = 0;
    for (let i = 0; i < colIds.length; i++) {
      if (parentIds[i] !== sec.tableRef) { continue; }
      if (colIds[i] === "Label") { labelColRef = colRefs[i]; }
      if (colIds[i] === "Done") { doneColRef = colRefs[i]; }
    }

    await applyUserActions(testDocId, [
      ["UpdateRecord", "_grist_Views_section", sec.sectionId,
       { sortColRefs: JSON.stringify([labelColRef]) }],
      ["AddRecord", "_grist_Filters", null, {
        viewSectionRef: sec.sectionId,
        colRef: doneColRef,
        filter: JSON.stringify({ included: [false] }),
        pinned: true,
      }],
    ]);
    await conn.close();

    // Reconnect with fresh metadata
    conn = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn.connect();
    meta = conn.getMetaTables();
    const sec2 = extractSectionsForView(meta, page.viewId)[0];
    const columns = conn.getColumnsForSection(sec2.sectionId);
    const data = await conn.fetchTable("Items");

    // Build pane as ConsoleMain.loadPage would
    const pane = buildPane(sec2, columns, data.rowIds, data.colValues);

    // Initial sort+filter
    applySectionFilters(pane, sec2.sectionId, meta);
    applySortSpec(pane, sec2.sortColRefs, meta);
    assert.deepEqual(pane.colValues.Label, ["Alpha", "Bravo"]);

    // Listen for live update when we add a row from another client
    const actionPromise = new Promise<DocAction[]>((resolve) => {
      conn.onDocAction(resolve);
    });

    // Add row via REST API (simulates another client)
    await addRows(testDocId, "Items", { Label: ["Charlie"], Done: [false] });
    const actions = await actionPromise;

    // Apply the DocAction to the pane (as applyDocActionToPane does)
    for (const action of actions) {
      const actionType = action[0];
      if (actionType === "AddRecord" || actionType === "BulkAddRecord") {
        if (actionType === "BulkAddRecord") {
          const [, , rowIds, colValues] = action as any;
          for (let i = 0; i < rowIds.length; i++) {
            pane.allRowIds.push(rowIds[i]);
            for (const col of columns) {
              if (!pane.allColValues[col.colId]) { pane.allColValues[col.colId] = []; }
              const vals = colValues[col.colId];
              pane.allColValues[col.colId].push(vals ? vals[i] : null);
            }
          }
        } else {
          const [, , rowId, colValues] = action as any;
          pane.allRowIds.push(rowId);
          for (const col of columns) {
            if (!pane.allColValues[col.colId]) { pane.allColValues[col.colId] = []; }
            pane.allColValues[col.colId].push(colValues[col.colId] ?? null);
          }
        }
      }
    }

    // Now reapply sort+filter from all* (as reapplySortAndFilter does)
    pane.rowIds = [...pane.allRowIds];
    pane.colValues = Object.fromEntries(
      Object.entries(pane.allColValues).map(([k, v]) => [k, [...v]])
    );
    applySectionFilters(pane, sec2.sectionId, meta);
    applySortSpec(pane, sec2.sortColRefs, meta);

    // The new row should be visible and sorted
    assert.include(pane.colValues.Label as string[], "Charlie",
      "New row from live update should be visible after sort+filter");
    assert.deepEqual(pane.colValues.Label, ["Alpha", "Bravo", "Charlie"]);

    await conn.close();
  });

  it("AddRecord with empty colValues uses column-type defaults for filtering", async function() {
    const { docId: testDocId } = await createTestDoc("action-defaults-test");
    await applyUserActions(testDocId, [
      ["AddTable", "Items", [
        { id: "Label", type: "Text", isFormula: false, formula: "" },
        { id: "Done", type: "Bool", isFormula: false, formula: "" },
      ]],
    ]);
    await addRows(testDocId, "Items", { Label: ["First"], Done: [false] });

    let conn = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn.connect();
    let meta = conn.getMetaTables();
    const pages = extractPages(meta);
    const page = pages.find(p => p.name.includes("Items"))!;
    const sec = extractSectionsForView(meta, page.viewId)[0];

    const colData = meta._grist_Tables_column;
    const colIds: string[] = colData[3].colId;
    const colRefs: number[] = colData[2];
    const parentIds: number[] = colData[3].parentId;
    let doneColRef = 0;
    for (let i = 0; i < colIds.length; i++) {
      if (parentIds[i] === sec.tableRef && colIds[i] === "Done") {
        doneColRef = colRefs[i]; break;
      }
    }

    // Filter: include only Done=false
    await applyUserActions(testDocId, [
      ["AddRecord", "_grist_Filters", null, {
        viewSectionRef: sec.sectionId,
        colRef: doneColRef,
        filter: JSON.stringify({ included: [false] }),
        pinned: true,
      }],
    ]);
    await conn.close();

    conn = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
    await conn.connect();
    meta = conn.getMetaTables();
    const sec2 = extractSectionsForView(meta, page.viewId)[0];
    const columns = conn.getColumnsForSection(sec2.sectionId);
    const data = await conn.fetchTable("Items");

    // Build pane, apply filter -- should show "First"
    const pane = buildPane(sec2, columns, data.rowIds, data.colValues);
    applySectionFilters(pane, sec2.sectionId, meta);
    assert.deepEqual(pane.colValues.Label, ["First"]);

    // Now simulate a live AddRecord with empty colValues (as the server sends)
    const newRowId = 999;
    pane.allRowIds.push(newRowId);
    for (const col of columns) {
      if (!pane.allColValues[col.colId]) { pane.allColValues[col.colId] = []; }
      // Server sends {"manualSort": 1} -- no Done, no Label
      const actionColValues: Record<string, any> = { manualSort: 1 };
      pane.allColValues[col.colId].push(actionColValues[col.colId] ?? defaultVal(col.type));
    }

    // Rebuild visible and filter
    pane.rowIds = [...pane.allRowIds];
    pane.colValues = Object.fromEntries(
      Object.entries(pane.allColValues).map(([k, v]) => [k, [...v]])
    );
    applySectionFilters(pane, sec2.sectionId, meta);

    // New row should be visible because Done defaults to false, which passes the filter
    assert.equal(pane.rowIds.length, 2,
      "New row with default Bool=false should pass the inclusion filter");

    await conn.close();
  });

  describe("filtering with real metadata", function() {
    it("filters a section with inclusion filter", async function() {
      const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
      try {
        await conn.connect();
        const meta = conn.getMetaTables();
        const pages = extractPages(meta);
        const peoplePage = pages.find(p => p.name.includes("People"))!;
        const sections = extractSectionsForView(meta, peoplePage.viewId);
        const sec = sections[0];

        // Find Name colRef
        const colData = meta._grist_Tables_column;
        const colIds: string[] = colData[3].colId;
        const colRefs: number[] = colData[2];
        const parentIds: number[] = colData[3].parentId;
        let nameColRef = 0;
        for (let i = 0; i < colIds.length; i++) {
          if (colIds[i] === "Name" && parentIds[i] === sec.tableRef) {
            nameColRef = colRefs[i];
            break;
          }
        }

        // Add a filter: include only Alice and Charlie
        await applyUserActions(docId, [
          ["AddRecord", "_grist_Filters", null, {
            viewSectionRef: sec.sectionId,
            colRef: nameColRef,
            filter: JSON.stringify({ included: ["Alice", "Charlie"] }),
            pinned: true,
          }],
        ]);

        await conn.close();
        const conn2 = new ConsoleConnection(SERVER_URL, docId, API_KEY);
        await conn2.connect();
        const meta2 = conn2.getMetaTables();
        const sections2 = extractSectionsForView(meta2, peoplePage.viewId);
        const sec2 = sections2[0];

        const data = await conn2.fetchTable("People");
        const columns = conn2.getColumnsForSection(sec2.sectionId);
        const pane = buildPane(sec2, columns, data.rowIds, data.colValues);

        applySectionFilters(pane, sec2.sectionId, meta2);
        assert.deepEqual(pane.colValues.Name, ["Alice", "Charlie"]);

        // Clean up: remove the filter
        const filterData = meta2._grist_Filters;
        if (filterData) {
          const filterIds: number[] = filterData[2];
          const filterVals = filterData[3];
          for (let i = 0; i < filterIds.length; i++) {
            if (filterVals.viewSectionRef[i] === sec2.sectionId) {
              await applyUserActions(docId, [
                ["RemoveRecord", "_grist_Filters", filterIds[i]],
              ]);
            }
          }
        }
        await conn2.close();
      } catch (e) {
        await conn.close().catch(() => {});
        throw e;
      }
    });

    it("filters with range filter on Age", async function() {
      const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
      try {
        await conn.connect();
        const meta = conn.getMetaTables();
        const pages = extractPages(meta);
        const peoplePage = pages.find(p => p.name.includes("People"))!;
        const sections = extractSectionsForView(meta, peoplePage.viewId);
        const sec = sections[0];

        // Find Age colRef
        const colData = meta._grist_Tables_column;
        const colIds: string[] = colData[3].colId;
        const colRefs: number[] = colData[2];
        const parentIds: number[] = colData[3].parentId;
        let ageColRef = 0;
        for (let i = 0; i < colIds.length; i++) {
          if (colIds[i] === "Age" && parentIds[i] === sec.tableRef) {
            ageColRef = colRefs[i];
            break;
          }
        }

        // Add a range filter: Age >= 28
        await applyUserActions(docId, [
          ["AddRecord", "_grist_Filters", null, {
            viewSectionRef: sec.sectionId,
            colRef: ageColRef,
            filter: JSON.stringify({ min: 28 }),
            pinned: true,
          }],
        ]);

        await conn.close();
        const conn2 = new ConsoleConnection(SERVER_URL, docId, API_KEY);
        await conn2.connect();
        const meta2 = conn2.getMetaTables();
        const sections2 = extractSectionsForView(meta2, peoplePage.viewId);
        const sec2 = sections2[0];

        const data = await conn2.fetchTable("People");
        const columns = conn2.getColumnsForSection(sec2.sectionId);
        const pane = buildPane(sec2, columns, data.rowIds, data.colValues);

        applySectionFilters(pane, sec2.sectionId, meta2);
        // Bob (25) should be excluded, Alice (30) and Charlie (35) remain
        assert.deepEqual(pane.colValues.Name, ["Alice", "Charlie"]);
        assert.deepEqual(pane.colValues.Age, [30, 35]);

        // Clean up
        const filterData = meta2._grist_Filters;
        if (filterData) {
          const filterIds: number[] = filterData[2];
          const filterVals = filterData[3];
          for (let i = 0; i < filterIds.length; i++) {
            if (filterVals.viewSectionRef[i] === sec2.sectionId) {
              await applyUserActions(docId, [
                ["RemoveRecord", "_grist_Filters", filterIds[i]],
              ]);
            }
          }
        }
        await conn2.close();
      } catch (e) {
        await conn.close().catch(() => {});
        throw e;
      }
    });

    it("combined sort and filter", async function() {
      const conn = new ConsoleConnection(SERVER_URL, docId, API_KEY);
      try {
        await conn.connect();
        const meta = conn.getMetaTables();
        const pages = extractPages(meta);
        const peoplePage = pages.find(p => p.name.includes("People"))!;
        const sections = extractSectionsForView(meta, peoplePage.viewId);
        const sec = sections[0];

        const colData = meta._grist_Tables_column;
        const colIds: string[] = colData[3].colId;
        const colRefs: number[] = colData[2];
        const parentIds: number[] = colData[3].parentId;
        let nameColRef = 0, ageColRef = 0;
        for (let i = 0; i < colIds.length; i++) {
          if (parentIds[i] !== sec.tableRef) { continue; }
          if (colIds[i] === "Name") { nameColRef = colRefs[i]; }
          if (colIds[i] === "Age") { ageColRef = colRefs[i]; }
        }

        // Sort by Name descending, filter Age >= 28
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sec.sectionId,
           { sortColRefs: JSON.stringify([-nameColRef]) }],
          ["AddRecord", "_grist_Filters", null, {
            viewSectionRef: sec.sectionId,
            colRef: ageColRef,
            filter: JSON.stringify({ min: 28 }),
            pinned: true,
          }],
        ]);

        await conn.close();
        const conn2 = new ConsoleConnection(SERVER_URL, docId, API_KEY);
        await conn2.connect();
        const meta2 = conn2.getMetaTables();
        const sections2 = extractSectionsForView(meta2, peoplePage.viewId);
        const sec2 = sections2[0];

        const data = await conn2.fetchTable("People");
        const columns = conn2.getColumnsForSection(sec2.sectionId);
        const pane = buildPane(sec2, columns, data.rowIds, data.colValues);

        // Filter first, then sort (as reapplySortAndFilter does)
        applySectionFilters(pane, sec2.sectionId, meta2);
        applySortSpec(pane, sec2.sortColRefs, meta2);

        // Bob (25) filtered out, remaining sorted desc by Name: Charlie, Alice
        assert.deepEqual(pane.colValues.Name, ["Charlie", "Alice"]);
        assert.deepEqual(pane.colValues.Age, [35, 30]);

        // Clean up
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sec.sectionId,
           { sortColRefs: "" }],
        ]);
        const filterData = meta2._grist_Filters;
        if (filterData) {
          const filterIds: number[] = filterData[2];
          const filterVals = filterData[3];
          for (let i = 0; i < filterIds.length; i++) {
            if (filterVals.viewSectionRef[i] === sec2.sectionId) {
              await applyUserActions(docId, [
                ["RemoveRecord", "_grist_Filters", filterIds[i]],
              ]);
            }
          }
        }
        await conn2.close();
      } catch (e) {
        await conn.close().catch(() => {});
        throw e;
      }
    });
  });

  describe("RefList section linking", function() {
    it("filters by RefList column containing source row ID", async function() {
      // Set up: Dates table and ToDo table with RefList:Dates linking
      const { docId: testDocId } = await createTestDoc("reflist-link-test");
      await applyUserActions(testDocId, [
        ["AddTable", "Dates", [
          { id: "Label", type: "Text", isFormula: false, formula: "" },
        ]],
        ["AddTable", "ToDo", [
          { id: "Task", type: "Text", isFormula: false, formula: "" },
          { id: "DateRefs", type: "RefList:Dates", isFormula: false, formula: "" },
        ]],
      ]);
      // Add date rows
      await addRows(testDocId, "Dates", { Label: ["Mon", "Tue", "Wed"] });
      // Add todo rows with RefList references
      // Row 1: linked to Dates row 1 (Mon)
      // Row 2: linked to Dates rows 1 and 2 (Mon, Tue)
      // Row 3: linked to Dates row 2 (Tue)
      // Row 4: no dates
      await addRows(testDocId, "ToDo", {
        Task: ["Task A", "Task B", "Task C", "Task D"],
        DateRefs: [["L", 1], ["L", 1, 2], ["L", 2], null],
      });

      const conn = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
      await conn.connect();
      const meta = conn.getMetaTables();

      // Find sections and column refs
      const pages = extractPages(meta);
      const datesPage = pages.find(p => p.name.includes("Dates"));
      assert.isOk(datesPage);
      const datesSections = extractSectionsForView(meta, datesPage!.viewId);
      const datesSec = datesSections[0];

      const todoPage = pages.find(p => p.name.includes("ToDo"));
      assert.isOk(todoPage);
      const todoSections = extractSectionsForView(meta, todoPage!.viewId);
      const todoSec = todoSections[0];

      // Find DateRefs colRef
      const colData = meta._grist_Tables_column;
      const colIds: string[] = colData[3].colId;
      const colRefs: number[] = colData[2];
      const parentIdVals: number[] = colData[3].parentId;
      let dateRefsColRef = 0;
      for (let i = 0; i < colIds.length; i++) {
        if (colIds[i] === "DateRefs" && parentIdVals[i] === todoSec.tableRef) {
          dateRefsColRef = colRefs[i];
          break;
        }
      }
      assert.isAbove(dateRefsColRef, 0);

      // Create a new page with both sections, link ToDo to Dates via DateRefs
      const r = await applyUserActions(testDocId, [
        ["CreateViewSection", datesSec.tableRef, 0, "record", null, null],
      ]);
      const newViewId = r.retValues[0].viewRef;
      const datesNewSecRef = r.retValues[0].sectionRef;
      const r2 = await applyUserActions(testDocId, [
        ["CreateViewSection", todoSec.tableRef, newViewId, "record", null, null],
      ]);
      const todoNewSecRef = r2.retValues[0].sectionRef;

      // Set linking: ToDo section links to Dates section via DateRefs
      await applyUserActions(testDocId, [
        ["UpdateRecord", "_grist_Views_section", todoNewSecRef, {
          linkSrcSectionRef: datesNewSecRef,
          linkSrcColRef: 0,
          linkTargetColRef: dateRefsColRef,
        }],
      ]);

      await conn.close();

      // Reconnect with fresh metadata
      const conn2 = new ConsoleConnection(SERVER_URL, testDocId, API_KEY);
      await conn2.connect();
      const meta2 = conn2.getMetaTables();
      const newSections = extractSectionsForView(meta2, newViewId);
      assert.equal(newSections.length, 2);

      const datesSecInfo = newSections.find(s => s.sectionId === datesNewSecRef)!;
      const todoSecInfo = newSections.find(s => s.sectionId === todoNewSecRef)!;

      // Fetch data
      const datesData = await conn2.fetchTable("Dates");
      const todoData = await conn2.fetchTable("ToDo");
      const datesColumns = conn2.getColumnsForSection(datesSecInfo.sectionId);
      const todoColumns = conn2.getColumnsForSection(todoSecInfo.sectionId);

      // Build panes
      const datesPane = buildPane(datesSecInfo, datesColumns, datesData.rowIds, datesData.colValues);
      const todoPane = buildPane(todoSecInfo, todoColumns, todoData.rowIds, todoData.colValues);

      // Simulate linking: Dates cursor on row 0 (Mon, rowId=1)
      datesPane.cursorRow = 0;
      const srcRowId = datesPane.rowIds[0]; // should be 1

      // Filter todo pane by DateRefs containing srcRowId
      const filteredRowIds: number[] = [];
      const dateRefsValues = todoPane.colValues.DateRefs;
      for (let i = 0; i < todoPane.rowIds.length; i++) {
        const val = dateRefsValues[i];
        const match = (Array.isArray(val) && val[0] === "L" && val.indexOf(srcRowId) > 0);
        if (match) {
          filteredRowIds.push(todoPane.rowIds[i]);
        }
      }

      // Tasks A and B reference Mon (rowId 1)
      const filteredTasks = filteredRowIds.map(rid => {
        const idx = todoPane.rowIds.indexOf(rid);
        return todoPane.colValues.Task[idx];
      });
      assert.deepEqual(filteredTasks, ["Task A", "Task B"],
        "Should show tasks whose DateRefs contains Mon (rowId 1)");

      // Now test with Dates cursor on row 1 (Tue, rowId=2)
      const srcRowId2 = datesPane.rowIds[1]; // should be 2
      const filteredRowIds2: number[] = [];
      for (let i = 0; i < todoPane.rowIds.length; i++) {
        const val = dateRefsValues[i];
        const match = (Array.isArray(val) && val[0] === "L" && val.indexOf(srcRowId2) > 0);
        if (match) {
          filteredRowIds2.push(todoPane.rowIds[i]);
        }
      }
      const filteredTasks2 = filteredRowIds2.map(rid => {
        const idx = todoPane.rowIds.indexOf(rid);
        return todoPane.colValues.Task[idx];
      });
      assert.deepEqual(filteredTasks2, ["Task B", "Task C"],
        "Should show tasks whose DateRefs contains Tue (rowId 2)");

      await conn2.close();
    });
  });
});
