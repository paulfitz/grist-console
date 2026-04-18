import { CellValue, ColumnInfo, GristObjCode, getBaseType } from "./types.js";

/**
 * Simple moment-style date format using native JS Date.
 * Supports common tokens: YYYY, YY, MM, M, DD, D, HH, H, hh, h, mm, m, ss, s, A, a,
 * MMM, MMMM, Do, ddd, dddd.
 */
function formatDateString(date: Date, fmt: string, timezone?: string): string {
  // If we have a timezone offset in the column type (e.g. "America/New_York"),
  // we can't use Intl fully, but we can try to use it for offset calculation.
  let d = date;
  if (timezone && timezone !== "UTC") {
    try {
      // Get the target timezone offset by formatting in that timezone
      const inTz = new Date(date.toLocaleString("en-US", { timeZone: timezone }));
      const diff = inTz.getTime() - date.getTime() + date.getTimezoneOffset() * 60000;
      d = new Date(date.getTime() + diff);
    } catch {
      // Unknown timezone, fall back to UTC
    }
  }

  const year = d.getUTCFullYear();
  const month = d.getUTCMonth(); // 0-based
  const day = d.getUTCDate();
  const hours24 = d.getUTCHours();
  const hours12 = hours24 % 12 || 12;
  const minutes = d.getUTCMinutes();
  const seconds = d.getUTCSeconds();
  const ampm = hours24 < 12 ? "am" : "pm";
  const AMPM = hours24 < 12 ? "AM" : "PM";

  const monthNames = ["January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"];
  const monthShort = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const dayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const dayShort = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const dayOfWeek = d.getUTCDay();

  const pad2 = (n: number) => n < 10 ? "0" + n : String(n);

  // Ordinal suffix for day
  const ordinal = (n: number) => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };

  // Use placeholder-based replacement to avoid conflicts between tokens
  // (e.g. "MMM" → "Jan", then "\bM\b" matching the M in "Jan").
  const tokens: Array<[RegExp, string]> = [
    [/YYYY/g, String(year)],
    [/YY/g, String(year).slice(-2)],
    [/MMMM/g, monthNames[month]],
    [/MMM/g, monthShort[month]],
    [/MM/g, pad2(month + 1)],
    [/(?<![A-Za-z])M(?![A-Za-z])/g, String(month + 1)],
    [/Do/g, ordinal(day)],
    [/DD/g, pad2(day)],
    [/(?<![A-Za-z])D(?![A-Za-z])/g, String(day)],
    [/dddd/g, dayNames[dayOfWeek]],
    [/ddd/g, dayShort[dayOfWeek]],
    [/HH/g, pad2(hours24)],
    [/(?<![A-Za-z])H(?![A-Za-z])/g, String(hours24)],
    [/hh/g, pad2(hours12)],
    [/(?<![A-Za-z])h(?![A-Za-z])/g, String(hours12)],
    [/mm/g, pad2(minutes)],
    [/(?<![A-Za-z])m(?![A-Za-z])/g, String(minutes)],
    [/ss/g, pad2(seconds)],
    [/(?<![A-Za-z])s(?![A-Za-z])/g, String(seconds)],
    [/A/g, AMPM],
    [/(?<![A-Za-z])a(?![A-Za-z])/g, ampm],
  ];

  let result = fmt;
  for (const [re, val] of tokens) {
    result = result.replace(re, val);
  }
  return result;
}

/**
 * Format a numeric value using Intl.NumberFormat based on widget options.
 */
function formatNumber(value: number, opts?: Record<string, any>): string {
  if (!opts) { return String(value); }

  const numMode = opts.numMode;
  const intlOpts: Intl.NumberFormatOptions = {};

  if (numMode === "currency") {
    intlOpts.style = "currency";
    intlOpts.currency = opts.currency || "USD";
  } else if (numMode === "percent") {
    intlOpts.style = "percent";
  } else if (numMode === "scientific") {
    intlOpts.notation = "scientific";
  } else {
    intlOpts.style = "decimal";
  }

  if (opts.decimals !== undefined && opts.decimals !== null) {
    intlOpts.minimumFractionDigits = opts.decimals;
  }
  if (opts.maxDecimals !== undefined && opts.maxDecimals !== null) {
    intlOpts.maximumFractionDigits = opts.maxDecimals;
  } else if (opts.decimals !== undefined && opts.decimals !== null &&
             intlOpts.maximumFractionDigits === undefined) {
    // If only decimals is set, use it as max too (common Grist behavior)
    intlOpts.maximumFractionDigits = Math.max(opts.decimals, 10);
  }

  try {
    const formatted = new Intl.NumberFormat("en-US", intlOpts).format(value);
    if (opts.numSign === "parens" && value < 0) {
      // Replace minus sign with parentheses
      return `(${formatted.replace(/^-/, "")})`;
    }
    return formatted;
  } catch {
    return String(value);
  }
}

/**
 * Format a Date timestamp (seconds since epoch) using widget options or default ISO.
 */
function formatDateValue(ts: number, opts?: Record<string, any>, timezone?: string): string {
  if (ts === 0) { return ""; }
  const d = new Date(ts * 1000);
  const fmt = opts?.dateFormat;
  if (fmt) {
    return formatDateString(d, fmt, timezone);
  }
  return d.toISOString().slice(0, 10);
}

