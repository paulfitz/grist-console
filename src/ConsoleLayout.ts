import { ColumnInfo } from "./types";

/**
 * Metadata types extracted from _metaTables.
 */
export interface PageInfo {
  pageId: number;
  viewId: number;
  name: string;
  indentation: number;
}

export interface SectionInfo {
  sectionId: number;
  tableRef: number;
  tableId: string;
  parentKey: string;
  title: string;
  linkSrcSectionRef: number;
  linkSrcColRef: number;
  linkTargetColRef: number;
  sortColRefs: string;
}

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface LayoutNode extends Rect {
  paneIndex?: number;
  direction?: "horizontal" | "vertical";
  children?: LayoutNode[];
}

export interface BoxSpec {
  leaf?: number;
  children?: BoxSpec[];
  size?: number;
  collapsed?: BoxSpec[];
}

/**
 * Extract sorted page list from metadata.
 */
export function extractPages(metaTables: any): PageInfo[] {
  const pagesData = metaTables._grist_Pages;
  const viewsData = metaTables._grist_Views;
  if (!pagesData || !viewsData) { return []; }

  const pageIds: number[] = pagesData[2];
  const pageVals = pagesData[3];
  const viewIds: number[] = viewsData[2];
  const viewVals = viewsData[3];

  // Build a map from viewId to view name
  const viewNameMap = new Map<number, string>();
  for (let i = 0; i < viewIds.length; i++) {
    viewNameMap.set(viewIds[i], viewVals.name[i] || "");
  }

  const pages: Array<PageInfo & { pagePos: number }> = [];
  for (let i = 0; i < pageIds.length; i++) {
    const viewRef = pageVals.viewRef[i];
    pages.push({
      pageId: pageIds[i],
      viewId: viewRef,
      name: viewNameMap.get(viewRef) || `View ${viewRef}`,
      indentation: pageVals.indentation?.[i] || 0,
      pagePos: pageVals.pagePos?.[i] || i,
    });
  }

  pages.sort((a, b) => a.pagePos - b.pagePos);
  return pages.map(({ pagePos, ...rest }) => rest);
}

/**
 * Extract sections for a given view.
 */
export function extractSectionsForView(metaTables: any, viewId: number): SectionInfo[] {
  const sectionsData = metaTables._grist_Views_section;
  const tablesData = metaTables._grist_Tables;
  if (!sectionsData || !tablesData) { return []; }

  const sectionIds: number[] = sectionsData[2];
  const sectionVals = sectionsData[3];
  const tableIds: number[] = tablesData[2];
  const tableVals = tablesData[3];

  // Build tableRef -> tableId map
  const tableIdMap = new Map<number, string>();
  for (let i = 0; i < tableIds.length; i++) {
    tableIdMap.set(tableIds[i], tableVals.tableId[i]);
  }

  const sections: SectionInfo[] = [];
  for (let i = 0; i < sectionIds.length; i++) {
    if (sectionVals.parentId[i] !== viewId) { continue; }
    const tableRef = sectionVals.tableRef[i];
    sections.push({
      sectionId: sectionIds[i],
      tableRef,
      tableId: tableIdMap.get(tableRef) || "",
      parentKey: sectionVals.parentKey[i] || "record",
      title: sectionVals.title?.[i] || "",
      linkSrcSectionRef: sectionVals.linkSrcSectionRef?.[i] || 0,
      linkSrcColRef: sectionVals.linkSrcColRef?.[i] || 0,
      linkTargetColRef: sectionVals.linkTargetColRef?.[i] || 0,
      sortColRefs: sectionVals.sortColRefs?.[i] || "",
    });
  }
  return sections;
}

/**
 * Extract ordered field info for a section.
 */
export function extractFieldsForSection(
  metaTables: any, sectionId: number
): Array<{ colRef: number; parentPos: number }> {
  const fieldsData = metaTables._grist_Views_section_field;
  if (!fieldsData) { return []; }

  const fieldIds: number[] = fieldsData[2];
  const fieldVals = fieldsData[3];

  const fields: Array<{ colRef: number; parentPos: number }> = [];
  for (let i = 0; i < fieldIds.length; i++) {
    if (fieldVals.parentId[i] !== sectionId) { continue; }
    fields.push({
      colRef: fieldVals.colRef[i],
      parentPos: fieldVals.parentPos?.[i] || i,
    });
  }
  fields.sort((a, b) => a.parentPos - b.parentPos);
  return fields;
}

/**
 * Resolve a column ref to column info.
 */
export function getColumnInfo(metaTables: any, colRef: number): ColumnInfo | null {
  const columnsData = metaTables._grist_Tables_column;
  if (!columnsData) { return null; }

  const colIds: number[] = columnsData[2];
  const colVals = columnsData[3];

  for (let i = 0; i < colIds.length; i++) {
    if (colIds[i] === colRef) {
      let widgetOptions: Record<string, any> | undefined;
      try {
        if (colVals.widgetOptions?.[i]) {
          widgetOptions = JSON.parse(colVals.widgetOptions[i]);
        }
      } catch { /* ignore invalid JSON */ }
      const visibleCol = colVals.visibleCol?.[i] || undefined;
      return {
        colId: colVals.colId[i],
        type: colVals.type[i],
        label: colVals.label?.[i] || colVals.colId[i],
        widgetOptions,
        visibleCol: visibleCol && visibleCol > 0 ? visibleCol : undefined,
      };
    }
  }
  return null;
}

/**
 * Resolve a column ref to its colId string.
 */
export function getColIdByRef(metaTables: any, colRef: number): string {
  const info = getColumnInfo(metaTables, colRef);
  return info ? info.colId : "";
}

