import { formatCellValue, parseCellInput } from "../src/ConsoleCellFormat";
import {
  extractPages, extractSectionsForView, extractFieldsForSection,
  extractFiltersForSection,
  getColumnInfo, getColIdByRef, parseLayoutSpec, computeLayout,
  getLayoutSpecForView, Rect,
} from "../src/ConsoleLayout";
import { createInitialState, render, PaneState } from "../src/ConsoleRenderer";
import { handleKeypress } from "../src/ConsoleInput";
import { applySortSpec, applySectionFilters, compareCellValues } from "../src/ConsoleMain";
import { parseGristDocUrl } from "../src/index";
import { GristObjCode } from "../src/types";

import { assert } from "chai";

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
        assert.equal(parseCellInput("abc", "Int"), "abc");
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

      it("returns string for unparseable input", function() {
        assert.equal(parseCellInput("not-a-date", "Date"), "not-a-date");
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
      state.columns = [
        { colId: "Name", type: "Text", label: "Name" },
        { colId: "Age", type: "Int", label: "Age" },
      ];
      state.rowIds = [1, 2];
      state.colValues = {
        Name: ["Alice", "Bob"],
        Age: [30, 25],
      };
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
      state.columns = [
        { colId: "A", type: "Text", label: "A" },
      ];
      state.rowIds = [];
      state.colValues = { A: [] };
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
        {
          sectionInfo: {
            sectionId: 1, tableRef: 1, tableId: "People", parentKey: "record",
            title: "People",
            linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
          },
          columns: [
            { colId: "Name", type: "Text", label: "Name" },
          ],
          rowIds: [1, 2],
          allRowIds: [1, 2],
          colValues: { Name: ["Alice", "Bob"] },
          allColValues: { Name: ["Alice", "Bob"] },
          cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
        },
        {
          sectionInfo: {
            sectionId: 2, tableRef: 2, tableId: "Projects", parentKey: "record",
            title: "Projects",
            linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
          },
          columns: [
            { colId: "Title", type: "Text", label: "Title" },
          ],
          rowIds: [1],
          allRowIds: [1],
          colValues: { Title: ["Alpha"] },
          allColValues: { Title: ["Alpha"] },
          cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
        },
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
      const pane: PaneState = {
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
        allRowIds: [1, 2, 3],
        colValues: {
          Name: ["Rex", "Buddy", "Max"],
          Breed: ["Labrador", "Poodle", "Beagle"],
          Age: [3, 5, 2],
        },
        allColValues: {
          Name: ["Rex", "Buddy", "Max"],
          Breed: ["Labrador", "Poodle", "Beagle"],
          Age: [3, 5, 2],
        },
        cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
      };
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
      const gridPane: PaneState = {
        sectionInfo: {
          sectionId: 10, tableRef: 1, tableId: "Dogs", parentKey: "record",
          title: "Dogs",
          linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [
          { colId: "Name", type: "Text", label: "Name" },
        ],
        rowIds: [1, 2, 3],
        allRowIds: [1, 2, 3],
        colValues: { Name: ["Rex", "Buddy", "Max"] },
        allColValues: { Name: ["Rex", "Buddy", "Max"] },
        cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
      };
      // Card pane (linked to grid via cursor sync)
      const cardPane: PaneState = {
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
        allRowIds: [1, 2, 3],
        colValues: { Name: ["Rex", "Buddy", "Max"], Breed: ["Lab", "Poodle", "Beagle"] },
        allColValues: { Name: ["Rex", "Buddy", "Max"], Breed: ["Lab", "Poodle", "Beagle"] },
        cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
      };
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
      const gridPane: PaneState = {
        sectionInfo: {
          sectionId: 10, tableRef: 1, tableId: "Dogs", parentKey: "record",
          title: "Dogs",
          linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [{ colId: "Name", type: "Text", label: "Name" }],
        rowIds: [1, 2, 3],
        allRowIds: [1, 2, 3],
        colValues: { Name: ["Rex", "Buddy", "Max"] },
        allColValues: { Name: ["Rex", "Buddy", "Max"] },
        cursorRow: 2, cursorCol: 0, scrollRow: 0, scrollCol: 0,
      };
      const cardPane: PaneState = {
        sectionInfo: {
          sectionId: 20, tableRef: 1, tableId: "Dogs", parentKey: "single",
          title: "Dog Card",
          linkSrcSectionRef: 10, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [{ colId: "Name", type: "Text", label: "Name" }],
        rowIds: [1, 2, 3],
        allRowIds: [1, 2, 3],
        colValues: { Name: ["Rex", "Buddy", "Max"] },
        allColValues: { Name: ["Rex", "Buddy", "Max"] },
        cursorRow: 2, cursorCol: 0, scrollRow: 0, scrollCol: 0,
      };
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
      state.panes = [{
        sectionInfo: {
          sectionId: 1, tableRef: 1, tableId: "Data", parentKey: "chart",
          title: "My Chart",
          linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0, sortColRefs: "",
        },
        columns: [],
        rowIds: [], allRowIds: [],
        colValues: {}, allColValues: {},
        cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
      }];
      state.focusedPane = 0;
      state.layout = { top: 0, left: 0, width: 80, height: 22, paneIndex: 0 };
      const output = render(state);
      assert.include(output, "My Chart");
      assert.include(output, "chart not supported");
    });
  });

  describe("sorting", function() {
    // Helper: build a minimal PaneState with allRowIds/allColValues
    function makePaneData(rowIds: number[], colValues: Record<string, any[]>): PaneState {
      return {
        sectionInfo: {
          sectionId: 1, tableRef: 1, tableId: "T", parentKey: "record",
          title: "", linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0,
          sortColRefs: "",
        },
        columns: Object.keys(colValues).map(colId => ({ colId, type: "Text", label: colId })),
        rowIds: [...rowIds],
        allRowIds: [...rowIds],
        colValues: Object.fromEntries(Object.entries(colValues).map(([k, v]) => [k, [...v]])),
        allColValues: Object.fromEntries(Object.entries(colValues).map(([k, v]) => [k, [...v]])),
        cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
      };
    }

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
      assert.deepEqual(pane.allColValues.Name, ["Alice", "Bob", "Charlie"]);
      assert.deepEqual(pane.allColValues.Age, [30, 25, 35]);
      assert.deepEqual(pane.allRowIds, [2, 3, 1]);
    });

    it("sorts descending by a single column", function() {
      const pane = makePaneData([1, 2, 3], { Age: [30, 25, 35] });
      const meta = makeMetaWithCols([{ ref: 5, colId: "Age" }]);
      applySortSpec(pane, "[-5]", meta);
      assert.deepEqual(pane.allColValues.Age, [35, 30, 25]);
      assert.deepEqual(pane.allRowIds, [3, 1, 2]);
    });

    it("sorts by multiple columns", function() {
      const pane = makePaneData([1, 2, 3, 4], {
        City: ["NYC", "LA", "NYC", "LA"],
        Name: ["Bob", "Alice", "Alice", "Bob"],
      });
      const meta = makeMetaWithCols([{ ref: 10, colId: "City" }, { ref: 11, colId: "Name" }]);
      // Sort by City asc, then Name asc
      applySortSpec(pane, "[10, 11]", meta);
      assert.deepEqual(pane.allColValues.City, ["LA", "LA", "NYC", "NYC"]);
      assert.deepEqual(pane.allColValues.Name, ["Alice", "Bob", "Alice", "Bob"]);
    });

    it("handles string-format sort specs with flags", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Charlie", "Alice", "Bob"] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Name" }]);
      applySortSpec(pane, '["10:emptyLast;naturalSort"]', meta);
      assert.deepEqual(pane.allColValues.Name, ["Alice", "Bob", "Charlie"]);
    });

    it("handles negative string-format sort specs", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Charlie", "Alice", "Bob"] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Name" }]);
      applySortSpec(pane, '["-10"]', meta);
      assert.deepEqual(pane.allColValues.Name, ["Charlie", "Bob", "Alice"]);
    });

    it("does nothing with empty sort spec", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["C", "A", "B"] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Name" }]);
      applySortSpec(pane, "[]", meta);
      assert.deepEqual(pane.allColValues.Name, ["C", "A", "B"]);
    });

    it("does nothing with invalid JSON", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["C", "A", "B"] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Name" }]);
      applySortSpec(pane, "not json", meta);
      assert.deepEqual(pane.allColValues.Name, ["C", "A", "B"]);
    });

    it("sorts nulls before other values", function() {
      const pane = makePaneData([1, 2, 3], { Val: [10, null, 5] });
      const meta = makeMetaWithCols([{ ref: 10, colId: "Val" }]);
      applySortSpec(pane, "[10]", meta);
      assert.deepEqual(pane.allColValues.Val, [null, 5, 10]);
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
    function makePaneData(rowIds: number[], colValues: Record<string, any[]>): PaneState {
      return {
        sectionInfo: {
          sectionId: 1, tableRef: 1, tableId: "T", parentKey: "record",
          title: "", linkSrcSectionRef: 0, linkSrcColRef: 0, linkTargetColRef: 0,
          sortColRefs: "",
        },
        columns: Object.keys(colValues).map(colId => ({ colId, type: "Text", label: colId })),
        rowIds: [...rowIds],
        allRowIds: [...rowIds],
        colValues: Object.fromEntries(Object.entries(colValues).map(([k, v]) => [k, [...v]])),
        allColValues: Object.fromEntries(Object.entries(colValues).map(([k, v]) => [k, [...v]])),
        cursorRow: 0, cursorCol: 0, scrollRow: 0, scrollCol: 0,
      };
    }

    function makeMetaWithFilters(
      cols: Array<{ ref: number; colId: string }>,
      filters: Array<{ sectionId: number; colRef: number; filter: string }>
    ) {
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
      assert.deepEqual(pane.allColValues.Name, ["Alice", "Charlie"]);
      assert.deepEqual(pane.allRowIds, [1, 3]);
    });

    it("applies exclusion filter", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Alice", "Bob", "Charlie"] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Name" }],
        [{ sectionId: 1, colRef: 10, filter: '{"excluded":["Bob"]}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.allColValues.Name, ["Alice", "Charlie"]);
      assert.deepEqual(pane.allRowIds, [1, 3]);
    });

    it("empty excluded means no filter", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Alice", "Bob", "Charlie"] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Name" }],
        [{ sectionId: 1, colRef: 10, filter: '{"excluded":[]}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.allColValues.Name, ["Alice", "Bob", "Charlie"]);
    });

    it("applies range filter (min only)", function() {
      const pane = makePaneData([1, 2, 3], { Age: [20, 30, 40] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Age" }],
        [{ sectionId: 1, colRef: 10, filter: '{"min":25}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.allColValues.Age, [30, 40]);
    });

    it("applies range filter (max only)", function() {
      const pane = makePaneData([1, 2, 3], { Age: [20, 30, 40] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Age" }],
        [{ sectionId: 1, colRef: 10, filter: '{"max":30}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.allColValues.Age, [20, 30]);
    });

    it("applies range filter (min and max)", function() {
      const pane = makePaneData([1, 2, 3, 4], { Age: [10, 20, 30, 40] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Age" }],
        [{ sectionId: 1, colRef: 10, filter: '{"min":15,"max":35}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.allColValues.Age, [20, 30]);
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
      assert.deepEqual(pane.allColValues.City, ["NYC"]);
      assert.deepEqual(pane.allColValues.Age, [35]);
      assert.deepEqual(pane.allRowIds, [3]);
    });

    it("ignores filters for other sections", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Alice", "Bob", "Charlie"] });
      const meta = makeMetaWithFilters(
        [{ ref: 10, colId: "Name" }],
        [{ sectionId: 99, colRef: 10, filter: '{"included":["Alice"]}' }]
      );
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.allColValues.Name, ["Alice", "Bob", "Charlie"]);
    });

    it("handles no _grist_Filters table", function() {
      const pane = makePaneData([1, 2, 3], { Name: ["Alice", "Bob", "Charlie"] });
      const meta = { _grist_Tables_column: ["TableData", "_grist_Tables_column", [], { colId: [], parentId: [], type: [], label: [] }] };
      applySectionFilters(pane, 1, meta);
      assert.deepEqual(pane.allColValues.Name, ["Alice", "Bob", "Charlie"]);
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
});
