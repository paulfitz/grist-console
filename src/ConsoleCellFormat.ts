import { CellValue, GristObjCode } from "./types";

/**
 * Format a CellValue for display in the terminal.
 */
export function formatCellValue(value: CellValue): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const code = value[0] as string;
    switch (code) {
      case GristObjCode.Date: {
        // ["d", timestamp] - timestamp is seconds since epoch, midnight UTC
        const ts = value[1] as number;
        if (ts === null || ts === undefined) { return ""; }
        const d = new Date(ts * 1000);
        return d.toISOString().slice(0, 10);
      }
      case GristObjCode.DateTime: {
        // ["D", timestamp, timezone]
        const ts = value[1] as number;
        if (ts === null || ts === undefined) { return ""; }
        const d = new Date(ts * 1000);
        return d.toISOString().replace("T", " ").replace(/\.000Z$/, "");
      }
      case GristObjCode.Reference: {
        // ["R", tableId, rowId]
        const rowId = value[2] as number;
        return rowId ? String(rowId) : "";
      }
      case GristObjCode.ReferenceList: {
        // ["r", tableId, [rowIds]]
        const rowIds = value[2] as number[];
        return Array.isArray(rowIds) ? rowIds.join(", ") : "";
      }
      case GristObjCode.List: {
        // ["L", item1, item2, ...]
        return value.slice(1).map(v => String(v)).join(", ");
      }
      case GristObjCode.Exception: {
        // ["E", name, ...]
        return `#ERROR: ${value[1] || ""}`;
      }
      case GristObjCode.Pending: {
        return "#PENDING";
      }
      case GristObjCode.Censored: {
        return "#CENSORED";
      }
      case GristObjCode.Unmarshallable: {
        return String(value[1] || "");
      }
      default:
        return JSON.stringify(value);
    }
  }
  return String(value);
}

/**
 * Parse a user-entered string back to a CellValue, based on column type.
 */
export function parseCellInput(input: string, colType: string): CellValue {
  const baseType = colType.split(":")[0];
  switch (baseType) {
    case "Bool": {
      const lower = input.toLowerCase().trim();
      if (lower === "true" || lower === "1" || lower === "yes") { return true; }
      if (lower === "false" || lower === "0" || lower === "no" || lower === "") { return false; }
      return input;
    }
    case "Int": {
      if (input.trim() === "") { return 0; }
      const n = parseInt(input, 10);
      return isNaN(n) ? input : n;
    }
    case "Numeric":
    case "ManualSortPos":
    case "PositionNumber": {
      if (input.trim() === "") { return 0; }
      const n = parseFloat(input);
      return isNaN(n) ? input : n;
    }
    case "Date": {
      if (input.trim() === "") { return null; }
      const d = new Date(input + "T00:00:00Z");
      if (isNaN(d.getTime())) { return input; }
      return d.getTime() / 1000;
    }
    case "DateTime": {
      if (input.trim() === "") { return null; }
      const d = new Date(input);
      if (isNaN(d.getTime())) { return input; }
      return d.getTime() / 1000;
    }
    case "Ref": {
      if (input.trim() === "") { return 0; }
      const n = parseInt(input, 10);
      return isNaN(n) ? input : n;
    }
    case "Text":
    case "Choice":
    default:
      return input;
  }
}
