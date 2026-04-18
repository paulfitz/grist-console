import { formatCellValue, parseCellInput, ParseError } from "../src/ConsoleCellFormat.js";
import {
  extractPages, extractSectionsForView, extractFieldsForSection,
  extractFiltersForSection, extractCollapsedSectionIds,
  getColumnInfo, getColIdByRef, parseLayoutSpec, computeLayout,
  getLayoutSpecForView, Rect,
} from "../src/ConsoleLayout.js";
import { createInitialState, PaneState } from "../src/ConsoleAppState.js";
import { render } from "../src/ConsoleRenderer.js";
import { displayWidth, flattenToLine, applyChoiceColor, editWindow, stripAnsi } from "../src/ConsoleDisplay.js";
import { _setFlagPairDelta, _setVs16Delta, _resetProbes, countFlagPairs, countZwjs, hasProbed, probeChar } from "../src/termWidth.js";
import { handleKeypress, ensureColVisible } from "../src/ConsoleInput.js";
import { getVisualPaneOrder, clearViewState } from "../src/ConsoleMain.js";
import { getThemeNames, getTheme } from "../src/ConsoleTheme.js";
import { stepGoat, resetGoat, getGoat, goatStatus, renderGoatOverlay } from "../src/GoatAnimation.js";
import {
  applySortSpec, applySectionFilters, compareCellValues, reapplySortAndFilter,
  applyAllSectionLinks,
} from "../src/LinkingState.js";
import { appendRowToColValues, applyDocActions } from "../src/ActionDispatcher.js";
import { handleOwnActionGroup } from "../src/UndoStack.js";
import { executeSaveEdit } from "../src/Commands.js";
import { parseGristDocUrl } from "../src/urlParser.js";
import { GristObjCode } from "../src/types.js";

import { assert } from "chai";

/**
 * Build a PaneState with sensible defaults: cursor at (0,0), no scroll,
 * and `allRowIds` / `allColValues` mirroring `rowIds` / `colValues` (so the
 * pane represents an unfiltered view of the same data).
 */
function makePane(opts: {
  columns: Array<{ colId: string; type: string; label: string; widgetOptions?: any; visibleCol?: number; displayValues?: Map<number, string> }>;
  rowIds: number[];
  colValues: Record<string, any[]>;
  sectionInfo?: any;
  cursorRow?: number;
  cursorCol?: number;
  scrollRow?: number;
  scrollCol?: number;
}): PaneState {
  return {
    sectionInfo: opts.sectionInfo,
    columns: opts.columns,
    rowIds: [...opts.rowIds],
    allRowIds: [...opts.rowIds],
    colValues: Object.fromEntries(Object.entries(opts.colValues).map(([k, v]) => [k, [...v]])),
    allColValues: Object.fromEntries(Object.entries(opts.colValues).map(([k, v]) => [k, [...v]])),
    cursorRow: opts.cursorRow ?? 0,
    cursorCol: opts.cursorCol ?? 0,
    scrollRow: opts.scrollRow ?? 0,
    scrollCol: opts.scrollCol ?? 0,
  };
}