/**
 * Extract filter specs from _grist_Filters for a given section.
 * Returns a map of colRef -> filter JSON string.
 */
export function extractFiltersForSection(
  metaTables: any, sectionId: number
): Map<number, string> {
  const filtersData = metaTables._grist_Filters;
  if (!filtersData) { return new Map(); }

  const filterIds: number[] = filtersData[2];
  const filterVals = filtersData[3];
  const result = new Map<number, string>();

  for (let i = 0; i < filterIds.length; i++) {
    if (filterVals.viewSectionRef[i] !== sectionId) { continue; }
    const filter = filterVals.filter?.[i];
    if (filter) {
      result.set(filterVals.colRef[i], filter);
    }
  }
  return result;
}

/**
 * Build a default BoxSpec that replicates the web client's addToSpec algorithm.
 * Sections are paired into horizontal groups of 2, stacked vertically.
 */
function buildDefaultBoxSpec(sectionIds: number[]): BoxSpec {
  if (sectionIds.length === 0) { return { children: [] }; }
  if (sectionIds.length === 1) { return { leaf: sectionIds[0] }; }

  const rows: BoxSpec[] = [];
  for (let i = 0; i < sectionIds.length; i += 2) {
    if (i + 1 < sectionIds.length) {
      // Pair two sections horizontally
      rows.push({ children: [{ leaf: sectionIds[i] }, { leaf: sectionIds[i + 1] }] });
    } else {
      // Odd section at the end gets its own row
      rows.push({ leaf: sectionIds[i] });
    }
  }
  if (rows.length === 1) { return rows[0]; }
  return { children: rows };
}

/**
 * Parse a layoutSpec JSON string into a BoxSpec, with fallback.
 */
export function parseLayoutSpec(spec: string | undefined, sectionIds: number[]): BoxSpec {
  if (spec) {
    try {
      const parsed = JSON.parse(spec);
      if (parsed && (parsed.leaf !== undefined || parsed.children)) {
        return parsed;
      }
    } catch {
      // Fall through to default
    }
  }
  // Fallback: replicate the web client's addToSpec algorithm.
  // Pair sections into horizontal groups of 2, stacked vertically.
  return buildDefaultBoxSpec(sectionIds);
}

/**
 * Recursively compute layout rects from a BoxSpec tree.
 * Even depth = vertical split (children stacked top-to-bottom).
 * Odd depth = horizontal split (children side-by-side).
 * 1-char border between siblings.
 */
export function computeLayout(
  box: BoxSpec,
  rect: Rect,
  sectionIdToPaneIndex: Map<number, number>,
  depth: number = 0,
): LayoutNode {
  // Leaf node
  if (box.leaf !== undefined) {
    return {
      ...rect,
      paneIndex: sectionIdToPaneIndex.get(box.leaf),
    };
  }

  // Filter out missing children
  const children = (box.children || []).filter(c => !isCollapsedOrEmpty(c, sectionIdToPaneIndex));
  if (children.length === 0) {
    return { ...rect };
  }
  if (children.length === 1) {
    return computeLayout(children[0], rect, sectionIdToPaneIndex, depth + 1);
  }

  const isVertical = depth % 2 === 0;
  const direction = isVertical ? "vertical" as const : "horizontal" as const;

  // Compute size proportions
  const totalSize = children.reduce((sum, c) => sum + (c.size || 1), 0);
  const available = isVertical
    ? rect.height - (children.length - 1)  // 1-char border between each
    : rect.width - (children.length - 1);

  const childNodes: LayoutNode[] = [];
  let offset = 0;

  for (let i = 0; i < children.length; i++) {
    const proportion = (children[i].size || 1) / totalSize;
    const isLast = i === children.length - 1;
    // Last child takes remaining space to avoid rounding gaps
    const size = isLast
      ? available - offset
      : Math.max(1, Math.round(available * proportion));

    const childRect: Rect = isVertical
      ? { top: rect.top + offset + i, left: rect.left, width: rect.width, height: size }
      : { top: rect.top, left: rect.left + offset + i, width: size, height: rect.height };

    childNodes.push(computeLayout(children[i], childRect, sectionIdToPaneIndex, depth + 1));
    offset += size;
  }

  return {
    ...rect,
    direction,
    children: childNodes,
  };
}

function isCollapsedOrEmpty(box: BoxSpec, sectionIdToPaneIndex: Map<number, number>): boolean {
  if (box.leaf !== undefined) {
    return !sectionIdToPaneIndex.has(box.leaf);
  }
  if (!box.children || box.children.length === 0) { return true; }
  return box.children.every(c => isCollapsedOrEmpty(c, sectionIdToPaneIndex));
}

/**
 * Collect all leaf nodes from a layout tree.
 */
export function collectLeaves(node: LayoutNode): LayoutNode[] {
  if (node.paneIndex !== undefined) {
    return [node];
  }
  if (!node.children) { return []; }
  const leaves: LayoutNode[] = [];
  for (const child of node.children) {
    leaves.push(...collectLeaves(child));
  }
  return leaves;
}

/**
 * Get the layoutSpec for a given view from metadata.
 */
export function getLayoutSpecForView(metaTables: any, viewId: number): string | undefined {
  const viewsData = metaTables._grist_Views;
  if (!viewsData) { return undefined; }
  const viewIds: number[] = viewsData[2];
  const viewVals = viewsData[3];
  for (let i = 0; i < viewIds.length; i++) {
    if (viewIds[i] === viewId) {
      return viewVals.layoutSpec?.[i] || undefined;
    }
  }
  return undefined;
}
