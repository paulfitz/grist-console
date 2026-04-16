/**
 * Integration tests for ConsoleConnection against a real Grist server.
 *
 * These tests require a running Grist instance (started by hooks.ts via Docker,
 * or set GRIST_RUNNING=1 for an external server).
 */

import { assert } from "chai";
import { ConsoleConnection } from "../src/ConsoleConnection";
import {
  extractPages, extractSectionsForView,
  getLayoutSpecForView, parseLayoutSpec, computeLayout, Rect,
} from "../src/ConsoleLayout";
import { DocAction } from "../src/types";
import {
  SERVER_URL, API_KEY,
  createTestDoc, createPrivateTestDoc, applyUserActions, addRows, updateRows,
} from "./testServer";

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
});
