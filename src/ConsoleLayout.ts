import { ColumnInfo } from "./types.js";

/**
 * Read a Grist meta table out of the openDoc metaTables blob. Each meta
 * table is wire-encoded as ["TableData", tableId, [rowIds], {colId: [vals]}],
 * so the rowIds live at index 2 and the column values at index 3.
 *
 * Returns null when the table isn't present (defensive against partial docs).
 */
export function readMetaTable(metaTables: any, name: string): { ids: number[]; vals: any } | null {
  const data = metaTables?.[name];
  if (!data) { return null; }
  return { ids: data[2], vals: data[3] };
}

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
  const pagesT = readMetaTable(metaTables, "_grist_Pages");
  const viewsT = readMetaTable(metaTables, "_grist_Views");
  if (!pagesT || !viewsT) { return []; }

  // Build a map from viewId to view name
  const viewNameMap = new Map<number, string>();
  for (let i = 0; i < viewsT.ids.length; i++) {
    viewNameMap.set(viewsT.ids[i], viewsT.vals.name[i] || "");
  }

  const pages: Array<PageInfo & { pagePos: number }> = [];
  for (let i = 0; i < pagesT.ids.length; i++) {
    const viewRef = pagesT.vals.viewRef[i];
    pages.push({
      pageId: pagesT.ids[i],
      viewId: viewRef,
      name: viewNameMap.get(viewRef) || `View ${viewRef}`,
      indentation: pagesT.vals.indentation?.[i] || 0,
      pagePos: pagesT.vals.pagePos?.[i] || i,
    });
  }

  pages.sort((a, b) => a.pagePos - b.pagePos);
  return pages.map(({ pagePos, ...rest }) => rest);
}

/**
 * Extract sections for a given view.
 */
export function extractSectionsForView(metaTables: any, viewId: number): SectionInfo[] {
  const sectionsT = readMetaTable(metaTables, "_grist_Views_section");
  const tablesT = readMetaTable(metaTables, "_grist_Tables");
  if (!sectionsT || !tablesT) { return []; }

  // Build tableRef -> tableId map
  const tableIdMap = new Map<number, string>();
  for (let i = 0; i < tablesT.ids.length; i++) {
    tableIdMap.set(tablesT.ids[i], tablesT.vals.tableId[i]);
  }

  const sections: SectionInfo[] = [];
  for (let i = 0; i < sectionsT.ids.length; i++) {
    if (sectionsT.vals.parentId[i] !== viewId) { continue; }
    const tableRef = sectionsT.vals.tableRef[i];
    sections.push({
      sectionId: sectionsT.ids[i],
      tableRef,
      tableId: tableIdMap.get(tableRef) || "",
      parentKey: sectionsT.vals.parentKey[i] || "record",
      title: sectionsT.vals.title?.[i] || "",
      linkSrcSectionRef: sectionsT.vals.linkSrcSectionRef?.[i] || 0,
      linkSrcColRef: sectionsT.vals.linkSrcColRef?.[i] || 0,
      linkTargetColRef: sectionsT.vals.linkTargetColRef?.[i] || 0,
      sortColRefs: sectionsT.vals.sortColRefs?.[i] || "",
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
  const fieldsT = readMetaTable(metaTables, "_grist_Views_section_field");
  if (!fieldsT) { return []; }

  const fields: Array<{ colRef: number; parentPos: number }> = [];
  for (let i = 0; i < fieldsT.ids.length; i++) {
    if (fieldsT.vals.parentId[i] !== sectionId) { continue; }
    fields.push({
      colRef: fieldsT.vals.colRef[i],
      parentPos: fieldsT.vals.parentPos?.[i] || i,
    });
  }
  fields.sort((a, b) => a.parentPos - b.parentPos);
  return fields;
}

/**
 * Resolve a column ref to column info.
 */
export function getColumnInfo(metaTables: any, colRef: number): ColumnInfo | null {
  const colsT = readMetaTable(metaTables, "_grist_Tables_column");
  if (!colsT) { return null; }

  for (let i = 0; i < colsT.ids.length; i++) {
    if (colsT.ids[i] !== colRef) { continue; }
    let widgetOptions: Record<string, any> | undefined;
    try {
      if (colsT.vals.widgetOptions?.[i]) {
        widgetOptions = JSON.parse(colsT.vals.widgetOptions[i]);
      }
    } catch { /* ignore invalid JSON */ }
    const visibleCol = colsT.vals.visibleCol?.[i] || undefined;
    return {
      colId: colsT.vals.colId[i],
      type: colsT.vals.type[i],
      label: colsT.vals.label?.[i] || colsT.vals.colId[i],
      widgetOptions,
      visibleCol: visibleCol && visibleCol > 0 ? visibleCol : undefined,
    };
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
  const filtersT = readMetaTable(metaTables, "_grist_Filters");
  if (!filtersT) { return new Map(); }

  const result = new Map<number, string>();
  for (let i = 0; i < filtersT.ids.length; i++) {
    if (filtersT.vals.viewSectionRef[i] !== sectionId) { continue; }
    const filter = filtersT.vals.filter?.[i];
    if (filter) {
      result.set(filtersT.vals.colRef[i], filter);
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
 * Extract section IDs from the collapsed array of a BoxSpec.
 */
export function extractCollapsedSectionIds(box: BoxSpec): number[] {
  if (!box.collapsed) { return []; }
  const ids: number[] = [];
  for (const child of box.collapsed) {
    if (child.leaf !== undefined) {
      ids.push(child.leaf);
    }
  }
  return ids;
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
  const viewsT = readMetaTable(metaTables, "_grist_Views");
  if (!viewsT) { return undefined; }
  for (let i = 0; i < viewsT.ids.length; i++) {
    if (viewsT.ids[i] === viewId) {
      return viewsT.vals.layoutSpec?.[i] || undefined;
    }
  }
  return undefined;
}