describe("ConsoleClient", function() {
  this.timeout(30000);

  // ===================== Unit Tests =====================

  describe("ConsoleCellFormat", function() {
    describe("formatCellValue", function() {
      it("formats primitives", function() {
        assert.equal(formatCellValue(null), "");
        assert.equal(formatCellValue("hello"), "hello");
        assert.equal(formatCellValue(42), "42");
        assert.equal(formatCellValue(3.14), "3.14");
        assert.equal(formatCellValue(true), "true");
        assert.equal(formatCellValue(false), "false");
        assert.equal(formatCellValue(""), "");
      });

      it("formats Date values", function() {
        // ["d", timestamp] - 2024-01-10 midnight UTC = 1704844800
        const result = formatCellValue([GristObjCode.Date, 1704844800]);
        assert.equal(result, "2024-01-10");
      });

      it("formats DateTime values", function() {
        const result = formatCellValue([GristObjCode.DateTime, 1704945919, "UTC"]);
        assert.match(result, /2024-01-1[01]/);
      });

      it("formats bare numeric timestamps as dates when colType provided", function() {
        // 1704844800 = 2024-01-10 midnight UTC
        assert.equal(formatCellValue(1704844800, "Date"), "2024-01-10");
        assert.match(formatCellValue(1704945919, "DateTime"), /2024-01-1[01]/);
        // Without colType, shows raw number
        assert.equal(formatCellValue(1704844800), "1704844800");
        // Zero treated as empty for dates
        assert.equal(formatCellValue(0, "Date"), "");
        assert.equal(formatCellValue(0, "DateTime"), "");
        // Regular numbers unaffected even with colType
        assert.equal(formatCellValue(42, "Int"), "42");
        assert.equal(formatCellValue(3.14, "Numeric"), "3.14");
      });

      it("formats numbers with widget options", function() {
        // Currency
        assert.equal(formatCellValue(1234.5, "Numeric", { numMode: "currency", currency: "USD" }), "$1,234.50");
        // Percent
        assert.equal(formatCellValue(0.75, "Numeric", { numMode: "percent" }), "75%");
        // Fixed decimals
        assert.equal(formatCellValue(42, "Numeric", { decimals: 2, maxDecimals: 2 }), "42.00");
        // Without widget options, plain number
        assert.equal(formatCellValue(1234.5, "Numeric"), "1234.5");
      });

      it("formats dates with custom dateFormat", function() {
        // 1704844800 = 2024-01-10 midnight UTC
        assert.equal(formatCellValue(1704844800, "Date", { dateFormat: "MM/DD/YYYY" }), "01/10/2024");
        assert.equal(formatCellValue(1704844800, "Date", { dateFormat: "DD MMM YYYY" }), "10 Jan 2024");
        // Default ISO format without widget options
        assert.equal(formatCellValue(1704844800, "Date"), "2024-01-10");
      });

      it("formats Reference with display values", function() {
        const dv = new Map([[17, "Alice"], [5, "Bob"]]);
        assert.equal(formatCellValue([GristObjCode.Reference, "People", 17], undefined, undefined, dv), "Alice");
        assert.equal(formatCellValue([GristObjCode.Reference, "People", 99], undefined, undefined, dv), "99");
        assert.equal(formatCellValue(17, "Ref:People", undefined, dv), "Alice");
        assert.equal(formatCellValue(0, "Ref:People", undefined, dv), "");
      });

      it("formats ReferenceList with display values", function() {
        const dv = new Map([[1, "X"], [2, "Y"], [3, "Z"]]);
        assert.equal(formatCellValue([GristObjCode.ReferenceList, "T", [1, 3]], undefined, undefined, dv), "X, Z");
        // Falls back to IDs for unknown rows
        assert.equal(formatCellValue([GristObjCode.ReferenceList, "T", [1, 99]], undefined, undefined, dv), "X, 99");
      });

      it("formats Reference values", function() {
        assert.equal(formatCellValue([GristObjCode.Reference, "People", 17]), "17");
        assert.equal(formatCellValue([GristObjCode.Reference, "People", 0]), "");
      });

      it("formats ReferenceList values", function() {
        assert.equal(formatCellValue([GristObjCode.ReferenceList, "People", [1, 2, 3]]), "1, 2, 3");
      });

      it("formats List values", function() {
        assert.equal(formatCellValue([GristObjCode.List, "foo", "bar"]), "foo, bar");
      });

      it("formats RefList as List with display values", function() {
        const dv = new Map([[1, "Mon"], [2, "Tue"], [3, "Wed"]]);
        // RefList data comes as ["L", id1, id2, ...] in table data
        assert.equal(
          formatCellValue([GristObjCode.List, 1, 3] as any, "RefList:Dates", undefined, dv),
          "Mon, Wed"
        );
        // Falls back to IDs when display value is missing
        assert.equal(
          formatCellValue([GristObjCode.List, 1, 99] as any, "RefList:Dates", undefined, dv),
          "Mon, 99"
        );
        // Without colType, shows raw values
        assert.equal(
          formatCellValue([GristObjCode.List, 1, 2] as any, undefined, undefined, dv),
          "1, 2"
        );
      });

      it("formats error values", function() {
        assert.equal(formatCellValue([GristObjCode.Exception, "ValueError"]), "#ERROR: ValueError");
        assert.equal(formatCellValue([GristObjCode.Pending]), "#PENDING");
        assert.equal(formatCellValue([GristObjCode.Censored]), "#CENSORED");
      });

      it("formats null Date as empty", function() {
        assert.equal(formatCellValue([GristObjCode.Date, null as any]), "");
      });
    });

    describe("parseCellInput", function() {
      it("parses Text values", function() {
        assert.equal(parseCellInput("hello", "Text"), "hello");
        assert.equal(parseCellInput("", "Text"), "");
      });

      it("parses Bool values", function() {
        assert.equal(parseCellInput("true", "Bool"), true);
        assert.equal(parseCellInput("false", "Bool"), false);
        assert.equal(parseCellInput("1", "Bool"), true);
        assert.equal(parseCellInput("0", "Bool"), false);
        assert.equal(parseCellInput("yes", "Bool"), true);
        assert.equal(parseCellInput("no", "Bool"), false);
      });

      it("parses Int values", function() {
        assert.equal(parseCellInput("42", "Int"), 42);
        assert.equal(parseCellInput("-5", "Int"), -5);
        assert.equal(parseCellInput("", "Int"), 0);
      });

      it("parses Numeric values", function() {
        assert.equal(parseCellInput("3.14", "Numeric"), 3.14);
        assert.equal(parseCellInput("", "Numeric"), 0);
      });

      it("parses Date values", function() {
        const result = parseCellInput("2024-01-10", "Date");
        assert.equal(result, 1704844800);
      });

      it("parses Ref values", function() {
        assert.equal(parseCellInput("17", "Ref:People"), 17);
        assert.equal(parseCellInput("", "Ref:People"), 0);
      });

      it("throws ParseError for unparseable input", function() {
        // Unrecognized Bool wording -- previously fell through and sent
        // the raw string to the server.
        assert.throws(() => parseCellInput("maybe", "Bool"), ParseError);
        assert.throws(() => parseCellInput("abc", "Int"), ParseError);
        assert.throws(() => parseCellInput("hello", "Numeric"), ParseError);
        assert.throws(() => parseCellInput("not-a-date", "Date"), ParseError);
        assert.throws(() => parseCellInput("garbage", "DateTime"), ParseError);
        assert.throws(() => parseCellInput("xyz", "Ref:People"), ParseError);
      });
    });
  });

  describe("ConsoleRenderer", function() {
    it("renders table picker", function() {
      const state = createInitialState("testDoc");
      state.tableIds = ["People", "Projects", "Tasks"];
      state.selectedTableIndex = 1;
      const output = render(state);
      assert.include(output, "Select a Table");
      assert.include(output, "People");
      assert.include(output, "Projects");
      assert.include(output, "Tasks");
    });

    it("renders grid with data", function() {
      const state = createInitialState("testDoc");
      state.mode = "grid";
      state.currentTableId = "People";
      state.panes = [makePane({
        columns: [
          { colId: "Name", type: "Text", label: "Name" },
          { colId: "Age", type: "Int", label: "Age" },
        ],
        rowIds: [1, 2],
        colValues: { Name: ["Alice", "Bob"], Age: [30, 25] },
      })];
      state.focusedPane = 0;
      const output = render(state);
      assert.include(output, "People");
      assert.include(output, "2 rows");
      assert.include(output, "Name");
      assert.include(output, "Age");
      assert.include(output, "Alice");
      assert.include(output, "Bob");
    });

    it("renders empty table", function() {
      const state = createInitialState("testDoc");
      state.mode = "grid";
      state.currentTableId = "Empty";
      state.panes = [makePane({
        columns: [{ colId: "A", type: "Text", label: "A" }],
        rowIds: [],
        colValues: { A: [] },
      })];
      state.focusedPane = 0;
      const output = render(state);
      assert.include(output, "Empty");
      assert.include(output, "0 rows");
    });
  });

  describe("ConsoleLayout", function() {
    // Mock metadata in the format returned by openDoc
    const mockMetaTables = {
      _grist_Tables: ["TableData", "_grist_Tables", [1, 2], {
        tableId: ["People", "Projects"],
        primaryViewId: [1, 2],
        summarySourceTable: [0, 0],
        onDemand: [false, false],
        rawViewSectionRef: [0, 0],
      }],
      _grist_Pages: ["TableData", "_grist_Pages", [1, 2, 3], {
        viewRef: [1, 2, 3],
        indentation: [0, 0, 1],
        pagePos: [2, 1, 3],
      }],
      _grist_Views: ["TableData", "_grist_Views", [1, 2, 3], {
        name: ["People", "Dashboard", "Sub-page"],
        layoutSpec: [
          '{"leaf":10}',
          '{"children":[{"leaf":20},{"leaf":21}]}',
          '{"leaf":30}',
        ],
      }],
      _grist_Views_section: ["TableData", "_grist_Views_section", [10, 20, 21, 30, 40], {
        parentId: [1, 2, 2, 3, 2],
        tableRef: [1, 1, 2, 1, 1],
        parentKey: ["record", "record", "record", "record", "chart"],
        title: ["", "People List", "", "", ""],
        linkSrcSectionRef: [0, 0, 20, 0, 0],
        linkSrcColRef: [0, 0, 0, 0, 0],
        linkTargetColRef: [0, 0, 5, 0, 0],
      }],
      _grist_Views_section_field: ["TableData", "_grist_Views_section_field",
        [100, 101, 102, 103, 104, 105], {
        parentId: [10, 10, 20, 20, 21, 21],
        colRef: [1, 2, 1, 2, 3, 4],
        parentPos: [2, 1, 1, 2, 1, 2],
      }],
      _grist_Tables_column: ["TableData", "_grist_Tables_column",
        [1, 2, 3, 4, 5], {
        parentId: [1, 1, 2, 2, 2],
        colId: ["Name", "Age", "Title", "Status", "Owner"],
        type: ["Text", "Int", "Text", "Choice", "Ref:People"],
        label: ["Name", "Age", "Title", "Status", "Owner"],
      }],
    };

    describe("extractPages", function() {
      it("returns sorted pages with names", function() {
        const pages = extractPages(mockMetaTables);
        assert.equal(pages.length, 3);
        // Sorted by pagePos: Dashboard (pos=1), People (pos=2), Sub-page (pos=3)
        assert.equal(pages[0].name, "Dashboard");
        assert.equal(pages[0].viewId, 2);
        assert.equal(pages[1].name, "People");
        assert.equal(pages[1].viewId, 1);
        assert.equal(pages[2].name, "Sub-page");
        assert.equal(pages[2].indentation, 1);
      });

      it("returns empty array for missing metadata", function() {
        assert.deepEqual(extractPages({}), []);
      });
    });

    describe("extractSectionsForView", function() {
      it("returns all sections for a view including non-record types", function() {
        const sections = extractSectionsForView(mockMetaTables, 2);
        // View 2 has sections 20, 21 (record) and 40 (chart).
        assert.equal(sections.length, 3);
        assert.equal(sections[0].sectionId, 20);
        assert.equal(sections[0].tableId, "People");
        assert.equal(sections[0].parentKey, "record");
        assert.equal(sections[0].title, "People List");
        assert.equal(sections[1].sectionId, 21);
        assert.equal(sections[1].tableId, "Projects");
        assert.equal(sections[1].parentKey, "record");
        assert.equal(sections[1].linkSrcSectionRef, 20);
        assert.equal(sections[1].linkTargetColRef, 5);
        assert.equal(sections[2].sectionId, 40);
        assert.equal(sections[2].parentKey, "chart");
      });

      it("returns single section for simple view", function() {
        const sections = extractSectionsForView(mockMetaTables, 1);
        assert.equal(sections.length, 1);
        assert.equal(sections[0].sectionId, 10);
        assert.equal(sections[0].parentKey, "record");
      });
    });

    describe("extractFieldsForSection", function() {
      it("returns ordered fields for a section", function() {
        const fields = extractFieldsForSection(mockMetaTables, 10);
        assert.equal(fields.length, 2);
        // Sorted by parentPos: colRef 2 (pos=1), colRef 1 (pos=2)
        assert.equal(fields[0].colRef, 2);
        assert.equal(fields[1].colRef, 1);
      });

      it("returns correct fields for another section", function() {
        const fields = extractFieldsForSection(mockMetaTables, 20);
        assert.equal(fields.length, 2);
        assert.equal(fields[0].colRef, 1);
        assert.equal(fields[1].colRef, 2);
      });
    });

    describe("getColumnInfo", function() {
      it("resolves a column ref to colId/type/label", function() {
        const col = getColumnInfo(mockMetaTables, 1);
        assert.isOk(col);
        assert.equal(col!.colId, "Name");
        assert.equal(col!.type, "Text");
        assert.equal(col!.label, "Name");
      });

      it("returns null for unknown colRef", function() {
        assert.isNull(getColumnInfo(mockMetaTables, 999));
      });
    });

    describe("getColIdByRef", function() {
      it("resolves colRef to colId string", function() {
        assert.equal(getColIdByRef(mockMetaTables, 5), "Owner");
        assert.equal(getColIdByRef(mockMetaTables, 3), "Title");
      });

      it("returns empty for unknown ref", function() {
        assert.equal(getColIdByRef(mockMetaTables, 999), "");
      });
    });

    describe("parseLayoutSpec", function() {
      it("parses valid JSON BoxSpec", function() {
        const box = parseLayoutSpec('{"children":[{"leaf":1},{"leaf":2}]}', [1, 2]);
        assert.isOk(box.children);
        assert.equal(box.children!.length, 2);
      });

      it("falls back to two-column default for invalid JSON", function() {
        const box = parseLayoutSpec("not-json", [10, 20]);
        // Two sections: horizontal pair
        assert.isOk(box.children);
        assert.equal(box.children!.length, 2);
        assert.equal(box.children![0].leaf, 10);
        assert.equal(box.children![1].leaf, 20);
      });

      it("falls back to single leaf for one section", function() {
        const box = parseLayoutSpec(undefined, [10]);
        assert.equal(box.leaf, 10);
      });

      it("falls back to two-column default for 3 sections", function() {
        // Replicates web client's addToSpec: pair into rows of 2
        // [10,20] horizontal, [30] alone
        const box = parseLayoutSpec(undefined, [10, 20, 30]);
        assert.isOk(box.children);
        assert.equal(box.children!.length, 2);
        // First row: horizontal pair
        assert.isOk(box.children![0].children);
        assert.equal(box.children![0].children!.length, 2);
        assert.equal(box.children![0].children![0].leaf, 10);
        assert.equal(box.children![0].children![1].leaf, 20);
        // Second row: single leaf
        assert.equal(box.children![1].leaf, 30);
      });

      it("falls back to two-column default for 4 sections", function() {
        const box = parseLayoutSpec(undefined, [1, 2, 3, 4]);
        assert.isOk(box.children);
        assert.equal(box.children!.length, 2);
        // First row: horizontal pair
        assert.equal(box.children![0].children![0].leaf, 1);
        assert.equal(box.children![0].children![1].leaf, 2);
        // Second row: horizontal pair
        assert.equal(box.children![1].children![0].leaf, 3);
        assert.equal(box.children![1].children![1].leaf, 4);
      });
    });

    describe("computeLayout", function() {
      it("single leaf fills entire rect", function() {
        const box = { leaf: 10 };
        const rect: Rect = { top: 0, left: 0, width: 80, height: 24 };
        const result = computeLayout(box, rect, new Map([[10, 0]]));
        assert.equal(result.paneIndex, 0);
        assert.equal(result.width, 80);
        assert.equal(result.height, 24);
      });

      it("two children split vertically at root (even depth)", function() {
        const box = { children: [{ leaf: 10 }, { leaf: 20 }] };
        const map = new Map([[10, 0], [20, 1]]);
        const rect: Rect = { top: 0, left: 0, width: 80, height: 25 };
        const result = computeLayout(box, rect, map);
        assert.isOk(result.children);
        assert.equal(result.children!.length, 2);
        // Vertically split: heights + 1 border = 25
        const h0 = result.children![0].height;
        const h1 = result.children![1].height;
        assert.equal(h0 + 1 + h1, 25);
        // Both full width
        assert.equal(result.children![0].width, 80);
        assert.equal(result.children![1].width, 80);
        assert.equal(result.direction, "vertical");
      });

      it("nested children alternate H/V splits", function() {
        // Root (depth 0, vertical) has two children.
        // Second child (depth 1, horizontal) has two leaves.
        const box = {
          children: [
            { leaf: 10 },
            { children: [{ leaf: 20 }, { leaf: 30 }] },
          ],
        };
        const map = new Map([[10, 0], [20, 1], [30, 2]]);
        const rect: Rect = { top: 0, left: 0, width: 80, height: 25 };
        const result = computeLayout(box, rect, map);
        assert.equal(result.direction, "vertical");
        const secondChild = result.children![1];
        assert.equal(secondChild.direction, "horizontal");
        assert.equal(secondChild.children!.length, 2);
        // Horizontal split: widths + 1 border = secondChild.width
        const w0 = secondChild.children![0].width;
        const w1 = secondChild.children![1].width;
        assert.equal(w0 + 1 + w1, secondChild.width);
      });

      it("respects size proportions", function() {
        const box = {
          children: [
            { leaf: 10, size: 3 },
            { leaf: 20, size: 1 },
          ],
        };
        const map = new Map([[10, 0], [20, 1]]);
        const rect: Rect = { top: 0, left: 0, width: 80, height: 41 };
        const result = computeLayout(box, rect, map);
        const h0 = result.children![0].height;
        const h1 = result.children![1].height;
        // 3:1 ratio of 40 usable (41 - 1 border) = 30:10
        assert.equal(h0 + 1 + h1, 41);
        assert.isAbove(h0, h1);
      });

      it("single-child root flattens but preserves depth for H split", function() {
        // Typical Grist layout: root VBox has one child (a row/HBox) with two leaves side-by-side
        const box = {
          children: [{ children: [{ leaf: 10 }, { leaf: 20 }] }],
        };
        const map = new Map([[10, 0], [20, 1]]);
        const rect: Rect = { top: 0, left: 0, width: 81, height: 24 };
        const result = computeLayout(box, rect, map);
        // Should be horizontal split (side by side), not vertical
        assert.equal(result.direction, "horizontal");
        assert.equal(result.children!.length, 2);
        const w0 = result.children![0].width;
        const w1 = result.children![1].width;
        assert.equal(w0 + 1 + w1, 81); // widths + 1 border = total
        assert.equal(result.children![0].height, 24);
        assert.equal(result.children![1].height, 24);
      });

      it("default layout for 3 sections gives H-split top row + single bottom row", function() {
        // This is what the user sees when layoutSpec is empty (most documents)
        const sectionIds = [1, 4, 5];
        const box = parseLayoutSpec(undefined, sectionIds);
        const map = new Map([[1, 0], [4, 1], [5, 2]]);
        const rect: Rect = { top: 0, left: 0, width: 80, height: 25 };
        const result = computeLayout(box, rect, map);
        // Root is vertical (even depth)
        assert.equal(result.direction, "vertical");
        assert.equal(result.children!.length, 2);
        // First child is horizontal split with 2 panes side by side
        assert.equal(result.children![0].direction, "horizontal");
        assert.equal(result.children![0].children!.length, 2);
        assert.equal(result.children![0].children![0].paneIndex, 0);
        assert.equal(result.children![0].children![1].paneIndex, 1);
        // Second child is single pane filling the width
        assert.equal(result.children![1].paneIndex, 2);
        assert.equal(result.children![1].width, 80);
      });

      it("skips sections not in pane map", function() {
        const box = { children: [{ leaf: 10 }, { leaf: 99 }] };
        const map = new Map([[10, 0]]);
        const rect: Rect = { top: 0, left: 0, width: 80, height: 24 };
        const result = computeLayout(box, rect, map);
        // Only section 10 is valid, so it should fill the rect
        assert.equal(result.paneIndex, 0);
        assert.equal(result.width, 80);
      });
    });

    describe("getLayoutSpecForView", function() {
      it("returns layoutSpec for a known view", function() {
        const spec = getLayoutSpecForView(mockMetaTables, 2);
        assert.isOk(spec);
        const parsed = JSON.parse(spec!);
        assert.isOk(parsed.children);
      });

      it("returns undefined for unknown view", function() {
        assert.isUndefined(getLayoutSpecForView(mockMetaTables, 999));
      });
    });
  });

  describe("ConsoleRenderer multi-pane", function() {
    it("renders page picker with page names and indentation", function() {
      const state = createInitialState("testDoc");
      state.mode = "page_picker";
      state.pages = [
        { pageId: 1, viewId: 1, name: "People", indentation: 0 },
        { pageId: 2, viewId: 2, name: "Dashboard", indentation: 0 },
        { pageId: 3, viewId: 3, name: "Sub-page", indentation: 1 },
      ];
      state.selectedPageIndex = 1;
      const output = render(state);
      assert.include(output, "Select a Page");
      assert.include(output, "People");
      assert.include(output, "Dashboard");
      assert.include(output, "Sub-page");
    });

    it("renders two panes with data", function() {
      const state = createInitialState("testDoc");
      state.mode = "grid";
      state.panes = [
        makePane({
          sectionInfo: {
            sectionId: 1, tableRef: 1, tableId: "People", parentKey: "record",
            title: "People",
            linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
          },
          columns: [{ colId: "Name", type: "Text", label: "Name" }],
          rowIds: [1, 2],
          colValues: { Name: ["Alice", "Bob"] },
        }),
        makePane({
          sectionInfo: {
            sectionId: 2, tableRef: 2, tableId: "Projects", parentKey: "record",
            title: "Projects",
            linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
          },
          columns: [{ colId: "Title", type: "Text", label: "Title" }],
          rowIds: [1],
          colValues: { Title: ["Alpha"] },
        }),
      ];
      state.focusedPane = 0;
      // Build a simple vertical layout
      state.layout = {
        top: 0, left: 0, width: 80, height: 22,
        direction: "vertical",
        children: [
          { top: 0, left: 0, width: 80, height: 10, paneIndex: 0 },
          { top: 11, left: 0, width: 80, height: 11, paneIndex: 1 },
        ],
      };
      const output = render(state);
      assert.include(output, "People");
      assert.include(output, "Alice");
      assert.include(output, "Projects");
      assert.include(output, "Alpha");
    });
  });

  describe("Card pane navigation", function() {
    function makeCardState(): { state: ReturnType<typeof createInitialState>; pane: PaneState } {
      const state = createInitialState("testDoc");
      state.mode = "grid";
      const pane = makePane({
        sectionInfo: {
          sectionId: 1, tableRef: 1, tableId: "Dogs", parentKey: "single",
          title: "Dog Card",
          linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [
          { colId: "Name", type: "Text", label: "Name" },
          { colId: "Breed", type: "Text", label: "Breed" },
          { colId: "Age", type: "Int", label: "Age" },
        ],
        rowIds: [1, 2, 3],
        colValues: {
          Name: ["Rex", "Buddy", "Max"],
          Breed: ["Labrador", "Poodle", "Beagle"],
          Age: [3, 5, 2],
        },
      });
      state.panes = [pane];
      state.focusedPane = 0;
      state.layout = {
        top: 0, left: 0, width: 80, height: 22, paneIndex: 0,
      };
      return { state, pane };
    }

    function pressKey(state: ReturnType<typeof createInitialState>, key: string) {
      const buf = key === "right" ? Buffer.from([0x1b, 0x5b, 0x43])
        : key === "left" ? Buffer.from([0x1b, 0x5b, 0x44])
        : key === "down" ? Buffer.from([0x1b, 0x5b, 0x42])
        : key === "up" ? Buffer.from([0x1b, 0x5b, 0x41])
        : Buffer.from([key.charCodeAt(0)]);
      return handleKeypress(buf, state);
    }

    it("right arrow moves to next record in card pane", function() {
      const { state, pane } = makeCardState();
      assert.equal(pane.cursorRow, 0);
      const action = pressKey(state, "right");
      assert.equal(action.type, "render");
      assert.equal(pane.cursorRow, 1);
    });

    it("left arrow moves to previous record in card pane", function() {
      const { state, pane } = makeCardState();
      pane.cursorRow = 2;
      const action = pressKey(state, "left");
      assert.equal(action.type, "render");
      assert.equal(pane.cursorRow, 1);
    });

    it("left arrow at first record stays at 0", function() {
      const { state, pane } = makeCardState();
      assert.equal(pane.cursorRow, 0);
      pressKey(state, "left");
      assert.equal(pane.cursorRow, 0);
    });

    it("right arrow at last record stays at last", function() {
      const { state, pane } = makeCardState();
      pane.cursorRow = 2;
      pressKey(state, "right");
      assert.equal(pane.cursorRow, 2);
    });

    it("down arrow moves to next field in card pane", function() {
      const { state, pane } = makeCardState();
      assert.equal(pane.cursorCol, 0);
      pressKey(state, "down");
      assert.equal(pane.cursorCol, 1);
      pressKey(state, "down");
      assert.equal(pane.cursorCol, 2);
    });

    it("up arrow moves to previous field in card pane", function() {
      const { state, pane } = makeCardState();
      pane.cursorCol = 2;
      pressKey(state, "up");
      assert.equal(pane.cursorCol, 1);
    });

    it("renders card pane with field labels and values", function() {
      const { state } = makeCardState();
      const output = render(state);
      assert.include(output, "Dog Card");
      assert.include(output, "Name");
      assert.include(output, "Rex");
      assert.include(output, "Breed");
      assert.include(output, "Labrador");
    });

    it("renders different record after right arrow", function() {
      const { state, pane } = makeCardState();
      pressKey(state, "right");
      assert.equal(pane.cursorRow, 1);
      const output = render(state);
      assert.include(output, "Buddy");
      assert.include(output, "Poodle");
      // Should show record 2 of 3
      assert.include(output, "2/3");
    });

    it("right arrow in linked card pane moves source pane cursor", function() {
      const state = createInitialState("testDoc");
      state.mode = "grid";
      // Grid pane (source)
      const gridPane = makePane({
        sectionInfo: {
          sectionId: 10, tableRef: 1, tableId: "Dogs", parentKey: "record",
          title: "Dogs",
          linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [{ colId: "Name", type: "Text", label: "Name" }],
        rowIds: [1, 2, 3],
        colValues: { Name: ["Rex", "Buddy", "Max"] },
      });
      // Card pane (linked to grid via cursor sync)
      const cardPane = makePane({
        sectionInfo: {
          sectionId: 20, tableRef: 1, tableId: "Dogs", parentKey: "single",
          title: "Dog Card",
          linkSrcSectionRef: 10, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [
          { colId: "Name", type: "Text", label: "Name" },
          { colId: "Breed", type: "Text", label: "Breed" },
        ],
        rowIds: [1, 2, 3],
        colValues: { Name: ["Rex", "Buddy", "Max"], Breed: ["Lab", "Poodle", "Beagle"] },
      });
      state.panes = [gridPane, cardPane];
      state.focusedPane = 1; // Focus on card pane
      state.layout = {
        top: 0, left: 0, width: 80, height: 22,
        direction: "horizontal",
        children: [
          { top: 0, left: 0, width: 39, height: 22, paneIndex: 0 },
          { top: 0, left: 40, width: 40, height: 22, paneIndex: 1 },
        ],
      };

      // Press right in card pane — should move the SOURCE grid pane's cursor
      assert.equal(gridPane.cursorRow, 0);
      assert.equal(cardPane.cursorRow, 0);
      pressKey(state, "right");
      assert.equal(gridPane.cursorRow, 1, "source grid cursor should advance");
      // Card pane's cursor is controlled by linking, not directly
    });

    it("left arrow in linked card pane moves source pane cursor back", function() {
      const state = createInitialState("testDoc");
      state.mode = "grid";
      const gridPane = makePane({
        sectionInfo: {
          sectionId: 10, tableRef: 1, tableId: "Dogs", parentKey: "record",
          title: "Dogs",
          linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [{ colId: "Name", type: "Text", label: "Name" }],
        rowIds: [1, 2, 3],
        colValues: { Name: ["Rex", "Buddy", "Max"] },
        cursorRow: 2,
      });
      const cardPane = makePane({
        sectionInfo: {
          sectionId: 20, tableRef: 1, tableId: "Dogs", parentKey: "single",
          title: "Dog Card",
          linkSrcSectionRef: 10, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [{ colId: "Name", type: "Text", label: "Name" }],
        rowIds: [1, 2, 3],
        colValues: { Name: ["Rex", "Buddy", "Max"] },
        cursorRow: 2,
      });
      state.panes = [gridPane, cardPane];
      state.focusedPane = 1;
      state.layout = {
        top: 0, left: 0, width: 80, height: 22,
        direction: "horizontal",
        children: [
          { top: 0, left: 0, width: 39, height: 22, paneIndex: 0 },
          { top: 0, left: 40, width: 40, height: 22, paneIndex: 1 },
        ],
      };

      pressKey(state, "left");
      assert.equal(gridPane.cursorRow, 1, "source grid cursor should move back");
    });

    it("renders chart placeholder", function() {
      const state = createInitialState("testDoc");
      state.mode = "grid";
      state.panes = [makePane({
        sectionInfo: {
          sectionId: 1, tableRef: 1, tableId: "Data", parentKey: "chart",
          title: "My Chart",
          linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [],
        rowIds: [],
        colValues: {},
      })];
      state.focusedPane = 0;
      state.layout = { top: 0, left: 0, width: 80, height: 22, paneIndex: 0 };
      const output = render(state);
      assert.include(output, "My Chart");
      assert.include(output, "chart not supported");
    });
  });

  // Helper: build a PaneState for sort/filter tests with a default record
  // section and Text columns inferred from colValues keys.
  function makeRecordPane(rowIds: number[], colValues: Record<string, any[]>): PaneState {
    return makePane({
      sectionInfo: {
        sectionId: 1, tableRef: 1, tableId: "T", parentKey: "record",
        title: "", linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0,
        sortColRefs: "",
      },
      columns: Object.keys(colValues).map(colId => ({ colId, type: "Text", label: colId })),
      rowIds,
      colValues,
    });
  }

  describe("sorting", function() {
    const makePaneData = makeRecordPane;

    // Minimal metaTables with _grist_Tables_column mapping colRef -> colId
    function makeMetaWithCols(cols: Array<{ ref: number; colId: string }>) {
      return {
        _grist_Tables_column: [
          "TableData", "_grist_Tables_column",
          cols.map(c => c.ref),
          {
            colId: cols.map(c => c.colId),
            parentId: cols.map(() => 1),
            type: cols.map(() => "Text"),
            label: cols.map(c => c.colId),
          },
        ],
      };
    }

    it("sorts ascending by a single column", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Charlie", "Alice", "Bob"], Age: [35, 30, 25] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Name" }]);
      applySortSpec(pane, "[10]", meta);
      assert.deepEqual(pane.colValues.Name, ["Alice", "Bob", "Charlie"]);
      assert.deepEqual(pane.colValues.Age, [30, 25, 35]);
      assert.deepEqual(pane.rowIds, [2, 3, 1]);
    });

    it("sorts descending by a single column", function() {
      const pane = makePaneData([1, 2, 3], { Age: [30, 25, 35] });
      const meta = makeMetaWithCols([{ ref: 5, colId: "Age" }]);
      applySortSpec(pane, "[-5]", meta);
      assert.deepEqual(pane.colValues.Age, [35, 30, 25]);
      assert.deepEqual(pane.rowIds, [3, 1, 2]);
    });

    it("sorts by multiple columns", function() {
      const pane = makePaneData([1, 2, 3, 4], {
        City: ["NYC", "LA", "NYC", "LA"],
        Name: ["Bob", "Alice", "Alice", "Bob"],
      });
      const meta = makeMetaWithCols([{ ref: 10, colId: "City" }, { ref: 11, colId: "Name" }]);
      // Sort by City asc, then Name asc
      applySortSpec(pane, "[10, 11]", meta);
      assert.deepEqual(pane.colValues.City, ["LA", "LA", "NYC", "NYC"]);
      assert.deepEqual(pane.colValues.Name, ["Alice", "Bob", "Alice", "Bob"]);
    });

    it("handles string-format sort specs with flags", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Charlie", "Alice", "Bob"] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Name" }]);
      applySortSpec(pane, '["10:emptyLast;naturalSort"]', meta);
      assert.deepEqual(pane.colValues.Name, ["Alice", "Bob", "Charlie"]);
    });

    it("handles negative string-format sort specs", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Charlie", "Alice", "Bob"] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Name" }]);
      applySortSpec(pane, '["-10"]', meta);
      assert.deepEqual(pane.colValues.Name, ["Charlie", "Bob", "Alice"]);
    });

    it("does nothing with empty sort spec", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["C", "A", "B"] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Name" }]);
      applySortSpec(pane, "[]", meta);
      assert.deepEqual(pane.colValues.Name, ["C", "A", "B"]);
    });

    it("does nothing with invalid JSON", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["C", "A", "B"] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Name" }]);
      applySortSpec(pane, "not json", meta);
      assert.deepEqual(pane.colValues.Name, ["C", "A", "B"]);
    });

    it("sorts nulls before other values", function() {
      const pane = makePaneData([1, 2, 3], { Val: [10, null, 5] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Val" }]);
      applySortSpec(pane, "[10]", meta);
      assert.deepEqual(pane.colValues.Val, [null, 5, 10]);
    });

    // Section info defaults for the "default sort" tests below.
    const defaultSec = (tableId: string, sortColRefs: string) => ({
      sectionId: 1, tableRef: 1, tableId, parentKey: "record",
      title: "", linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0,
      sortColRefs,
    });
    const emptyMeta = {
      _grist_Tables_column: ["TableData", "_grist_Tables_column", [],
        { colId: [], parentId: [], type: [], label: [] }],
    };

    it("default: sorts by manualSort when sortColRefs is empty", function() {
      // rowIds returned by server may be in arbitrary order, but manualSort
      // defines the display order when no explicit sort is configured.
      const pane = makePane({
        sectionInfo: defaultSec("ToDo", ""),
        columns: [{ colId: "Task", type: "Text", label: "Task" }],
        rowIds: [1, 2, 3, 4],
        colValues: { Task: ["A", "B", "C", "D"], manualSort: [30, 10, 40, 20] },
      });
      reapplySortAndFilter(pane, emptyMeta);
      // Expected order by manualSort 10, 20, 30, 40: rowIds 2, 4, 1, 3
      assert.deepEqual(pane.rowIds, [2, 4, 1, 3]);
      assert.deepEqual(pane.colValues.Task, ["B", "D", "A", "C"]);
    });

    it("default: also handles sortColRefs = '[]'", function() {
      const pane = makePane({
        sectionInfo: defaultSec("ToDo", "[]"),
        columns: [{ colId: "Task", type: "Text", label: "Task" }],
        rowIds: [1, 2, 3],
        colValues: { Task: ["A", "B", "C"], manualSort: [20, 10, 30] },
      });
      reapplySortAndFilter(pane, emptyMeta);
      assert.deepEqual(pane.rowIds, [2, 1, 3]); // B(10), A(20), C(30)
    });

    it("default: no manualSort column -> no sorting", function() {
      const pane = makePane({
        sectionInfo: defaultSec("T", ""),
        columns: [{ colId: "Val", type: "Text", label: "Val" }],
        rowIds: [3, 1, 2],
        colValues: { Val: ["C", "A", "B"] },
      });
      reapplySortAndFilter(pane, emptyMeta);
      assert.deepEqual(pane.rowIds, [3, 1, 2]); // unchanged
    });
  });

  describe("compareCellValues", function() {
    it("compares numbers", function() {
      assert.isBelow(compareCellValues(1, 2), 0);
      assert.isAbove(compareCellValues(10, 3), 0);
      assert.equal(compareCellValues(5, 5), 0);
    });

    it("compares strings", function() {
      assert.isBelow(compareCellValues("apple", "banana"), 0);
      assert.isAbove(compareCellValues("z", "a"), 0);
    });

    it("puts null before other values", function() {
      assert.isBelow(compareCellValues(null, 1), 0);
      assert.isAbove(compareCellValues(1, null), 0);
      assert.equal(compareCellValues(null, null), 0);
    });

    it("compares booleans", function() {
      assert.isBelow(compareCellValues(false, true), 0);
      assert.isAbove(compareCellValues(true, false), 0);
    });
  });

  describe("filtering", function() {
    const makePaneData = makeRecordPane;

    function makeMetaWithFilters(
      cols: Array<{ ref: number; colId: string; type?: string }>,
      filters: Array<{ sectionId: number; colRef: number; filter: string }>
    ) {
      return {
        _grist_Tables_column: [
          "TableData", "_grist_Tables_column",
          cols.map(c => c.ref),
          {
            colId: cols.map(c => c.colId),
            parentId: cols.map(() => 1),
            type: cols.map(c => c.type || "Text"),
            label: cols.map(c => c.colId),
          },
        ],
        _grist_Filters: [
          "TableData", "_grist_Filters",
          filters.map((_, i) => i + 1),
          {
            viewSectionRef: filters.map(f => f.sectionId),
            colRef: filters.map(f => f.colRef),
            filter: filters.map(f => f.filter),
            pinned: filters.map(() => true),
          },
        ],
      };
    }

    it("applies inclusion filter", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Alice", "Bob", "Charlie"] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Name" }],
        [{ sectionId: 1, colRef: 10, filter: '{"included":["Alice","Charlie"]}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.colValues.Name, ["Alice", "Charlie"]);
      assert.deepEqual(pane.rowIds, [1, 3]);
    });

    it("applies exclusion filter", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Alice", "Bob", "Charlie"] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Name" }],
        [{ sectionId: 1, colRef: 10, filter: '{"excluded":["Bob"]}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.colValues.Name, ["Alice", "Charlie"]);
      assert.deepEqual(pane.rowIds, [1, 3]);
    });

    it("empty excluded means no filter", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Alice", "Bob", "Charlie"] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Name" }],
        [{ sectionId: 1, colRef: 10, filter: '{"excluded":[]}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.colValues.Name, ["Alice", "Bob", "Charlie"]);
    });

    it("applies range filter (min only)", function() {
      const pane = makePaneData([1, 2, 3], { Age: [20, 30, 40] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Age" }],
        [{ sectionId: 1, colRef: 10, filter: '{"min":25}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.colValues.Age, [30, 40]);
    });

    it("applies range filter (max only)", function() {
      const pane = makePaneData([1, 2, 3], { Age: [20, 30, 40] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Age" }],
        [{ sectionId: 1, colRef: 10, filter: '{"max":30}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.colValues.Age, [20, 30]);
    });

    it("applies range filter (min and max)", function() {
      const pane = makePaneData([1, 2, 3, 4], { Age: [10, 20, 30, 40] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Age" }],
        [{ sectionId: 1, colRef: 10, filter: '{"min":15,"max":35}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.colValues.Age, [20, 30]);
    });

    it("applies multiple filters across columns", function() {
      const pane = makePaneData([1, 2, 3, 4], {
        City: ["NYC", "LA", "NYC", "LA"],
        Age: [25, 30, 35, 20],
      });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "City" }, { ref: 11, colId: "Age" }],
        [
          { sectionId: 1, colRef: 10, filter: '{"included":["NYC"]}' },
          { sectionId: 1, colRef: 11, filter: '{"min":30}' },
        ]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.colValues.City, ["NYC"]);
      assert.deepEqual(pane.colValues.Age, [35]);
      assert.deepEqual(pane.rowIds, [3]);
    });

    it("ignores filters for other sections", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Alice", "Bob", "Charlie"] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Name" }],
        [{ sectionId: 99, colRef: 10, filter: '{"included":["Alice"]}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.colValues.Name, ["Alice", "Bob", "Charlie"]);
    });

    it("handles no _grist_Filters table", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Alice", "Bob", "Charlie"] });
      const meta = { _grist_Tables_column: ["TableData", "_grist_Tables_column", [], { colId: [], parentId: [], type: [], label: [] }] };
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.colValues.Name, ["Alice", "Bob", "Charlie"]);
    });

    it("filters ChoiceList by inclusion -- matches if any item is in set", function() {
      // Person is a ChoiceList, values like ["L", "Dmitry"] or ["L", "Paul", "Alice"]
      const pane = makePaneData([1, 2, 3, 4], {
        Person: [
          ["L", "Dmitry"],
          ["L", "Paul", "Alice"],
          ["L", "Bob"],
          null,
        ],
      });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Person", type: "ChoiceList" }],
        [{ sectionId: 1, colRef: 10, filter: '{"included":["Paul","Bob"]}' }]
      );
      applySectionFilters(pane, 1, meta);
      // Row 2 has Paul, row 3 has Bob -- both pass
      assert.deepEqual(pane.rowIds, [2, 3]);
    });

    it("filters ChoiceList by inclusion with null", function() {
      // Include rows where Person is null OR contains "Backlog"
      const pane = makePaneData([1, 2, 3, 4], {
        Person: [
          ["L", "Dmitry"],
          ["L", "Backlog"],
          null,
          ["L", "Paul"],
        ],
      });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Person", type: "ChoiceList" }],
        [{ sectionId: 1, colRef: 10, filter: '{"included":[null,"Backlog"]}' }]
      );
      applySectionFilters(pane, 1, meta);
      // Row 2 has Backlog, row 3 is null -- both pass
      assert.deepEqual(pane.rowIds, [2, 3]);
    });

    it("filters ChoiceList by exclusion", function() {
      const pane = makePaneData([1, 2, 3, 4], {
        Dept: [
          ["L", "MKT"],
          ["L", "Dev"],
          ["L", "📒 Docs"],
          ["L", "Sales"],
        ],
      });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Dept", type: "ChoiceList" }],
        [{ sectionId: 1, colRef: 10, filter: '{"excluded":["MKT","📒 Docs"]}' }]
      );
      applySectionFilters(pane, 1, meta);
      // Rows 2 and 4 remain (Dev, Sales)
      assert.deepEqual(pane.rowIds, [2, 4]);
    });

    it("filters RefList by inclusion -- matches if any row ID is in set", function() {
      // RefList values look like ["L", 412, 413]
      const pane = makePaneData([1, 2, 3], {
        Dates: [
          ["L", 412],
          ["L", 421, 422],
          ["L", 500],
        ],
      });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Dates", type: "RefList:Dates" }],
        [{ sectionId: 1, colRef: 10, filter: '{"included":[421,500]}' }]
      );
      applySectionFilters(pane, 1, meta);
      // Row 2 contains 421, row 3 is 500 -- both pass
      assert.deepEqual(pane.rowIds, [2, 3]);
    });

    it("filters ChoiceList with empty list using fallback", function() {
      // Empty ChoiceList should match "" in the filter set
      const pane = makePaneData([1, 2, 3], {
        Dept: [["L"], ["L", "Dev"], null],
      });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Dept", type: "ChoiceList" }],
        [{ sectionId: 1, colRef: 10, filter: '{"included":[""]}' }]
      );
      applySectionFilters(pane, 1, meta);
      // Only row 1 (empty list) passes
      assert.deepEqual(pane.rowIds, [1]);
    });
  });

  describe("extractFiltersForSection", function() {
    it("extracts filters for a section", function() {
      const meta = {
        _grist_Filters: [
          "TableData", "_grist_Filters",
          [1, 2, 3],
          {
            viewSectionRef: [10, 10, 20],
            colRef: [100, 200, 100],
            filter: ['{"included":["a"]}', '{"excluded":["b"]}', '{"min":5}'],
            pinned: [true, true, true],
          },
        ],
      };
      const filters = extractFiltersForSection(meta, 10);
      assert.equal(filters.size, 2);
      assert.equal(filters.get(100), '{"included":["a"]}');
      assert.equal(filters.get(200), '{"excluded":["b"]}');
    });

    it("returns empty map when no filters exist", function() {
      const meta = {
        _grist_Filters: [
          "TableData", "_grist_Filters",
          [],
          { viewSectionRef: [], colRef: [], filter: [], pinned: [] },
        ],
      };
      assert.equal(extractFiltersForSection(meta, 10).size, 0);
    });

    it("returns empty map when _grist_Filters is missing", function() {
      assert.equal(extractFiltersForSection({}, 10).size, 0);
    });
  });

  describe("displayWidth", function() {
    it("counts ASCII characters as width 1", function() {
      assert.equal(displayWidth("hello"), 5);
      assert.equal(displayWidth(""), 0);
      assert.equal(displayWidth("abc 123"), 7);
    });

    it("counts emoji as width 2", function() {
      assert.equal(displayWidth("\u{1F680}"), 2); // rocket
      assert.equal(displayWidth("\u2705"), 2);     // checkmark
      assert.equal(displayWidth("\u2764\uFE0F"), 2); // heart with variation selector
    });

    it("treats variation selectors correctly", function() {
      // U+2764 alone is text-style (1 cell), with VS16 it's emoji-style (2 cells)
      assert.equal(displayWidth("\u2764"), 1);
      assert.equal(displayWidth("\u2764\uFE0F"), 2);
    });

    it("handles mixed ASCII and emoji", function() {
      assert.equal(displayWidth("\u{1F680} WIP"), 6); // 2 + 1 + 3
      assert.equal(displayWidth("\u2705 Done"), 7);    // 2 + 1 + 4
      assert.equal(displayWidth("\u2764\uFE0F tag"), 6); // 2 + 1 + 3
    });

    it("counts flag emojis as width 2", function() {
      // US flag = regional indicator U + S
      assert.equal(displayWidth("\u{1F1FA}\u{1F1F8}"), 2);
      // Two flags
      assert.equal(displayWidth("\u{1F1FA}\u{1F1F8}\u{1F1EC}\u{1F1E7}"), 4);
    });

    it("applies flag pair delta when terminal disagrees", function() {
      // Simulate a terminal where flags render as 4 cells (two regional indicators)
      // instead of 2. String-width says 2, actual is 4, delta is +2.
      try {
        _setFlagPairDelta(2);
        assert.equal(displayWidth("\u{1F1FA}\u{1F1F8}"), 4); // one flag, +2 delta
        assert.equal(displayWidth("\u{1F1FA}\u{1F1F8}\u{1F1EC}\u{1F1E7}"), 8); // two flags, +4
        assert.equal(displayWidth("A\u{1F1FA}\u{1F1F8}B"), 6); // 1 + 4 + 1
      } finally {
        _setFlagPairDelta(0);
      }
    });

    it("ZWJ sequences: composing terminal (no calibration) sees composed width", function() {
      // With no calibration, uses string-width on whole string. Composed = 2.
      assert.equal(displayWidth("\u{1F468}\u200D\u{1F9B0}"), 2); // red-haired man
      assert.equal(displayWidth("\u{1F468}\u200D\u{1F4BB}"), 2); // man technologist
    });

    it("ZWJ sequences: walking mode sums char-by-char with VS16 composed", function() {
      // In walking mode, the VS16-composed handling gives base+VS16 as a
      // composed unit. For 🧙‍♀️ = mage(2) + ZWJ(0) + (♀+VS16 as composed)(2) = 4.
      // For fully-composing terminals, the background probe stores a specific
      // override for the composed sequence that takes priority.
      try {
        _setFlagPairDelta(2); // walking mode active
        assert.equal(displayWidth("\u{1F9D9}\u200D\u2640\uFE0F"), 4);
        // Red-haired man: mage is wide, ZWJ=0, 🦰 is wide, total 4
        assert.equal(displayWidth("\u{1F468}\u200D\u{1F9B0}"), 4);
      } finally {
        _setFlagPairDelta(0);
      }
    });

    it("VS16 delta applies to any char+VS16 pair, not just tested chars", function() {
      // Simulate a terminal where VS16 emojis render as 1 cell (text-style) instead of 2.
      // string-width says 2, actual is 1, delta is -1 per VS16.
      try {
        _setVs16Delta(-1);
        // Tested char
        assert.equal(displayWidth("\u2764\uFE0F"), 1); // heart + VS16: 2 + (-1) = 1
        // Other chars with VS16 should also get the delta
        assert.equal(displayWidth("\u2600\uFE0F"), 1); // sun + VS16
        assert.equal(displayWidth("\u26A0\uFE0F"), 1); // warning + VS16
        // Mixed: "hi ❤️ x" = h(1) + i(1) + sp(1) + ❤️(1) + sp(1) + x(1) = 6
        assert.equal(displayWidth("hi \u2764\uFE0F x"), 6);
      } finally {
        _setVs16Delta(0);
      }
    });

    it("VS16 delta of zero: uses string-width composed", function() {
      try {
        _setFlagPairDelta(2); // trigger walking without affecting VS16
        // Composed width used for char+VS16 in walking mode
        assert.equal(displayWidth("\u2764\uFE0F"), 2); // heart + VS16 = emoji-style, 2
        assert.equal(displayWidth("\u2600\uFE0F"), 2); // sun + VS16 = emoji-style, 2
      } finally {
        _setFlagPairDelta(0);
      }
    });
  });

  describe("countFlagPairs", function() {
    it("counts regional indicator pairs", function() {
      assert.equal(countFlagPairs(""), 0);
      assert.equal(countFlagPairs("hello"), 0);
      assert.equal(countFlagPairs("\u{1F1FA}\u{1F1F8}"), 1);
      assert.equal(countFlagPairs("\u{1F1FA}\u{1F1F8}\u{1F1EC}\u{1F1E7}"), 2);
      assert.equal(countFlagPairs("A\u{1F1FA}\u{1F1F8}B\u{1F1EC}\u{1F1E7}C"), 2);
      // Odd number of regional indicators -- only pairs count
      assert.equal(countFlagPairs("\u{1F1FA}"), 0);
    });
  });

  describe("probeChar", function() {
    it("returns false when not a TTY (no-op)", async function() {
      // In test environment stdin isn't a TTY, so probe can't run.
      _resetProbes();
      assert.isFalse(hasProbed("\u{1F600}"));
      const result = await probeChar("\u{1F600}");
      // Marked as probed (to avoid re-attempting) but no override added
      assert.isTrue(hasProbed("\u{1F600}"));
      assert.isFalse(result);
    });

    it("does not re-probe already-probed chars", async function() {
      _resetProbes();
      await probeChar("\u{1F600}");
      // Second call returns false without attempting
      const result = await probeChar("\u{1F600}");
      assert.isFalse(result);
    });
  });

  describe("extractCollapsedSectionIds", function() {
    it("extracts collapsed leaf IDs", function() {
      const box = {
        children: [{ leaf: 7 }],
        collapsed: [{ leaf: 4 }, { leaf: 5 }],
      };
      assert.deepEqual(extractCollapsedSectionIds(box), [4, 5]);
    });

    it("returns empty for no collapsed", function() {
      const box = { children: [{ leaf: 7 }] };
      assert.deepEqual(extractCollapsedSectionIds(box), []);
    });

    it("returns empty for empty collapsed array", function() {
      const box = { children: [{ leaf: 7 }], collapsed: [] };
      assert.deepEqual(extractCollapsedSectionIds(box), []);
    });
  });

  describe("collapsed widget overlay", function() {
    function makeCollapsedState(): ReturnType<typeof createInitialState> {
      const state = createInitialState("testDoc");
      state.mode = "grid";
      const visiblePane = makePane({
        sectionInfo: {
          sectionId: 7, tableRef: 2, tableId: "ToDo", parentKey: "record",
          title: "ToDo",
          linkSrcSectionRef: 4, linkSrcColRef: 0, linkTargetColRef: 17, sortColRefs: "",
        },
        columns: [{ colId: "Task", type: "Text", label: "Task" }],
        rowIds: [1, 2],
        colValues: { Task: ["Task A", "Task B"] },
      });
      const collapsedPane = makePane({
        sectionInfo: {
          sectionId: 4, tableRef: 1, tableId: "Dates", parentKey: "record",
          title: "Dates",
          linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [{ colId: "Label", type: "Text", label: "Label" }],
        rowIds: [1, 2, 3],
        colValues: { Label: ["Mon", "Tue", "Wed"] },
      });
      state.panes = [visiblePane, collapsedPane];
      state.collapsedPaneIndices = [1]; // pane index 1 is collapsed
      state.focusedPane = 0;
      state.layout = {
        top: 0, left: 0, width: 80, height: 22,
        paneIndex: 0,
      };
      return state;
    }

    it("pressing 1 opens overlay for first collapsed widget", function() {
      const state = makeCollapsedState();
      const action = handleKeypress(Buffer.from("1"), state);
      assert.equal(action.type, "render");
      assert.equal(state.mode, "overlay");
      assert.equal(state.overlayPaneIndex, 1);
    });

    it("pressing Escape in overlay returns to grid", function() {
      const state = makeCollapsedState();
      handleKeypress(Buffer.from("1"), state);
      assert.equal(state.mode, "overlay");
      const action = handleKeypress(Buffer.from("\x1b"), state);
      assert.equal(action.type, "close_overlay");
    });

    it("arrow keys navigate in overlay pane", function() {
      const state = makeCollapsedState();
      handleKeypress(Buffer.from("1"), state); // open overlay
      assert.equal(state.panes[1].cursorRow, 0);
      handleKeypress(Buffer.from("\x1b[B"), state); // down
      assert.equal(state.panes[1].cursorRow, 1);
      handleKeypress(Buffer.from("\x1b[B"), state); // down
      assert.equal(state.panes[1].cursorRow, 2);
    });

    it("number key beyond collapsed count does nothing", function() {
      const state = makeCollapsedState();
      const action = handleKeypress(Buffer.from("5"), state);
      assert.equal(action.type, "none");
      assert.equal(state.mode, "grid");
    });

    it("focusedPane stays on visible pane during overlay", function() {
      const state = makeCollapsedState();
      handleKeypress(Buffer.from("1"), state);
      assert.equal(state.focusedPane, 0, "focusedPane should remain on visible pane");
      assert.equal(state.overlayPaneIndex, 1);
    });
  });

  describe("flattenToLine", function() {
    it("replaces newlines with spaces", function() {
      assert.equal(flattenToLine("hello\nworld"), "hello world");
    });

    it("replaces tabs and carriage returns", function() {
      assert.equal(flattenToLine("a\tb\rc"), "a b c");
    });

    it("leaves normal text unchanged", function() {
      assert.equal(flattenToLine("hello world"), "hello world");
    });

    it("handles multiple consecutive newlines", function() {
      assert.equal(flattenToLine("a\n\n\nb"), "a   b");
    });
  });

  describe("editWindow", function() {
    it("shows text from start when cursor fits", function() {
      const { text, cursorOffset } = editWindow("hello", 3, 10);
      assert.equal(cursorOffset, 3);
      assert.include(text, "hello");
    });

    it("scrolls text when cursor is past visible area", function() {
      const { text, cursorOffset } = editWindow("abcdefghijklmnop", 14, 8);
      // Cursor at position 14, width 8 -- should scroll right
      assert.isAtMost(cursorOffset, 7); // cursor within window
      assert.include(text, "n"); // char at position 13 should be visible
    });

    it("handles cursor at position 0", function() {
      const { text, cursorOffset } = editWindow("hello", 0, 10);
      assert.equal(cursorOffset, 0);
      assert.include(text, "hello");
    });

    it("handles empty string", function() {
      const { text, cursorOffset } = editWindow("", 0, 10);
      assert.equal(cursorOffset, 0);
      assert.equal(text.trim(), "");
    });

    it("handles cursor at end of short string", function() {
      const { text, cursorOffset } = editWindow("hi", 2, 10);
      assert.equal(cursorOffset, 2);
    });
  });

  describe("applyChoiceColor", function() {
    it("applies fill and text color for Choice column", function() {
      const opts = {
        choiceOptions: {
          "Red": { fillColor: "#FF0000", textColor: "#FFFFFF" },
        },
      };
      const result = applyChoiceColor("Red", "Red", "Choice", opts);
      assert.include(result, "\x1b[48;2;255;0;0m"); // fill
      assert.include(result, "\x1b[38;2;255;255;255m"); // text
      assert.include(result, "Red");
      assert.include(result, "\x1b[0m"); // reset
    });

    it("returns plain text when no choiceOptions", function() {
      assert.equal(applyChoiceColor("hello", "hello", "Choice"), "hello");
    });

    it("returns plain text for non-choice column", function() {
      const opts = { choiceOptions: { "x": { fillColor: "#FF0000" } } };
      assert.equal(applyChoiceColor("hello", "hello", "Text", opts), "hello");
    });

    it("returns plain text when value has no color config", function() {
      const opts = { choiceOptions: { "Red": { fillColor: "#FF0000" } } };
      assert.equal(applyChoiceColor("Blue", "Blue", "Choice", opts), "Blue");
    });

    it("colors individual items in ChoiceList", function() {
      const opts = {
        choiceOptions: {
          "A": { fillColor: "#AA0000", textColor: "#FFFFFF" },
          "B": { fillColor: "#00BB00" },
        },
      };
      const result = applyChoiceColor("A, B", ["L", "A", "B"] as any, "ChoiceList", opts);
      assert.include(result, "\x1b[48;2;170;0;0m"); // A's fill
      assert.include(result, "\x1b[48;2;0;187;0m"); // B's fill
    });

    it("ChoiceList: returns plain formatted when truncated (preserves column width)", function() {
      // Repro of a real bug: when ChoiceList column width is calibrated from
      // the first 100 rows but a later row has more items, plainText gets
      // truncated to col.width but applyChoiceColor was rebuilding the full
      // untruncated colored string, causing column misalignment.
      const opts = {
        choiceOptions: {
          "Backlog": { fillColor: "#000000", textColor: "#FFFFFF" },
          "Jordi": { fillColor: "#E00A17", textColor: "#FFFFFF" },
        },
      };
      // formatted has been truncated (doesn't match the full joined value)
      const truncated = "Backl\u2026"; // "Backl…"
      const result = applyChoiceColor(
        truncated, ["L", "Backlog", "Jordi"] as any, "ChoiceList", opts,
      );
      // Should return the plain truncated text (not ANSI-colored full string)
      assert.equal(result, truncated);
      assert.notInclude(result, "\x1b[");
    });
  });

  describe("ensureColVisible", function() {
    function makePaneForScroll(colCount: number) {
      const columns: Array<{ colId: string; type: string; label: string }> = [];
      const colValues: Record<string, any[]> = {};
      for (let i = 0; i < colCount; i++) {
        const colId = `Col${i}`;
        columns.push({ colId, type: "Text", label: colId });
        colValues[colId] = ["short"]; // each col ~5 chars wide
      }
      return makePane({ columns, rowIds: [1], colValues });
    }

    it("does nothing when cursor is visible", function() {
      const pane = makePaneForScroll(5);
      pane.cursorCol = 2;
      ensureColVisible(pane, 200); // plenty of room
      assert.equal(pane.scrollCol, 0);
    });

    it("scrolls right when cursor is past visible area", function() {
      const pane = makePaneForScroll(20);
      pane.cursorCol = 15;
      ensureColVisible(pane, 40); // narrow -- only a few cols fit
      assert.isAbove(pane.scrollCol, 0);
      assert.isAtMost(pane.scrollCol, 15);
    });

    it("scrolls left when cursor is before scrollCol", function() {
      const pane = makePaneForScroll(10);
      pane.scrollCol = 5;
      pane.cursorCol = 2;
      ensureColVisible(pane, 200);
      assert.equal(pane.scrollCol, 2);
    });
  });

  describe("appendRowToColValues (AddRecord row insertion)", function() {
    it("appends to all columns including hidden ones", function() {
      const target = { Name: ["Alice"], Age: [30], manualSort: [10.5] };
      const columns = [
        { colId: "Name", type: "Text", label: "Name" },
        { colId: "Age", type: "Int", label: "Age" },
      ];
      // Server includes manualSort even though it's hidden
      appendRowToColValues(target, columns, { Name: "Bob", Age: 25, manualSort: 20.5 });
      assert.deepEqual(target.Name, ["Alice", "Bob"]);
      assert.deepEqual(target.Age, [30, 25]);
      assert.deepEqual(target.manualSort, [10.5, 20.5]);
    });

    it("uses defaults for visible columns missing in colValues", function() {
      const target = { Name: ["Alice"], Done: [false], manualSort: [10] };
      const columns = [
        { colId: "Name", type: "Text", label: "Name" },
        { colId: "Done", type: "Bool", label: "Done" },
      ];
      // Only manualSort in the action (simulating server's empty AddRecord broadcast)
      appendRowToColValues(target, columns, { manualSort: 30 });
      assert.deepEqual(target.Name, ["Alice", ""]); // Text default
      assert.deepEqual(target.Done, [false, false]); // Bool default
      assert.deepEqual(target.manualSort, [10, 30]);
    });

    it("keeps manualSort in sync so sort order stays correct", function() {
      // Reproduces the bug: if manualSort isn't appended, new row gets
      // undefined and sorts before all numbers.
      const target = {
        Name: ["First", "Second"],
        manualSort: [10, 20],
      };
      const columns = [{ colId: "Name", type: "Text", label: "Name" }];
      // Simulate server broadcast including manualSort
      appendRowToColValues(target, columns, { Name: "Third", manualSort: 30 });
      // Now check that sorting by manualSort gives [First, Second, Third]
      // (not [Third, First, Second] as the bug produced).
      const indices = [0, 1, 2];
      indices.sort((a, b) =>
        (target.manualSort[a] as number) - (target.manualSort[b] as number)
      );
      const sortedNames = indices.map(i => target.Name[i]);
      assert.deepEqual(sortedNames, ["First", "Second", "Third"]);
    });

    it("handles columns present in colValues but not yet in target", function() {
      const target: any = { Name: ["Alice"], Age: [30] };
      const columns = [
        { colId: "Name", type: "Text", label: "Name" },
        { colId: "Age", type: "Int", label: "Age" },
      ];
      // Unknown column "NewCol" in the action
      appendRowToColValues(target, columns, { Name: "Bob", NewCol: "surprise" });
      assert.deepEqual(target.Name, ["Alice", "Bob"]);
      // Previous row padded with null, new value added
      assert.deepEqual(target.NewCol, [null, "surprise"]);
    });
  });

  describe("applyDocActions (schema-change handling)", function() {
    function stateWithPane(): ReturnType<typeof createInitialState> {
      const s = createInitialState("test");
      s.currentTableId = "People";
      s.panes = [makePane({
        columns: [{ colId: "Name", type: "Text", label: "Name" }],
        rowIds: [1, 2],
        colValues: { Name: ["Alice", "Bob"] },
      })];
      return s;
    }

    it("sets schemaStale on AddColumn / RemoveColumn / RenameColumn / ModifyColumn", function() {
      for (const op of ["AddColumn", "RemoveColumn", "RenameColumn", "ModifyColumn"]) {
        const s = stateWithPane();
        applyDocActions(s, [[op, "People", "X", { type: "Text" }] as any]);
        assert.isTrue(s.schemaStale, `${op} should set schemaStale`);
      }
    });

    it("skips data actions later in the same broadcast after a schema change", function() {
      const s = stateWithPane();
      applyDocActions(s, [
        ["RenameColumn", "People", "Name", "FullName"] as any,
        ["UpdateRecord", "People", 1, { Name: "Alicia" }] as any,
      ]);
      assert.isTrue(s.schemaStale);
      // The UpdateRecord must not have been applied -- our column metadata is
      // stale, applying the change might write under a renamed/dropped colId.
      assert.deepEqual(s.panes[0].colValues.Name, ["Alice", "Bob"]);
    });

    it("skips all subsequent broadcasts while stale", function() {
      const s = stateWithPane();
      s.schemaStale = true;
      applyDocActions(s, [["UpdateRecord", "People", 1, { Name: "Alicia" }] as any]);
      assert.deepEqual(s.panes[0].colValues.Name, ["Alice", "Bob"]);
    });

    it("applies normal data actions when schema is fresh", function() {
      const s = stateWithPane();
      applyDocActions(s, [["UpdateRecord", "People", 1, { Name: "Alicia" }] as any]);
      assert.isFalse(s.schemaStale);
      assert.deepEqual(s.panes[0].colValues.Name, ["Alicia", "Bob"]);
    });
  });

  describe("undo stack (handleOwnActionGroup)", function() {
    function freshState() {
      const s = createInitialState("test");
      return s;
    }
    function ag(num: number, hash = `h${num}`, extras: any = {}) {
      return { actionNum: num, actionHash: hash, ...extras };
    }

    it("pushes new edits and advances pointer", function() {
      const s = freshState();
      handleOwnActionGroup(s, ag(1));
      assert.deepEqual(s.undoStack.map(e => e.actionNum), [1]);
      assert.equal(s.undoPointer, 1);
      handleOwnActionGroup(s, ag(2));
      handleOwnActionGroup(s, ag(3));
      assert.deepEqual(s.undoStack.map(e => e.actionNum), [1, 2, 3]);
      assert.equal(s.undoPointer, 3);
    });

    it("undo broadcast moves pointer to the entry being undone (matched by otherId)", function() {
      const s = freshState();
      handleOwnActionGroup(s, ag(1));
      handleOwnActionGroup(s, ag(2));
      // Pointer starts at 2 (after both pushes). User presses undo.
      // Broadcast arrives with isUndo=true and otherId=2 (the action being undone).
      handleOwnActionGroup(s, ag(99, "h99", { isUndo: true, otherId: 2 }));
      assert.deepEqual(s.undoStack.map(e => e.actionNum), [1, 2]);
      // Pointer set to the index of the undone entry (1), so the next
      // undo would step to entry at index 0.
      assert.equal(s.undoPointer, 1);
    });

    it("undo broadcast for an unknown action falls through to the trim+no-push path", function() {
      const s = freshState();
      handleOwnActionGroup(s, ag(1));
      handleOwnActionGroup(s, ag(2));
      // Server confirms an undo for actionNum=99 -- not in our stack
      // (capped off, or from a prior session). otherId is set, so we
      // don't push it; trim to current pointer is a no-op.
      handleOwnActionGroup(s, ag(99, "h99", { isUndo: true, otherId: 99 }));
      assert.deepEqual(s.undoStack.map(e => e.actionNum), [1, 2]);
      assert.equal(s.undoPointer, 2);
    });

    it("redo broadcast advances pointer past the entry it redid (matched by otherId)", function() {
      const s = freshState();
      handleOwnActionGroup(s, ag(1));
      handleOwnActionGroup(s, ag(2));
      // User undid both -- broadcasts moved pointer to 0
      handleOwnActionGroup(s, ag(98, "h98", { isUndo: true, otherId: 2 }));
      handleOwnActionGroup(s, ag(99, "h99", { isUndo: true, otherId: 1 }));
      assert.equal(s.undoPointer, 0);
      // User presses redo. Broadcast for the redo carries otherId=1 (the
      // original action's actionNum) and a new actionNum (10).
      handleOwnActionGroup(s, ag(10, "h10", { otherId: 1 }));
      // Stack unchanged; pointer set to the index after the redone entry.
      assert.deepEqual(s.undoStack.map(e => e.actionNum), [1, 2]);
      assert.equal(s.undoPointer, 1);
    });

    it("server's causal broadcast order keeps state consistent with concurrent " +
       "fresh edits", function() {
      // User presses 'u' to undo C, then 'a' to add a new edit Z, both
      // before 'u' has resolved. Server processes them in causal order
      // and broadcasts in that order. We just replay the broadcasts.
      const s = freshState();
      handleOwnActionGroup(s, ag(1));   // A
      handleOwnActionGroup(s, ag(2));   // B
      handleOwnActionGroup(s, ag(3));   // C
      assert.equal(s.undoPointer, 3);

      // Broadcast 1: undo of C arrives. Pointer drops to 2.
      handleOwnActionGroup(s, ag(50, "h50", { isUndo: true, otherId: 3 }));
      assert.equal(s.undoPointer, 2);

      // Broadcast 2: fresh edit Z arrives. Trim slice(0, 2)=[A, B];
      // push Z; pointer=3. Crucially, C is gone -- it was undone, then
      // a new edit invalidated the redo tail.
      handleOwnActionGroup(s, ag(60, "h60"));
      assert.deepEqual(s.undoStack.map(e => e.actionNum), [1, 2, 60]);
      assert.equal(s.undoPointer, 3);
    });

    it("redo of an action no longer in the stack is silently dropped", function() {
      const s = freshState();
      handleOwnActionGroup(s, ag(1));
      handleOwnActionGroup(s, ag(2));
      // User undid both: pointer=0
      handleOwnActionGroup(s, ag(98, "h98", { isUndo: true, otherId: 2 }));
      handleOwnActionGroup(s, ag(99, "h99", { isUndo: true, otherId: 1 }));
      // User makes a fresh edit, trimming the redo tail.
      handleOwnActionGroup(s, ag(20, "h20"));
      assert.deepEqual(s.undoStack.map(e => e.actionNum), [20]);

      // Now the (stale) redo broadcast for action 1 arrives -- entry 1
      // is gone. otherId is set, so the no-push path triggers; pointer
      // gets set to current stack length.
      handleOwnActionGroup(s, ag(21, "h21", { otherId: 1 }));
      assert.deepEqual(s.undoStack.map(e => e.actionNum), [20]);
      assert.equal(s.undoPointer, 1);
    });

    it("new edit after undo trims the redo tail", function() {
      const s = freshState();
      handleOwnActionGroup(s, ag(1));
      handleOwnActionGroup(s, ag(2));
      handleOwnActionGroup(s, ag(3));
      // User undoes twice: pointer=1
      s.undoPointer = 1;
      // User makes a new edit
      handleOwnActionGroup(s, ag(10));
      // Stack should be [1, 10] (2 and 3 discarded as redo tail)
      assert.deepEqual(s.undoStack.map(e => e.actionNum), [1, 10]);
      assert.equal(s.undoPointer, 2);
    });

    it("ignores malformed action groups", function() {
      const s = freshState();
      handleOwnActionGroup(s, { actionNum: 0, actionHash: "h0" } as any);
      handleOwnActionGroup(s, { actionNum: 1, actionHash: "" } as any);
      assert.equal(s.undoStack.length, 0);
      assert.equal(s.undoPointer, 0);
    });

    it("caps stack at 100 entries and keeps pointer in sync", function() {
      const s = freshState();
      for (let i = 1; i <= 120; i++) {
        handleOwnActionGroup(s, ag(i, `h${i}`));
      }
      assert.equal(s.undoStack.length, 100);
      assert.equal(s.undoPointer, 100);
      // Oldest entries should have been dropped
      assert.equal(s.undoStack[0].actionNum, 21);
      assert.equal(s.undoStack[99].actionNum, 120);
    });
  });

  describe("getVisualPaneOrder", function() {
    function emptyPane(sectionId: number): PaneState {
      return makePane({
        sectionInfo: {
          sectionId, tableRef: 1, tableId: "T", parentKey: "record",
          title: "", linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0,
          sortColRefs: "",
        },
        columns: [], rowIds: [], colValues: {},
      });
    }

    it("returns panes in layout-tree leaf order (top-to-bottom, left-to-right)", function() {
      // Layout with two panes side-by-side on top, one pane below:
      //   [0][1]
      //   [ 2 ]
      // But state.panes is in metadata order [2, 0, 1]
      const state = createInitialState("testDoc");
      state.panes = [emptyPane(30), emptyPane(10), emptyPane(20)];
      state.layout = {
        top: 0, left: 0, width: 80, height: 24, direction: "vertical",
        children: [
          {
            top: 0, left: 0, width: 80, height: 12, direction: "horizontal",
            children: [
              { top: 0, left: 0, width: 40, height: 12, paneIndex: 1 },  // upper-left
              { top: 0, left: 40, width: 40, height: 12, paneIndex: 2 }, // upper-right
            ],
          },
          { top: 12, left: 0, width: 80, height: 12, paneIndex: 0 }, // bottom
        ],
      };
      state.collapsedPaneIndices = [];
      const order = getVisualPaneOrder(state);
      // Visual order: upper-left, upper-right, bottom = pane indices [1, 2, 0]
      assert.deepEqual(order, [1, 2, 0]);
    });

    it("excludes collapsed panes from visual order", function() {
      const state = createInitialState("testDoc");
      state.panes = [emptyPane(10), emptyPane(20), emptyPane(30)];
      state.layout = {
        top: 0, left: 0, width: 80, height: 24, direction: "vertical",
        children: [
          { top: 0, left: 0, width: 80, height: 12, paneIndex: 0 },
          { top: 12, left: 0, width: 80, height: 12, paneIndex: 2 },
        ],
      };
      state.collapsedPaneIndices = [1];
      const order = getVisualPaneOrder(state);
      assert.deepEqual(order, [0, 2]);
    });

    it("falls back to pane-array order when no layout", function() {
      const state = createInitialState("testDoc");
      state.panes = [emptyPane(10), emptyPane(20), emptyPane(30)];
      state.layout = null;
      state.collapsedPaneIndices = [1];
      const order = getVisualPaneOrder(state);
      assert.deepEqual(order, [0, 2]);
    });
  });

  describe("table picker key handling", function() {
    it("p switches to pages when pages exist", function() {
      const state = createInitialState("testDoc");
      state.mode = "table_picker";
      state.tableIds = ["People"];
      state.pages = [{ pageId: 1, viewId: 1, name: "Page 1", indentation: 0 }];
      const action = handleKeypress(Buffer.from("p"), state);
      assert.equal(action.type, "switch_to_pages");
    });

    it("Escape also switches to pages", function() {
      const state = createInitialState("testDoc");
      state.mode = "table_picker";
      state.tableIds = ["People"];
      state.pages = [{ pageId: 1, viewId: 1, name: "Page 1", indentation: 0 }];
      const action = handleKeypress(Buffer.from("\x1b"), state);
      assert.equal(action.type, "switch_to_pages");
    });

    it("p does nothing when no pages exist", function() {
      const state = createInitialState("testDoc");
      state.mode = "table_picker";
      state.tableIds = ["People"];
      state.pages = [];
      const action = handleKeypress(Buffer.from("p"), state);
      assert.equal(action.type, "none");
    });
  });

  describe("cell viewer key handling", function() {
    function makeCellViewerState(content: string) {
      const state = createInitialState("testDoc");
      state.mode = "cell_viewer";
      state.cellViewerContent = content;
      state.cellViewerScroll = 0;
      state.cellViewerLinkIndex = -1;
      return state;
    }

    it("o cycles through links", function() {
      const state = makeCellViewerState("See https://example.com and https://other.com");
      handleKeypress(Buffer.from("o"), state);
      assert.equal(state.cellViewerLinkIndex, 0);
      handleKeypress(Buffer.from("o"), state);
      assert.equal(state.cellViewerLinkIndex, 1);
      handleKeypress(Buffer.from("o"), state);
      assert.equal(state.cellViewerLinkIndex, 0); // wraps
    });

    it("o does nothing when no links", function() {
      const state = makeCellViewerState("no links here");
      const action = handleKeypress(Buffer.from("o"), state);
      assert.equal(action.type, "none");
      assert.equal(state.cellViewerLinkIndex, -1);
    });

    it("Enter opens selected link", function() {
      const state = makeCellViewerState("Visit https://example.com now");
      handleKeypress(Buffer.from("o"), state); // select first link
      const action = handleKeypress(Buffer.from("\r"), state);
      assert.equal(action.type, "open_url");
      if (action.type === "open_url") {
        assert.equal(action.url, "https://example.com");
      }
    });

    it("Enter edits when no link selected", function() {
      const state = makeCellViewerState("just text");
      // Need pane data for edit mode
      state.panes = [makeRecordPane([1], { Name: ["just text"] })];
      state.focusedPane = 0;
      handleKeypress(Buffer.from("\r"), state);
      assert.equal(state.mode, "editing");
      // cellViewerContent should be preserved so viewer stays open
      assert.equal(state.cellViewerContent, "just text");
    });

    it("Escape closes viewer and resets link index", function() {
      const state = makeCellViewerState("https://example.com");
      handleKeypress(Buffer.from("o"), state);
      assert.equal(state.cellViewerLinkIndex, 0);
      handleKeypress(Buffer.from("\x1b"), state);
      assert.equal(state.mode, "grid");
      assert.equal(state.cellViewerContent, "");
      assert.equal(state.cellViewerLinkIndex, -1);
    });

    it("up/down scrolls content", function() {
      const longContent = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
      const state = makeCellViewerState(longContent);
      assert.equal(state.cellViewerScroll, 0);
      handleKeypress(Buffer.from("\x1b[B"), state); // down
      assert.equal(state.cellViewerScroll, 1);
      handleKeypress(Buffer.from("\x1b[A"), state); // up
      assert.equal(state.cellViewerScroll, 0);
    });
  });

  describe("JSON config file", function() {
    it("parseGristDocUrl handles /doc/urlid form", function() {
      const result = parseGristDocUrl("https://gristlabs.getgrist.com/doc/check-ins");
      assert.equal(result?.serverUrl, "https://gristlabs.getgrist.com");
      assert.equal(result?.docId, "check-ins");
      assert.isUndefined(result?.pageId);
    });

    it("parseGristDocUrl handles /doc/urlid/p/N form", function() {
      const result = parseGristDocUrl("https://gristlabs.getgrist.com/doc/check-ins/p/3");
      assert.deepEqual(result, {
        serverUrl: "https://gristlabs.getgrist.com",
        docId: "check-ins",
        pageId: 3,
      });
    });
  });

  describe("parseGristDocUrl", function() {
    it("parses standard doc URL", function() {
      const result = parseGristDocUrl("https://docs.getgrist.com/hQHXqAQXceeQ/My-Doc");
      assert.equal(result?.serverUrl, "https://docs.getgrist.com");
      assert.equal(result?.docId, "hQHXqAQXceeQ");
      assert.isUndefined(result?.pageId);
    });

    it("parses URL with page", function() {
      const result = parseGristDocUrl("https://templates.getgrist.com/hQHXqAQXceeQ/Personal-Notebook/p/32");
      assert.deepEqual(result, { serverUrl: "https://templates.getgrist.com", docId: "hQHXqAQXceeQ", pageId: 32 });
    });

    it("parses /doc/ form with page", function() {
      const result = parseGristDocUrl("https://myserver.com/doc/abc123def456/p/5");
      assert.deepEqual(result, { serverUrl: "https://myserver.com", docId: "abc123def456", pageId: 5 });
    });

    it("parses /o/org/ prefix with page", function() {
      const result = parseGristDocUrl("https://docs.getgrist.com/o/myorg/doc/abc123def456/p/12");
      assert.deepEqual(result, { serverUrl: "https://docs.getgrist.com", docId: "abc123def456", pageId: 12 });
    });

    it("returns no pageId when no /p/ suffix", function() {
      const result = parseGristDocUrl("https://docs.getgrist.com/hQHXqAQXceeQ/My-Doc");
      assert.isUndefined(result?.pageId);
    });

    it("parses /p/1 (page 1)", function() {
      const result = parseGristDocUrl("https://docs.getgrist.com/hQHXqAQXceeQ/slug/p/1");
      assert.equal(result?.pageId, 1);
    });

    it("strips fork suffixes", function() {
      const result = parseGristDocUrl("https://docs.getgrist.com/hQHXqAQXceeQ~fork123/slug/p/7");
      assert.equal(result?.docId, "hQHXqAQXceeQ");
      assert.equal(result?.pageId, 7);
    });

    it("returns null for invalid URL", function() {
      assert.isNull(parseGristDocUrl("not-a-url"));
    });

    it("returns null for URL with no doc ID", function() {
      assert.isNull(parseGristDocUrl("https://docs.getgrist.com/"));
    });
  });

  // ===================== Robustness gap tests =====================

  describe("applyDocActionToPane (edge cases via applyDocActions)", function() {
    function paneState(rowIds: number[], colValues: Record<string, any[]>) {
      const s = createInitialState("test");
      s.currentTableId = "T";
      s.panes = [makePane({
        columns: Object.keys(colValues).map(k => ({ colId: k, type: "Text", label: k })),
        rowIds,
        colValues,
      })];
      return s;
    }

    it("BulkUpdateRecord with mixed-known/unknown rowIds skips the unknowns", function() {
      const s = paneState([1, 2, 3], { Name: ["A", "B", "C"] });
      // Row 99 doesn't exist in the pane; rows 1 and 3 do.
      applyDocActions(s, [
        ["BulkUpdateRecord", "T", [1, 99, 3], { Name: ["A2", "Bogus", "C2"] }] as any,
      ]);
      assert.deepEqual(s.panes[0].colValues.Name, ["A2", "B", "C2"]);
      // allColValues should also be updated
      assert.deepEqual(s.panes[0].allColValues.Name, ["A2", "B", "C2"]);
    });

    it("UpdateRecord against an unknown column is silently ignored", function() {
      const s = paneState([1, 2], { Name: ["A", "B"] });
      // Server adds a column we don't know about (filtered out as hidden).
      applyDocActions(s, [
        ["UpdateRecord", "T", 1, { Name: "A2", SecretCol: "x" }] as any,
      ]);
      assert.deepEqual(s.panes[0].colValues.Name, ["A2", "B"]);
      // The unknown column should NOT have been added to colValues.
      assert.notProperty(s.panes[0].colValues, "SecretCol");
    });

    it("UpdateRecord on a row in allRowIds but filtered out only updates allColValues", function() {
      const s = paneState([1, 2, 3], { Name: ["A", "B", "C"] });
      // Simulate a filter: row 2 is in allRowIds but not visible.
      s.panes[0].rowIds = [1, 3];
      s.panes[0].colValues = { Name: ["A", "C"] };

      applyDocActions(s, [["UpdateRecord", "T", 2, { Name: "B2" }] as any]);

      // allColValues holds the truth for row 2.
      assert.deepEqual(s.panes[0].allColValues.Name, ["A", "B2", "C"]);
      // The visible view doesn't contain row 2, so colValues is unchanged.
      assert.deepEqual(s.panes[0].colValues.Name, ["A", "C"]);
    });

    it("RemoveRecord on a visible row clamps the cursor", function() {
      const s = paneState([1, 2, 3], { Name: ["A", "B", "C"] });
      s.panes[0].cursorRow = 2; // on row 3 (last)
      applyDocActions(s, [["RemoveRecord", "T", 3] as any]);
      // Pane shrunk to 2 rows; cursor clamped to last index (1).
      assert.deepEqual(s.panes[0].rowIds, [1, 2]);
      assert.equal(s.panes[0].cursorRow, 1);
    });

    it("BulkRemoveRecord removes all matched rows in one pass and clamps once", function() {
      const s = paneState([1, 2, 3, 4], { Name: ["A", "B", "C", "D"] });
      s.panes[0].cursorRow = 3;
      applyDocActions(s, [["BulkRemoveRecord", "T", [2, 4]] as any]);
      assert.deepEqual(s.panes[0].rowIds, [1, 3]);
      assert.equal(s.panes[0].cursorRow, 1);
    });

    it("RemoveRecord on an unknown rowId is a no-op", function() {
      const s = paneState([1, 2], { Name: ["A", "B"] });
      applyDocActions(s, [["RemoveRecord", "T", 99] as any]);
      assert.deepEqual(s.panes[0].rowIds, [1, 2]);
      assert.deepEqual(s.panes[0].colValues.Name, ["A", "B"]);
    });
  });

  describe("Commands.executeSaveEdit (ParseError catch)", function() {
    // Minimal stand-in for ConsoleConnection -- only applyUserActions is touched.
    function makeFakeConn() {
      const calls: any[][] = [];
      return {
        calls,
        applyUserActions: async (actions: any[]) => {
          calls.push(actions);
          return {};
        },
      } as any;
    }

    function editingState(colType: string, editValue: string) {
      const s = createInitialState("test");
      s.mode = "editing";
      s.currentTableId = "T";
      s.panes = [makePane({
        columns: [{ colId: "Age", type: colType, label: "Age" }],
        rowIds: [1, 2],
        colValues: { Age: [10, 20] },
      })];
      s.editValue = editValue;
      return s;
    }

    it("rejects invalid input without sending an RPC", async function() {
      const s = editingState("Int", "not-a-number");
      const conn = makeFakeConn();
      await executeSaveEdit(s, conn);
      assert.equal(conn.calls.length, 0, "no RPC should be sent for invalid input");
      assert.equal(s.mode, "editing", "should stay in edit mode so user can fix");
      assert.match(s.statusMessage, /Invalid Int value/);
    });

    it("sends RPC and exits edit mode for valid input", async function() {
      const s = editingState("Int", "42");
      const conn = makeFakeConn();
      await executeSaveEdit(s, conn);
      assert.equal(conn.calls.length, 1);
      assert.deepEqual(conn.calls[0], [["UpdateRecord", "T", 1, { Age: 42 }]]);
      assert.notEqual(s.mode, "editing", "should leave edit mode after save");
      assert.equal(s.statusMessage, "Saved");
    });

    it("propagates non-ParseError errors as a status message", async function() {
      const s = editingState("Int", "42");
      const conn = {
        applyUserActions: async () => { throw new Error("network down"); },
      } as any;
      await executeSaveEdit(s, conn);
      assert.match(s.statusMessage, /Error.*network down/);
    });
  });

  describe("LinkingState section linking variants", function() {
    // Build a state with two panes: a source (pane 0) and a target (pane 1)
    // linked according to the link* refs on the target's sectionInfo.
    function linkedPanes(opts: {
      srcRowIds: number[]; srcColValues: Record<string, any[]>;
      tgtRowIds: number[]; tgtColValues: Record<string, any[]>;
      linkSrcColRef: number; linkTargetColRef: number;
      tgtColIdForRef?: string; // colId in target whose colRef is linkTargetColRef
      srcColIdForRef?: string; // colId in source whose colRef is linkSrcColRef
    }) {
      const s = createInitialState("test");
      s.panes = [
        makePane({
          sectionInfo: {
            sectionId: 100, tableRef: 1, tableId: "Src", parentKey: "record",
            title: "Src", linkSrcSectionRef: 0, linkSrcColRef: 0,
            linkTargetColRef: 0, sortColRefs: "",
          },
          columns: Object.keys(opts.srcColValues).map(k => ({ colId: k, type: "Text", label: k })),
          rowIds: opts.srcRowIds,
          colValues: opts.srcColValues,
        }),
        makePane({
          sectionInfo: {
            sectionId: 200, tableRef: 2, tableId: "Tgt", parentKey: "record",
            title: "Tgt", linkSrcSectionRef: 100,
            linkSrcColRef: opts.linkSrcColRef,
            linkTargetColRef: opts.linkTargetColRef,
            sortColRefs: "",
          },
          columns: Object.keys(opts.tgtColValues).map(k => ({ colId: k, type: "Text", label: k })),
          rowIds: opts.tgtRowIds,
          colValues: opts.tgtColValues,
        }),
      ];
      // Build a metaTables that maps the link colRefs back to colIds
      const colIds: string[] = [];
      const colRefs: number[] = [];
      const parentIds: number[] = [];
      if (opts.linkTargetColRef && opts.tgtColIdForRef) {
        colIds.push(opts.tgtColIdForRef);
        colRefs.push(opts.linkTargetColRef);
        parentIds.push(2);
      }
      if (opts.linkSrcColRef && opts.srcColIdForRef) {
        colIds.push(opts.srcColIdForRef);
        colRefs.push(opts.linkSrcColRef);
        parentIds.push(1);
      }
      const meta = {
        _grist_Tables_column: ["TableData", "_grist_Tables_column", colRefs,
          { colId: colIds, parentId: parentIds, type: colIds.map(() => "Text"), label: colIds }],
      };
      return { state: s, meta };
    }

    it("cursor sync (both refs 0): target cursor follows source rowId", function() {
      const { state, meta } = linkedPanes({
        srcRowIds: [10, 20, 30], srcColValues: { Name: ["A", "B", "C"] },
        tgtRowIds: [10, 20, 30], tgtColValues: { Note: ["x", "y", "z"] },
        linkSrcColRef: 0, linkTargetColRef: 0,
      });
      state.panes[0].cursorRow = 1; // source on row 20
      applyAllSectionLinks(state, meta);
      // Target should have cursor on the rowId matching source (rowId 20 → idx 1)
      assert.equal(state.panes[1].cursorRow, 1);
    });

    it("filter-by-rowId (srcColRef=0, tgtColRef>0): show target rows where target.tgtCol == source.rowId", function() {
      const { state, meta } = linkedPanes({
        srcRowIds: [1, 2], srcColValues: { Name: ["A", "B"] },
        tgtRowIds: [10, 11, 12, 13],
        tgtColValues: { Owner: [1, 2, 1, 2], Task: ["t1", "t2", "t3", "t4"] },
        linkSrcColRef: 0, linkTargetColRef: 50, tgtColIdForRef: "Owner",
      });
      state.panes[0].cursorRow = 0; // source row 1
      applyAllSectionLinks(state, meta);
      // Target should show rows where Owner == 1 → rowIds 10 and 12
      assert.deepEqual(state.panes[1].rowIds, [10, 12]);
      assert.deepEqual(state.panes[1].colValues.Task, ["t1", "t3"]);
    });

    it("filter-by-value (srcColRef>0, tgtColRef>0): show target rows where target.tgtCol == source.srcColValue", function() {
      const { state, meta } = linkedPanes({
        srcRowIds: [1, 2], srcColValues: { Tag: ["red", "blue"] },
        tgtRowIds: [10, 11, 12],
        tgtColValues: { Color: ["red", "blue", "red"], Name: ["a", "b", "c"] },
        linkSrcColRef: 40, linkTargetColRef: 50,
        srcColIdForRef: "Tag", tgtColIdForRef: "Color",
      });
      state.panes[0].cursorRow = 0; // source row 1, Tag = "red"
      applyAllSectionLinks(state, meta);
      // Target should show rows where Color == "red" → rowIds 10, 12
      assert.deepEqual(state.panes[1].rowIds, [10, 12]);
      assert.deepEqual(state.panes[1].colValues.Name, ["a", "c"]);
    });

    it("cursor-follows-ref (srcColRef>0, tgtColRef=0): target cursor follows source's ref-column value", function() {
      const { state, meta } = linkedPanes({
        srcRowIds: [1, 2, 3], srcColValues: { TgtRef: [30, 10, 20] },
        tgtRowIds: [10, 20, 30], tgtColValues: { Name: ["a", "b", "c"] },
        linkSrcColRef: 40, linkTargetColRef: 0, srcColIdForRef: "TgtRef",
      });
      state.panes[0].cursorRow = 0; // source row 1, TgtRef = 30
      applyAllSectionLinks(state, meta);
      // Target rows are unfiltered; cursor should land on rowId 30 (idx 2)
      assert.equal(state.panes[1].cursorRow, 2);
    });
  });

  describe("handleEditKey (edit-mode buffer)", function() {
    function editing(value = "", cursor?: number) {
      const s = createInitialState("test");
      s.mode = "editing";
      s.editValue = value;
      s.editCursorPos = cursor ?? value.length;
      return s;
    }

    it("inserts a character at cursor position", function() {
      const s = editing("ab", 1); // cursor between a and b
      handleKeypress(Buffer.from("X"), s);
      assert.equal(s.editValue, "aXb");
      assert.equal(s.editCursorPos, 2);
    });

    it("inserts multi-byte UTF-8 characters", function() {
      const s = editing("a", 1);
      // é (U+00E9) as UTF-8 is two bytes: 0xc3 0xa9
      handleKeypress(Buffer.from([0xc3, 0xa9]), s);
      assert.equal(s.editValue, "aé");
    });

    it("backspace deletes char before cursor; no-op at start", function() {
      const s = editing("abc", 2);
      handleKeypress(Buffer.from([0x7f]), s); // backspace
      assert.equal(s.editValue, "ac");
      assert.equal(s.editCursorPos, 1);
      // At start: no-op
      const s2 = editing("abc", 0);
      handleKeypress(Buffer.from([0x7f]), s2);
      assert.equal(s2.editValue, "abc");
    });

    it("delete removes char at cursor; no-op at end", function() {
      const s = editing("abc", 1);
      handleKeypress(Buffer.from([0x1b, 0x5b, 0x33, 0x7e]), s); // ESC[3~ = delete
      assert.equal(s.editValue, "ac");
      assert.equal(s.editCursorPos, 1);
      const s2 = editing("abc", 3);
      handleKeypress(Buffer.from([0x1b, 0x5b, 0x33, 0x7e]), s2);
      assert.equal(s2.editValue, "abc");
    });

    it("left/right arrows move within bounds", function() {
      const s = editing("abc", 1);
      handleKeypress(Buffer.from([0x1b, 0x5b, 0x44]), s); // left
      assert.equal(s.editCursorPos, 0);
      handleKeypress(Buffer.from([0x1b, 0x5b, 0x44]), s); // left at 0 = no-op
      assert.equal(s.editCursorPos, 0);
      handleKeypress(Buffer.from([0x1b, 0x5b, 0x43]), s); // right
      assert.equal(s.editCursorPos, 1);
    });

    it("Enter requests save_edit", function() {
      const s = editing("hello");
      const action = handleKeypress(Buffer.from("\r"), s);
      assert.equal(action.type, "save_edit");
    });

    it("Escape exits edit mode without saving", function() {
      const s = editing("hello");
      handleKeypress(Buffer.from([0x1b]), s);
      assert.notEqual(s.mode, "editing");
    });
  });

  describe("themes", function() {
    // Smoke test: every registered theme should render a grid and a picker
    // without throwing, and produce non-empty output with the data visible.
    // Covers new themes (dos / matrix / c64) alongside the originals.
    for (const name of getThemeNames()) {
      it(`theme '${name}' renders grid + picker without errors`, function() {
        const theme = getTheme(name);

        // Grid render
        const grid = createInitialState("t", theme);
        grid.mode = "grid";
        grid.currentTableId = "People";
        grid.panes = [makePane({
          columns: [{ colId: "Name", type: "Text", label: "Name" }],
          rowIds: [1, 2],
          colValues: { Name: ["Alice", "Bob"] },
        })];
        grid.focusedPane = 0;
        // Rainbow-style themes inject ANSI between characters, so search
        // the ANSI-stripped output for the substring.
        const gridText = stripAnsi(render(grid));
        assert.include(gridText, "Alice");
        assert.include(gridText, "Bob");

        // Picker render
        const picker = createInitialState("t", theme);
        picker.mode = "table_picker";
        picker.tableIds = ["People", "Tasks"];
        const pickText = stripAnsi(render(picker));
        assert.include(pickText, "People");
        assert.include(pickText, "Tasks");
      });
    }
  });

  describe("GoatAnimation", function() {
    beforeEach(() => resetGoat());

    function goatState() {
      const s = createInitialState("t");
      s.focusedPane = 0;
      s.panes = [makePane({
        columns: [
          { colId: "A", type: "Text", label: "A" },
          { colId: "B", type: "Text", label: "B" },
          { colId: "C", type: "Text", label: "C" },
        ],
        rowIds: [1, 2, 3, 4, 5],
        colValues: {
          A: ["a1", "a2", "a3", "a4", "a5"],
          B: ["b1", "b2", "b3", "b4", "b5"],
          C: ["c1", "c2", "c3", "c4", "c5"],
        },
      })];
      return s;
    }

    it("places a goat in the focused pane and avoids the cursor cell", function() {
      const s = goatState();
      s.panes[0].cursorRow = 2;
      s.panes[0].cursorCol = 1;
      // 30 steps: goat should never land on (cursorRow, cursorCol).
      for (let i = 0; i < 30; i++) {
        stepGoat(s);
        const g = getGoat()!;
        assert.isOk(g, "goat should exist");
        assert.notEqual(
          `${g.rowIdx},${g.colIdx}`,
          `${s.panes[0].cursorRow},${s.panes[0].cursorCol}`,
          `goat landed on cursor at step ${i}`
        );
        assert.isAtLeast(g.rowIdx, 0);
        assert.isBelow(g.rowIdx, 5);
        assert.isAtLeast(g.colIdx, 0);
        assert.isBelow(g.colIdx, 3);
      }
    });

    it("renderGoatOverlay is empty on card panes", function() {
      const s = createInitialState("t");
      s.focusedPane = 0;
      s.panes = [makePane({
        sectionInfo: {
          sectionId: 1, tableRef: 1, tableId: "T", parentKey: "single",
          title: "T", linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0,
          sortColRefs: "",
        },
        columns: [{ colId: "Name", type: "Text", label: "Name" }],
        rowIds: [1, 2, 3],
        colValues: { Name: ["a", "b", "c"] },
      })];
      s.layout = { top: 0, left: 0, width: 80, height: 22, paneIndex: 0 };
      stepGoat(s);
      const out = renderGoatOverlay(s, 0, 24, 80);
      assert.equal(out, "", "goat sprite should skip card panes");
    });

    it("goat stays within the visible scroll window on big tables", function() {
      // 500-row pane with scrollRow near the middle. The goat must
      // consistently land inside [scrollRow, scrollRow + ~20) -- on the
      // pre-fix code it would randomly land anywhere and be clipped.
      const s = createInitialState("t");
      s.focusedPane = 0;
      const rowIds = Array.from({ length: 500 }, (_, i) => i + 1);
      const names = rowIds.map(i => `Name${i}`);
      s.panes = [makePane({
        columns: [{ colId: "Name", type: "Text", label: "Name" }],
        rowIds,
        colValues: { Name: names },
      })];
      s.panes[0].scrollRow = 200;
      for (let i = 0; i < 30; i++) {
        stepGoat(s);
        const g = getGoat()!;
        assert.isAtLeast(g.rowIdx, 200,
          `step ${i}: goat at row ${g.rowIdx} is above scroll`);
        // Upper bound: scrollRow + visibleRows (depends on process.stdout.rows;
        // in tests this may be undefined -> 24; 24 - 6 - 3 = 15 visible rows).
        assert.isBelow(g.rowIdx, 200 + 30,
          `step ${i}: goat at row ${g.rowIdx} is below visible window`);
      }
    });

    it("renderGoatOverlay is empty when goat is scrolled out of view", function() {
      const s = goatState();
      s.layout = { top: 0, left: 0, width: 80, height: 22, paneIndex: 0 };
      stepGoat(s);
      // Scroll way past the goat -- it's off the top of the visible area.
      s.panes[0].scrollRow = 100;
      const out = renderGoatOverlay(s, 0, 24, 80);
      assert.equal(out, "");
    });

    it("renderGoatOverlay emits sprite lines when a goat is placed", function() {
      const s = goatState();
      s.layout = { top: 0, left: 0, width: 80, height: 22, paneIndex: 0 };
      // Step until the goat lands somewhere the whole sprite fits (not
      // the top-most row, where the top horn line would be clipped by
      // the header). Random wandering finds it quickly.
      for (let i = 0; i < 50 && (!getGoat() || getGoat()!.rowIdx < 1); i++) {
        stepGoat(s);
      }
      assert.isAtLeast(getGoat()!.rowIdx, 1);
      const out = renderGoatOverlay(s, 0, 24, 80);
      // Compact sprite: curly-horn line ))_(( and ear+eye line.
      assert.match(out, /\)\)_\(\(/, "overlay should include the curly horns");
      assert.match(out, /\^0 0\^|\^o o\^/,
        "overlay should include the sprite's ears + eyes");
    });

    it("records a trail across multiple steps", function() {
      const s = goatState();
      stepGoat(s);
      stepGoat(s);
      const g = getGoat()!;
      assert.isAtLeast(g.trail.length, 1, "trail should grow by one per step");
      assert.equal(g.trail[0].paneIdx, 0);
    });

    it("resets when the focused pane has no rows / no cols", function() {
      const s = goatState();
      stepGoat(s);
      assert.isOk(getGoat());

      // Simulate switching to an empty pane
      s.panes[0] = makePane({ columns: [], rowIds: [], colValues: {} });
      stepGoat(s);
      assert.isNull(getGoat(), "goat should disappear on an empty pane");
    });

    it("munchCount increments on each step", function() {
      const s = goatState();
      stepGoat(s);
      assert.equal(getGoat()!.munchCount, 1);
      stepGoat(s);
      stepGoat(s);
      assert.equal(getGoat()!.munchCount, 3);
    });

    it("goatStatus reports cell + count and cycles verbs across steps", function() {
      const s = goatState();
      s.currentTableId = "People";
      const verbs = new Set<string>();
      for (let i = 0; i < 10; i++) {
        stepGoat(s);
        const status = goatStatus(s);
        assert.isOk(status);
        assert.match(status!, /\u{1F410}/u, "status should include the goat emoji");
        assert.match(status!, /nibbles$/, "status should end with nibble count");
        // Grab the verb (first word after the emoji)
        const m = status!.match(/\u{1F410}\s+(\w+)/u);
        if (m) { verbs.add(m[1]); }
      }
      // Across 10 steps we should see more than one verb -- they cycle.
      assert.isAbove(verbs.size, 1, "multiple munch verbs should cycle");
    });
  });

  describe("clearViewState", function() {
    it("resets pane / layout / boxSpec / focused / overlay / collapsed / schemaStale", function() {
      const s = createInitialState("test");
      s.panes = [makePane({ columns: [], rowIds: [], colValues: {} })];
      s.layout = { top: 0, left: 0, width: 1, height: 1, paneIndex: 0 };
      s.boxSpec = { leaf: 1 };
      s.focusedPane = 5;
      s.overlayPaneIndex = 3;
      s.collapsedPaneIndices = [0, 2];
      s.schemaStale = true;

      clearViewState(s);

      assert.deepEqual(s.panes, []);
      assert.isNull(s.layout);
      assert.isNull(s.boxSpec);
      assert.equal(s.focusedPane, 0);
      assert.isNull(s.overlayPaneIndex);
      assert.deepEqual(s.collapsedPaneIndices, []);
      assert.isFalse(s.schemaStale, "switching mode should clear stale-schema warning too");
    });

    it("preserves unrelated state (mode, theme, status, undo stack)", function() {
      const s = createInitialState("test");
      s.mode = "page_picker";
      s.statusMessage = "hi";
      s.undoStack = [{ actionNum: 1, actionHash: "h1" }];
      s.undoPointer = 1;
      clearViewState(s);
      assert.equal(s.mode, "page_picker");
      assert.equal(s.statusMessage, "hi");
      assert.deepEqual(s.undoStack, [{ actionNum: 1, actionHash: "h1" }]);
      assert.equal(s.undoPointer, 1);
    });
  });
});
