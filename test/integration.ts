/**
 * Integration tests for ConsoleConnection against a real Grist server.
 *
 * These tests require a running Grist instance (started by hooks.ts via Docker,
 * or set GRIST_RUNNING=1 for an external server).
 */

import { assert } from "chai";
import fetch from "node-fetch";
import { ConsoleConnection } from "../src/ConsoleConnection.js";
import {
  extractPages, extractSectionsForView, extractFiltersForSection,
  getLayoutSpecForView, parseLayoutSpec, computeLayout, Rect,
} from "../src/ConsoleLayout.js";
import { applySortSpec, applySectionFilters } from "../src/LinkingState.js";
import { appendRowToColValues } from "../src/ActionDispatcher.js";
import { computeInsertManualSort } from "../src/Commands.js";
import { listSiteDocs } from "../src/SiteApi.js";

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
  withConnection,
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
    await withConnection(docId, async (conn) => {
      const tableIds = conn.getTableIds();
      assert.include(tableIds, "People");
      assert.include(tableIds, "Table1");
    });
  });

  it("fetches table data with column metadata", async function() {
    await withConnection(docId, async (conn) => {
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
    });
  });

  it("applies cell edit via applyUserActions", async function() {
    try {
      await withConnection(docId, async (conn) => {
        await conn.applyUserActions([
          ["UpdateRecord", "People", 1, { Name: "Alicia" }],
        ]);
        const data = await conn.fetchTable("People");
        assert.equal(data.colValues.Name[0], "Alicia");
      });
    } finally {
      // Restore original
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
    }
  });

  it("adds a row and receives the new data", async function() {
    try {
      await withConnection(docId, async (conn) => {
        await conn.applyUserActions([
          ["AddRecord", "People", null, { Name: "Diana", Age: 28 }],
        ]);
        const data = await conn.fetchTable("People");
        assert.include(data.colValues.Name as string[], "Diana");
      });
    } finally {
      // Clean up the added row
      await withConnection(docId, async (conn) => {
        const data = await conn.fetchTable("People");
        const idx = (data.colValues.Name as string[]).indexOf("Diana");
        if (idx >= 0) {
          await conn.applyUserActions([
            ["RemoveRecord", "People", data.rowIds[idx]],
          ]);
        }
      });
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
    try {
      await withConnection(docId, async (conn) => {
        const ag = await editAndCaptureAg(conn, [["UpdateRecord", "People", 1, { Name: "UndoMe" }]]);

        assert.equal(await getName(conn, 1), "UndoMe");
        await conn.applyUserActionsById([ag.actionNum], [ag.actionHash], true, { otherId: ag.actionNum });
        assert.equal(await getName(conn, 1), "Alice");
        await conn.applyUserActionsById([ag.actionNum], [ag.actionHash], false, { otherId: ag.actionNum });
        assert.equal(await getName(conn, 1), "UndoMe");
      });
    } finally {
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
    }
  });

  it("undoes multiple edits in reverse order", async function() {
    try {
      await withConnection(docId, async (conn) => {
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
      });
    } finally {
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
    }
  });

  it("redoes multiple undos in forward order", async function() {
    try {
      await withConnection(docId, async (conn) => {
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
      });
    } finally {
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
    }
  });

  it("undo, redo, undo, redo alternation converges", async function() {
    try {
      await withConnection(docId, async (conn) => {
        const ag = await editAndCaptureAg(conn, [["UpdateRecord", "People", 1, { Name: "ToggleMe" }]]);
        assert.equal(await getName(conn, 1), "ToggleMe");

        for (let i = 0; i < 3; i++) {
          await conn.applyUserActionsById([ag.actionNum], [ag.actionHash], true, { otherId: ag.actionNum });
          assert.equal(await getName(conn, 1), "Alice", `after undo ${i + 1}`);
          await conn.applyUserActionsById([ag.actionNum], [ag.actionHash], false, { otherId: ag.actionNum });
          assert.equal(await getName(conn, 1), "ToggleMe", `after redo ${i + 1}`);
        }
      });
    } finally {
      await updateRows(docId, "People", { id: [1], Name: ["Alice"] });
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

    await withConnection(testDocId, async (conn) => {
      const initialData = await conn.fetchTable("Things");

      // Sort initial data by manualSort so row 0 corresponds to the visible top
      const indices = initialData.rowIds.map((_, i) => i);
      indices.sort((a, b) =>
        (initialData.colValues.manualSort[a] as number) - (initialData.colValues.manualSort[b] as number)
      );
      const sortedManualSort = indices.map(i => initialData.colValues.manualSort[i]);

      // Compute insert hint = cursor (row 0) manualSort value
      const insertMS = computeInsertManualSort(sortedManualSort, 0, sortedManualSort.length);
      assert.equal(insertMS, sortedManualSort[0], "Hint should equal reference row's manualSort");

      await conn.applyUserActions([
        ["AddRecord", "Things", null, { Label: "TopInsert", manualSort: insertMS }],
      ]);
    });

    // Reload and verify order
    await withConnection(testDocId, async (conn) => {
      const reloaded = await conn.fetchTable("Things");
      const reloadIdx = reloaded.rowIds.map((_, i) => i);
      reloadIdx.sort((a, b) =>
        (reloaded.colValues.manualSort[a] as number) - (reloaded.colValues.manualSort[b] as number)
      );
      const orderedLabels = reloadIdx.map(i => reloaded.colValues.Label[i]);
      assert.deepEqual(orderedLabels, ["TopInsert", "Alpha", "Bravo", "Charlie"]);
    });
  });

  it("adding a row in the middle inserts above cursor row", async function() {
    const { docId: testDocId } = await createTestDoc("add-middle-test");
    await applyUserActions(testDocId, [
      ["AddTable", "Things", [
        { id: "Label", type: "Text", isFormula: false, formula: "" },
      ]],
    ]);
    await addRows(testDocId, "Things", { Label: ["A", "B", "C", "D"] });

    await withConnection(testDocId, async (conn) => {
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
    });

    await withConnection(testDocId, async (conn) => {
      const reloaded = await conn.fetchTable("Things");
      const reloadIdx = reloaded.rowIds.map((_, i) => i);
      reloadIdx.sort((a, b) =>
        (reloaded.colValues.manualSort[a] as number) - (reloaded.colValues.manualSort[b] as number)
      );
      const orderedLabels = reloadIdx.map(i => reloaded.colValues.Label[i]);
      // Server inserts just before row 2 ("C"), so: A B MidInsert C D
      assert.deepEqual(orderedLabels, ["A", "B", "MidInsert", "C", "D"]);
    });
  });

  it("deletes a row", async function() {
    await withConnection(docId, async (conn) => {
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
    });
  });

  it("receives live updates from another client's edits", async function() {
    try {
      await withConnection(docId, async (conn) => {
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
      });
    } finally {
      await updateRows(docId, "People", { id: [2], Name: ["Bob"] });
    }
  });

  it("two WebSocket clients see each other's changes", async function() {
    try {
      await withConnection(docId, async (conn1) => {
        await withConnection(docId, async (conn2) => {
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
        });
      });
    } finally {
      await updateRows(docId, "People", { id: [3], Name: ["Charlie"] });
    }
  });

  it("connects to a public doc without an API key", async function() {
    await withConnection(docId, async (conn) => {
      const tableIds = conn.getTableIds();
      assert.include(tableIds, "People");
      const data = await conn.fetchTable("People");
      assert.deepEqual(data.colValues.Name, ["Alice", "Bob", "Charlie"]);
    }, { apiKey: undefined });
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
    await withConnection(privateDocId, async (conn) => {
      const data = await conn.fetchTable("Secrets");
      assert.deepEqual(data.colValues.Code, ["alpha", "bravo"]);
    });

    // Should fail without API key
    try {
      await withConnection(privateDocId, async () => {
        assert.fail("Should have thrown for private doc without API key");
      }, { apiKey: undefined });
    } catch (err: any) {
      assert.match(err.message, /403|access|denied|rejected/i);
    }
  });

  it("exposes metadata via getMetaTables", async function() {
    await withConnection(docId, async (conn) => {
      const meta = conn.getMetaTables();
      assert.isOk(meta);
      assert.isOk(meta._grist_Tables);
      assert.isOk(meta._grist_Pages);
      assert.isOk(meta._grist_Views);
      assert.isOk(meta._grist_Views_section);
    });
  });

  it("extracts pages from real metadata", async function() {
    await withConnection(docId, async (conn) => {
      const pages = extractPages(conn.getMetaTables());
      assert.isAbove(pages.length, 0);
      const pageNames = pages.map(p => p.name);
      assert.isOk(pageNames.some(n => n.includes("People") || n.includes("Table1")),
        "Should find at least one page");
    });
  });

  it("extracts sections for a view", async function() {
    await withConnection(docId, async (conn) => {
      const pages = extractPages(conn.getMetaTables());
      assert.isAbove(pages.length, 0);
      const sections = extractSectionsForView(conn.getMetaTables(), pages[0].viewId);
      assert.isAbove(sections.length, 0);
      for (const sec of sections) {
        assert.isOk(sec.tableId);
        assert.isAbove(sec.sectionId, 0);
      }
    });
  });

  it("computes correct layout direction from real multi-section view", async function() {
    // Create a new view with two side-by-side sections
    const r1 = await applyUserActions(docId, [
      ["CreateViewSection", 1, 0, "record", null, null],
    ]);
    const newViewId: number = r1.retValues[0].viewRef;

    // Read metadata to find People table ref
    const peopleTableRef = await withConnection(docId, async (conn) => {
      const tablesData = conn.getMetaTables()._grist_Tables;
      const tids: string[] = tablesData[3].tableId;
      const trefs: number[] = tablesData[2];
      for (let i = 0; i < tids.length; i++) {
        if (tids[i] === "People") { return trefs[i]; }
      }
      return 0;
    });
    assert.isAbove(peopleTableRef, 0, "People table should exist");

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
    await withConnection(docId, async (conn) => {
      const meta = conn.getMetaTables();
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
    });
  });

  it("computes vertical layout for stacked sections", async function() {
    await withConnection(docId, async (conn) => {
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
    });

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
  });

  it("gets columns for a section using field ordering", async function() {
    await withConnection(docId, async (conn) => {
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
    });
  });

  // Helper: remove all _grist_Filters rows whose viewSectionRef matches.
  async function clearSectionFilters(testDocId: string, sectionId: number, meta: any): Promise<void> {
    const filterData = meta._grist_Filters;
    if (!filterData) { return; }
    const filterIds: number[] = filterData[2];
    const filterVals = filterData[3];
    for (let i = 0; i < filterIds.length; i++) {
      if (filterVals.viewSectionRef[i] === sectionId) {
        await applyUserActions(testDocId, [
          ["RemoveRecord", "_grist_Filters", filterIds[i]],
        ]);
      }
    }
  }

  // Helper: find a column's ref by colId within a specific table.
  function findColRef(meta: any, tableRef: number, colId: string): number {
    const colData = meta._grist_Tables_column;
    const colIds: string[] = colData[3].colId;
    const colRefs: number[] = colData[2];
    const parentIds: number[] = colData[3].parentId;
    for (let i = 0; i < colIds.length; i++) {
      if (colIds[i] === colId && parentIds[i] === tableRef) { return colRefs[i]; }
    }
    return 0;
  }

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
      // Find the People section and the Name column ref
      const { sectionId, nameColRef, peoplePageViewId } = await withConnection(docId, async (conn) => {
        const meta = conn.getMetaTables();
        const peoplePage = extractPages(meta).find(p => p.name.includes("People"))!;
        const sec = extractSectionsForView(meta, peoplePage.viewId)[0];
        return {
          sectionId: sec.sectionId,
          nameColRef: findColRef(meta, sec.tableRef, "Name"),
          peoplePageViewId: peoplePage.viewId,
        };
      });
      assert.isAbove(nameColRef, 0, "Should find Name column ref");

      await applyUserActions(docId, [
        ["UpdateRecord", "_grist_Views_section", sectionId,
         { sortColRefs: JSON.stringify([nameColRef]) }],
      ]);

      try {
        await withConnection(docId, async (conn) => {
          const meta = conn.getMetaTables();
          const sec = extractSectionsForView(meta, peoplePageViewId)[0];
          assert.isOk(sec.sortColRefs, "Section should have sortColRefs set");

          const data = await conn.fetchTable("People");
          const columns = conn.getColumnsForSection(sec.sectionId);
          const pane = buildPane(sec, columns, data.rowIds, data.colValues);

          applySortSpec(pane, sec.sortColRefs, meta);
          assert.deepEqual(pane.colValues.Name, ["Alice", "Bob", "Charlie"]);
        });
      } finally {
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sectionId, { sortColRefs: "" }],
        ]);
      }
    });

    it("sorts descending by Age", async function() {
      const { sectionId, ageColRef, peoplePageViewId } = await withConnection(docId, async (conn) => {
        const meta = conn.getMetaTables();
        const peoplePage = extractPages(meta).find(p => p.name.includes("People"))!;
        const sec = extractSectionsForView(meta, peoplePage.viewId)[0];
        return {
          sectionId: sec.sectionId,
          ageColRef: findColRef(meta, sec.tableRef, "Age"),
          peoplePageViewId: peoplePage.viewId,
        };
      });

      await applyUserActions(docId, [
        ["UpdateRecord", "_grist_Views_section", sectionId,
         { sortColRefs: JSON.stringify([-ageColRef]) }],
      ]);

      try {
        await withConnection(docId, async (conn) => {
          const meta = conn.getMetaTables();
          const sec = extractSectionsForView(meta, peoplePageViewId)[0];
          const data = await conn.fetchTable("People");
          const columns = conn.getColumnsForSection(sec.sectionId);
          const pane = buildPane(sec, columns, data.rowIds, data.colValues);

          applySortSpec(pane, sec.sortColRefs, meta);
          assert.deepEqual(pane.colValues.Age, [35, 30, 25]);
          assert.deepEqual(pane.colValues.Name, ["Charlie", "Alice", "Bob"]);
        });
      } finally {
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sectionId, { sortColRefs: "" }],
        ]);
      }
    });

    it("sorting is stable after adding a row", async function() {
      const { sectionId, nameColRef, peoplePageViewId } = await withConnection(docId, async (conn) => {
        const meta = conn.getMetaTables();
        const peoplePage = extractPages(meta).find(p => p.name.includes("People"))!;
        const sec = extractSectionsForView(meta, peoplePage.viewId)[0];
        return {
          sectionId: sec.sectionId,
          nameColRef: findColRef(meta, sec.tableRef, "Name"),
          peoplePageViewId: peoplePage.viewId,
        };
      });

      await applyUserActions(docId, [
        ["UpdateRecord", "_grist_Views_section", sectionId,
         { sortColRefs: JSON.stringify([nameColRef]) }],
      ]);
      await addRows(docId, "People", { Name: ["Aaron"], Age: [20] });

      try {
        await withConnection(docId, async (conn) => {
          const meta = conn.getMetaTables();
          const sec = extractSectionsForView(meta, peoplePageViewId)[0];
          const data = await conn.fetchTable("People");
          const columns = conn.getColumnsForSection(sec.sectionId);
          const pane = buildPane(sec, columns, data.rowIds, data.colValues);

          // Apply sort -- Aaron should appear first
          applySortSpec(pane, sec.sortColRefs, meta);
          assert.deepEqual(pane.colValues.Name, ["Aaron", "Alice", "Bob", "Charlie"]);

          // Simulate what happens when a row is added to an already-sorted pane:
          // the new row lands at the end of allRowIds, then reapplySortAndFilter
          // should put it in the right place.
          const pane2 = buildPane(sec, columns, data.rowIds, data.colValues);
          applySortSpec(pane2, sec.sortColRefs, meta);
          // Now simulate adding "Abe" to the *all* data (as the dispatcher would)
          pane2.allRowIds.push(999);
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
          applySortSpec(pane2, sec.sortColRefs, meta);
          assert.deepEqual(
            pane2.colValues.Name,
            ["Aaron", "Abe", "Alice", "Bob", "Charlie"],
            "New row should be sorted into correct position"
          );

          // Remove Aaron
          const aaronIdx = (data.colValues.Name as string[]).indexOf("Aaron");
          if (aaronIdx >= 0) {
            await conn.applyUserActions([
              ["RemoveRecord", "People", data.rowIds[aaronIdx]],
            ]);
          }
        });
      } finally {
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", sectionId, { sortColRefs: "" }],
        ]);
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
    const setup = await withConnection(testDocId, async (conn) => {
      const meta = conn.getMetaTables();
      const page = extractPages(meta).find(p => p.name.includes("Items"))!;
      const sec = extractSectionsForView(meta, page.viewId)[0];
      return {
        viewId: page.viewId,
        sectionId: sec.sectionId,
        labelColRef: findColRef(meta, sec.tableRef, "Label"),
        doneColRef: findColRef(meta, sec.tableRef, "Done"),
      };
    });

    // Sort by Label ascending, filter Done == false (include only false)
    await applyUserActions(testDocId, [
      ["UpdateRecord", "_grist_Views_section", setup.sectionId,
       { sortColRefs: JSON.stringify([setup.labelColRef]) }],
      ["AddRecord", "_grist_Filters", null, {
        viewSectionRef: setup.sectionId,
        colRef: setup.doneColRef,
        filter: JSON.stringify({ included: [false] }),
        pinned: true,
      }],
    ]);

    await withConnection(testDocId, async (conn) => {
      const meta = conn.getMetaTables();
      const sec = extractSectionsForView(meta, setup.viewId)[0];
      let data = await conn.fetchTable("Items");
      const columns = conn.getColumnsForSection(sec.sectionId);

      // Verify Bool values come as actual booleans
      assert.strictEqual(data.colValues.Done[0], false, "Bool should be false not 0");

      let pane = buildPane(sec, columns, data.rowIds, data.colValues);
      applySectionFilters(pane, sec.sectionId, meta);
      applySortSpec(pane, sec.sortColRefs, meta);
      assert.deepEqual(pane.colValues.Label, ["First", "Second"]);
      assert.equal(pane.rowIds.length, 2);

      // Add a new row via the connection (as the TUI would)
      await conn.applyUserActions([
        ["AddRecord", "Items", null, { Label: "Third" }],
      ]);

      // Re-fetch and verify the new row appears
      data = await conn.fetchTable("Items");
      pane = buildPane(sec, columns, data.rowIds, data.colValues);
      applySectionFilters(pane, sec.sectionId, meta);
      applySortSpec(pane, sec.sortColRefs, meta);
      assert.include(pane.colValues.Label as string[], "Third",
        "New row should be visible after filter+sort");
      assert.deepEqual(pane.colValues.Label, ["First", "Second", "Third"],
        "Rows should be sorted alphabetically");
    });
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

    const setup = await withConnection(testDocId, async (conn) => {
      const meta = conn.getMetaTables();
      const page = extractPages(meta).find(p => p.name.includes("Items"))!;
      const sec = extractSectionsForView(meta, page.viewId)[0];
      return {
        viewId: page.viewId,
        sectionId: sec.sectionId,
        labelColRef: findColRef(meta, sec.tableRef, "Label"),
        doneColRef: findColRef(meta, sec.tableRef, "Done"),
      };
    });

    await applyUserActions(testDocId, [
      ["UpdateRecord", "_grist_Views_section", setup.sectionId,
       { sortColRefs: JSON.stringify([setup.labelColRef]) }],
      ["AddRecord", "_grist_Filters", null, {
        viewSectionRef: setup.sectionId,
        colRef: setup.doneColRef,
        filter: JSON.stringify({ included: [false] }),
        pinned: true,
      }],
    ]);

    await withConnection(testDocId, async (conn) => {
      const meta = conn.getMetaTables();
      const sec = extractSectionsForView(meta, setup.viewId)[0];
      const columns = conn.getColumnsForSection(sec.sectionId);
      const data = await conn.fetchTable("Items");

      // Build pane as ConsoleMain.loadPage would
      const pane = buildPane(sec, columns, data.rowIds, data.colValues);

      // Initial sort+filter
      applySectionFilters(pane, sec.sectionId, meta);
      applySortSpec(pane, sec.sortColRefs, meta);
      assert.deepEqual(pane.colValues.Label, ["Alpha", "Bravo"]);

      // Listen for live update when we add a row from another client
      const actionPromise = new Promise<DocAction[]>((resolve) => {
        conn.onDocAction(resolve);
      });

      // Add row via REST API (simulates another client)
      await addRows(testDocId, "Items", { Label: ["Charlie"], Done: [false] });
      const actions = await actionPromise;

      // Apply the DocAction to the pane (as the dispatcher does)
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
      applySectionFilters(pane, sec.sectionId, meta);
      applySortSpec(pane, sec.sortColRefs, meta);

      // The new row should be visible and sorted
      assert.include(pane.colValues.Label as string[], "Charlie",
        "New row from live update should be visible after sort+filter");
      assert.deepEqual(pane.colValues.Label, ["Alpha", "Bravo", "Charlie"]);
    });
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

    const setup = await withConnection(testDocId, async (conn) => {
      const meta = conn.getMetaTables();
      const page = extractPages(meta).find(p => p.name.includes("Items"))!;
      const sec = extractSectionsForView(meta, page.viewId)[0];
      return {
        viewId: page.viewId,
        sectionId: sec.sectionId,
        doneColRef: findColRef(meta, sec.tableRef, "Done"),
      };
    });

    // Filter: include only Done=false
    await applyUserActions(testDocId, [
      ["AddRecord", "_grist_Filters", null, {
        viewSectionRef: setup.sectionId,
        colRef: setup.doneColRef,
        filter: JSON.stringify({ included: [false] }),
        pinned: true,
      }],
    ]);

    await withConnection(testDocId, async (conn) => {
      const meta = conn.getMetaTables();
      const sec = extractSectionsForView(meta, setup.viewId)[0];
      const columns = conn.getColumnsForSection(sec.sectionId);
      const data = await conn.fetchTable("Items");

      // Build pane, apply filter -- should show "First"
      const pane = buildPane(sec, columns, data.rowIds, data.colValues);
      applySectionFilters(pane, sec.sectionId, meta);
      assert.deepEqual(pane.colValues.Label, ["First"]);

      // Now simulate a live AddRecord with empty colValues (as the server sends)
      pane.allRowIds.push(999);
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
      applySectionFilters(pane, sec.sectionId, meta);

      // New row should be visible because Done defaults to false, which passes the filter
      assert.equal(pane.rowIds.length, 2,
        "New row with default Bool=false should pass the inclusion filter");
    });
  });

  describe("filtering with real metadata", function() {
    it("filters a section with inclusion filter", async function() {
      const setup = await withConnection(docId, async (conn) => {
        const meta = conn.getMetaTables();
        const peoplePage = extractPages(meta).find(p => p.name.includes("People"))!;
        const sec = extractSectionsForView(meta, peoplePage.viewId)[0];
        return {
          viewId: peoplePage.viewId,
          sectionId: sec.sectionId,
          nameColRef: findColRef(meta, sec.tableRef, "Name"),
        };
      });

      await applyUserActions(docId, [
        ["AddRecord", "_grist_Filters", null, {
          viewSectionRef: setup.sectionId,
          colRef: setup.nameColRef,
          filter: JSON.stringify({ included: ["Alice", "Charlie"] }),
          pinned: true,
        }],
      ]);

      try {
        await withConnection(docId, async (conn) => {
          const meta = conn.getMetaTables();
          const sec = extractSectionsForView(meta, setup.viewId)[0];
          const data = await conn.fetchTable("People");
          const columns = conn.getColumnsForSection(sec.sectionId);
          const pane = buildPane(sec, columns, data.rowIds, data.colValues);

          applySectionFilters(pane, sec.sectionId, meta);
          assert.deepEqual(pane.colValues.Name, ["Alice", "Charlie"]);
        });
      } finally {
        await withConnection(docId, async (conn) => {
          await clearSectionFilters(docId, setup.sectionId, conn.getMetaTables());
        });
      }
    });

    it("filters with range filter on Age", async function() {
      const setup = await withConnection(docId, async (conn) => {
        const meta = conn.getMetaTables();
        const peoplePage = extractPages(meta).find(p => p.name.includes("People"))!;
        const sec = extractSectionsForView(meta, peoplePage.viewId)[0];
        return {
          viewId: peoplePage.viewId,
          sectionId: sec.sectionId,
          ageColRef: findColRef(meta, sec.tableRef, "Age"),
        };
      });

      await applyUserActions(docId, [
        ["AddRecord", "_grist_Filters", null, {
          viewSectionRef: setup.sectionId,
          colRef: setup.ageColRef,
          filter: JSON.stringify({ min: 28 }),
          pinned: true,
        }],
      ]);

      try {
        await withConnection(docId, async (conn) => {
          const meta = conn.getMetaTables();
          const sec = extractSectionsForView(meta, setup.viewId)[0];
          const data = await conn.fetchTable("People");
          const columns = conn.getColumnsForSection(sec.sectionId);
          const pane = buildPane(sec, columns, data.rowIds, data.colValues);

          applySectionFilters(pane, sec.sectionId, meta);
          // Bob (25) should be excluded, Alice (30) and Charlie (35) remain
          assert.deepEqual(pane.colValues.Name, ["Alice", "Charlie"]);
          assert.deepEqual(pane.colValues.Age, [30, 35]);
        });
      } finally {
        await withConnection(docId, async (conn) => {
          await clearSectionFilters(docId, setup.sectionId, conn.getMetaTables());
        });
      }
    });

    it("combined sort and filter", async function() {
      const setup = await withConnection(docId, async (conn) => {
        const meta = conn.getMetaTables();
        const peoplePage = extractPages(meta).find(p => p.name.includes("People"))!;
        const sec = extractSectionsForView(meta, peoplePage.viewId)[0];
        return {
          viewId: peoplePage.viewId,
          sectionId: sec.sectionId,
          nameColRef: findColRef(meta, sec.tableRef, "Name"),
          ageColRef: findColRef(meta, sec.tableRef, "Age"),
        };
      });

      await applyUserActions(docId, [
        ["UpdateRecord", "_grist_Views_section", setup.sectionId,
         { sortColRefs: JSON.stringify([-setup.nameColRef]) }],
        ["AddRecord", "_grist_Filters", null, {
          viewSectionRef: setup.sectionId,
          colRef: setup.ageColRef,
          filter: JSON.stringify({ min: 28 }),
          pinned: true,
        }],
      ]);

      try {
        await withConnection(docId, async (conn) => {
          const meta = conn.getMetaTables();
          const sec = extractSectionsForView(meta, setup.viewId)[0];
          const data = await conn.fetchTable("People");
          const columns = conn.getColumnsForSection(sec.sectionId);
          const pane = buildPane(sec, columns, data.rowIds, data.colValues);

          // Filter first, then sort (as reapplySortAndFilter does)
          applySectionFilters(pane, sec.sectionId, meta);
          applySortSpec(pane, sec.sortColRefs, meta);

          // Bob (25) filtered out, remaining sorted desc by Name: Charlie, Alice
          assert.deepEqual(pane.colValues.Name, ["Charlie", "Alice"]);
          assert.deepEqual(pane.colValues.Age, [35, 30]);
        });
      } finally {
        await applyUserActions(docId, [
          ["UpdateRecord", "_grist_Views_section", setup.sectionId, { sortColRefs: "" }],
        ]);
        await withConnection(docId, async (conn) => {
          await clearSectionFilters(docId, setup.sectionId, conn.getMetaTables());
        });
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

      const setup = await withConnection(testDocId, async (conn) => {
        const meta = conn.getMetaTables();
        const pages = extractPages(meta);
        const datesPage = pages.find(p => p.name.includes("Dates"))!;
        const datesSec = extractSectionsForView(meta, datesPage.viewId)[0];
        const todoPage = pages.find(p => p.name.includes("ToDo"))!;
        const todoSec = extractSectionsForView(meta, todoPage.viewId)[0];
        return {
          datesTableRef: datesSec.tableRef,
          todoTableRef: todoSec.tableRef,
          dateRefsColRef: findColRef(meta, todoSec.tableRef, "DateRefs"),
        };
      });
      assert.isAbove(setup.dateRefsColRef, 0);

      // Create a new page with both sections, link ToDo to Dates via DateRefs
      const r = await applyUserActions(testDocId, [
        ["CreateViewSection", setup.datesTableRef, 0, "record", null, null],
      ]);
      const newViewId = r.retValues[0].viewRef;
      const datesNewSecRef = r.retValues[0].sectionRef;
      const r2 = await applyUserActions(testDocId, [
        ["CreateViewSection", setup.todoTableRef, newViewId, "record", null, null],
      ]);
      const todoNewSecRef = r2.retValues[0].sectionRef;

      // Set linking: ToDo section links to Dates section via DateRefs
      await applyUserActions(testDocId, [
        ["UpdateRecord", "_grist_Views_section", todoNewSecRef, {
          linkSrcSectionRef: datesNewSecRef,
          linkSrcColRef: 0,
          linkTargetColRef: setup.dateRefsColRef,
        }],
      ]);

      // Reconnect with fresh metadata and exercise linking
      await withConnection(testDocId, async (conn) => {
        const meta = conn.getMetaTables();
        const newSections = extractSectionsForView(meta, newViewId);
        assert.equal(newSections.length, 2);

        const datesSecInfo = newSections.find(s => s.sectionId === datesNewSecRef)!;
        const todoSecInfo = newSections.find(s => s.sectionId === todoNewSecRef)!;

        const datesData = await conn.fetchTable("Dates");
        const todoData = await conn.fetchTable("ToDo");
        const datesColumns = conn.getColumnsForSection(datesSecInfo.sectionId);
        const todoColumns = conn.getColumnsForSection(todoSecInfo.sectionId);

        const datesPane = buildPane(datesSecInfo, datesColumns, datesData.rowIds, datesData.colValues);
        const todoPane = buildPane(todoSecInfo, todoColumns, todoData.rowIds, todoData.colValues);

        // Helper: filter todo pane to tasks whose DateRefs contains srcRowId
        const tasksLinkedTo = (srcRowId: number): string[] => {
          const dateRefsValues = todoPane.colValues.DateRefs;
          const matches: string[] = [];
          for (let i = 0; i < todoPane.rowIds.length; i++) {
            const val = dateRefsValues[i];
            if (Array.isArray(val) && val[0] === "L" && val.indexOf(srcRowId) > 0) {
              matches.push(todoPane.colValues.Task[i] as string);
            }
          }
          return matches;
        };

        // Tasks A and B reference Mon (rowId 1)
        assert.deepEqual(tasksLinkedTo(datesPane.rowIds[0]), ["Task A", "Task B"],
          "Should show tasks whose DateRefs contains Mon (rowId 1)");
        // Tasks B and C reference Tue (rowId 2)
        assert.deepEqual(tasksLinkedTo(datesPane.rowIds[1]), ["Task B", "Task C"],
          "Should show tasks whose DateRefs contains Tue (rowId 2)");
      });
    });
  });

  describe("site listing (REST /api/orgs/<slug>/workspaces)", function() {
    it("lists the test doc and its workspace via listSiteDocs", async function() {
      // The integration suite already created `console-integration-test`
      // (public) before this block; both should turn up here.
      const docs = await listSiteDocs(SERVER_URL, "current", API_KEY);
      assert.isAbove(docs.length, 0, "expected at least one doc in the test site");
      const ours = docs.find(d => d.id === docId);
      assert.exists(ours, `expected ${docId} in returned docs`);
      // Shape sanity: every doc has the fields the picker will render.
      for (const d of docs) {
        assert.isString(d.id, `doc.id should be a string: ${JSON.stringify(d)}`);
        assert.isString(d.name, `doc.name should be a string: ${JSON.stringify(d)}`);
        assert.isNumber(d.workspaceId, `doc.workspaceId should be a number: ${JSON.stringify(d)}`);
        assert.isString(d.workspaceName, `doc.workspaceName should be a string: ${JSON.stringify(d)}`);
        assert.isString(d.updatedAt, `doc.updatedAt should be a string: ${JSON.stringify(d)}`);
        assert.isNotEmpty(d.updatedAt, `doc.updatedAt should be set: ${JSON.stringify(d)}`);
        assert.isNull(d.removedAt, "trashed docs should have been filtered out");
      }
    });

    it("filters out trashed docs", async function() {
      // Build a fresh doc, soft-delete it, confirm it disappears from the
      // listing. (Grist's POST /docs/.../remove moves the doc to trash.)
      const { docId: tempId } = await createTestDoc("temp-for-trash-test");
      try {
        const before = await listSiteDocs(SERVER_URL, "current", API_KEY);
        assert.exists(before.find(d => d.id === tempId), "doc should be listed before trashing");

        await fetch(`${SERVER_URL}/api/docs/${tempId}/remove`, {
          method: "POST",
          headers: { Authorization: `Bearer ${API_KEY}` },
        });

        const after = await listSiteDocs(SERVER_URL, "current", API_KEY);
        assert.notExists(after.find(d => d.id === tempId), "doc should NOT be listed after trashing");
      } finally {
        // Best-effort permanent delete (ignore failures so the assertion
        // result is what surfaces).
        await fetch(`${SERVER_URL}/api/docs/${tempId}`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${API_KEY}` },
        }).catch(() => {});
      }
    });

    it("returns docs sorted by updatedAt descending", async function() {
      const docs = await listSiteDocs(SERVER_URL, "current", API_KEY);
      for (let i = 1; i < docs.length; i++) {
        assert.isAtLeast(docs[i - 1].updatedAt.localeCompare(docs[i].updatedAt), 0,
          `docs[${i - 1}].updatedAt should be >= docs[${i}].updatedAt`);
      }
    });

    it("rejects when the API key is wrong", async function() {
      let threw = false;
      try {
        await listSiteDocs(SERVER_URL, "current", "totally-wrong-key");
      } catch (e: any) {
        threw = true;
        assert.match(e.message, /rejected your API key|HTTP 4\d\d/,
          "expected a friendly auth-failure message");
      }
      assert.isTrue(threw, "expected listSiteDocs to throw on bad auth");
    });
  });
});
