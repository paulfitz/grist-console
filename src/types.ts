/**
 * Grist type definitions needed by the console client.
 * Inlined from grist-core's app/plugin/GristData.ts and app/common/DocActions.ts
 * to avoid depending on the full grist-core package.
 */

/** Letter codes for CellValue types encoded as [code, args...] tuples. */
export enum GristObjCode {
  List            = "L",
  LookUp          = "l",
  Dict            = "O",
  DateTime        = "D",
  Date            = "d",
  Skip            = "S",
  Censored        = "C",
  Reference       = "R",
  ReferenceList   = "r",
  Exception       = "E",
  Pending         = "P",
  Unmarshallable  = "U",
  Versions        = "V",
}

export type CellValue = number | string | boolean | null | [GristObjCode, ...unknown[]];

export interface ColValues { [colId: string]: CellValue; }
export interface BulkColValues { [colId: string]: CellValue[]; }

export interface ColInfo {
  type: string;
  isFormula: boolean;
  formula: string;
}

export interface ColInfoWithId extends ColInfo {
  id: string;
}

export type AddRecord = ["AddRecord", string, number, ColValues];
export type BulkAddRecord = ["BulkAddRecord", string, number[], BulkColValues];
export type RemoveRecord = ["RemoveRecord", string, number];
export type BulkRemoveRecord = ["BulkRemoveRecord", string, number[]];
export type UpdateRecord = ["UpdateRecord", string, number, ColValues];
export type BulkUpdateRecord = ["BulkUpdateRecord", string, number[], BulkColValues];
export type ReplaceTableData = ["ReplaceTableData", string, number[], BulkColValues];
export type TableDataAction = ["TableData", string, number[], BulkColValues];
export type AddColumn = ["AddColumn", string, string, ColInfo];
export type RemoveColumn = ["RemoveColumn", string, string];
export type RenameColumn = ["RenameColumn", string, string, string];
export type ModifyColumn = ["ModifyColumn", string, string, Partial<ColInfo>];
export type AddTable = ["AddTable", string, ColInfoWithId[]];
export type RemoveTable = ["RemoveTable", string];
export type RenameTable = ["RenameTable", string, string];

export type DocAction = (
  AddRecord |
  BulkAddRecord |
  RemoveRecord |
  BulkRemoveRecord |
  UpdateRecord |
  BulkUpdateRecord |
  ReplaceTableData |
  TableDataAction |
  AddColumn |
  RemoveColumn |
  RenameColumn |
  ModifyColumn |
  AddTable |
  RemoveTable |
  RenameTable
);

export interface ColumnInfo {
  colId: string;
  type: string;
  label: string;
}

/** Whether a column is internal and should be hidden. */
export function isHiddenCol(colId: string): boolean {
  return colId.startsWith("gristHelper_") || colId === "manualSort";
}