/**
 * Format a DateTime timestamp (seconds since epoch) using widget options or default ISO.
 */
function formatDateTimeValue(ts: number, opts?: Record<string, any>, timezone?: string): string {
  if (ts === 0) { return ""; }
  const d = new Date(ts * 1000);
  const dateFmt = opts?.dateFormat;
  const timeFmt = opts?.timeFormat;
  if (dateFmt || timeFmt) {
    const fullFmt = (dateFmt || "YYYY-MM-DD") + (timeFmt ? " " + timeFmt : "");
    return formatDateString(d, fullFmt, timezone);
  }
  return d.toISOString().replace("T", " ").replace(/\.000Z$/, "");
}

/**
 * Format a CellValue for display in the terminal.
 * When colType is provided, bare numeric values in Date/DateTime columns
 * are formatted as dates instead of raw numbers. Widget options from
 * ColumnInfo control number formatting, date format strings, etc.
 */
export function formatCellValue(value: CellValue, colType?: string, widgetOpts?: Record<string, any>,
                                displayValues?: Map<number, string>): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    if (colType) {
      const baseType = getBaseType(colType);
      if (baseType === "Date") {
        return formatDateValue(value, widgetOpts);
      }
      if (baseType === "DateTime") {
        const tz = colType.split(":").slice(1).join(":") || undefined;
        return formatDateTimeValue(value, widgetOpts, tz);
      }
      if (baseType === "Numeric" || baseType === "Int") {
        return formatNumber(value, widgetOpts);
      }
      if ((baseType === "Ref" || baseType === "RefList") && displayValues) {
        if (value === 0) { return ""; }
        return displayValues.get(value) ?? String(value);
      }
    }
    return String(value);
  }
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    const code = value[0] as string;
    switch (code) {
      case GristObjCode.Date: {
        const ts = value[1] as number;
        if (ts === null || ts === undefined) { return ""; }
        return formatDateValue(ts, widgetOpts);
      }
      case GristObjCode.DateTime: {
        const ts = value[1] as number;
        if (ts === null || ts === undefined) { return ""; }
        const tz = (value[2] as string) || colType?.split(":").slice(1).join(":") || undefined;
        return formatDateTimeValue(ts, widgetOpts, tz);
      }
      case GristObjCode.Reference: {
        const rowId = value[2] as number;
        if (!rowId) { return ""; }
        return displayValues?.get(rowId) ?? String(rowId);
      }
      case GristObjCode.ReferenceList: {
        const rowIds = value[2] as number[];
        if (!Array.isArray(rowIds)) { return ""; }
        return rowIds.map(id => displayValues?.get(id) ?? String(id)).join(", ");
      }
      case GristObjCode.List: {
        const items = value.slice(1);
        // If this is a RefList column, use display values for the row IDs
        if (colType && colType.startsWith("RefList:") && displayValues) {
          return items.map(id => typeof id === "number" ? (displayValues.get(id) ?? String(id)) : String(id)).join(", ");
        }
        return items.map(v => String(v)).join(", ");
      }
      case GristObjCode.Exception: {
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
 * Thrown by parseCellInput when input doesn't match the column type's
 * accepted form. Callers catch this and surface a status message rather
 * than forwarding garbage to the server.
 */
export class ParseError extends Error {
  constructor(public readonly colType: string, public readonly input: string) {
    super(`Invalid ${colType} value: ${JSON.stringify(input)}`);
    this.name = "ParseError";
  }
}

/**
 * Parse a user-entered string back to a CellValue, based on column type.
 * Throws ParseError when the input can't be coerced to the column type.
 */
export function parseCellInput(input: string, colType: string): CellValue {
  const baseType = getBaseType(colType);
  switch (baseType) {
    case "Bool": {
      const lower = input.toLowerCase().trim();
      if (lower === "true" || lower === "1" || lower === "yes") { return true; }
      if (lower === "false" || lower === "0" || lower === "no" || lower === "") { return false; }
      throw new ParseError(colType, input);
    }
    case "Int": {
      if (input.trim() === "") { return 0; }
      const n = parseInt(input, 10);
      if (isNaN(n)) { throw new ParseError(colType, input); }
      return n;
    }
    case "Numeric":
    case "ManualSortPos":
    case "PositionNumber": {
      if (input.trim() === "") { return 0; }
      const n = parseFloat(input);
      if (isNaN(n)) { throw new ParseError(colType, input); }
      return n;
    }
    case "Date": {
      if (input.trim() === "") { return null; }
      const d = new Date(input + "T00:00:00Z");
      if (isNaN(d.getTime())) { throw new ParseError(colType, input); }
      return d.getTime() / 1000;
    }
    case "DateTime": {
      if (input.trim() === "") { return null; }
      const d = new Date(input);
      if (isNaN(d.getTime())) { throw new ParseError(colType, input); }
      return d.getTime() / 1000;
    }
    case "Ref": {
      if (input.trim() === "") { return 0; }
      const n = parseInt(input, 10);
      if (isNaN(n)) { throw new ParseError(colType, input); }
      return n;
    }
    case "Text":
    case "Choice":
    default:
      return input;
  }
}
