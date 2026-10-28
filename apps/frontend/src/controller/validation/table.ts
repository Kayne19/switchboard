import type {
  TableCell,
  TableCellObject,
  TableColumn,
  TableData,
} from '../types';
import { SEMANTICS, checkString, checkUnknownKeys, copyFrameText, copyOptionalBoolean, copyOptionalName, isRecord } from './shared';

// The table contract (docs/display-tool.md, "Table v1 rules"): 1 to 12
// columns, 0 to 200 rows of exactly one cell per column, a cell a string, a
// finite number or `{ text, semantic?, bold? }`, and `highlight` naming row
// indices. Alignment is the page's to infer, so there is no `align`.
const MAX_TABLE_COLUMNS = 12;
const MAX_TABLE_ROWS = 200;
const MAX_TABLE_COLUMN_LABEL_UTF16 = 64;
const MAX_TABLE_CELL_UTF16 = 256;

export function validateTableData(data: Record<string, unknown>): { ok: true; data: TableData } | { ok: false; error: string } {
  const allowed = new Set(['title', 'subtitle', 'context', 'caption', 'columns', 'rows', 'highlight']);
  const unknownKey = checkUnknownKeys(data, allowed, 'table data');
  if (unknownKey) return { ok: false, error: unknownKey };

  if (!Array.isArray(data.columns) || data.columns.length < 1 || data.columns.length > MAX_TABLE_COLUMNS) {
    return { ok: false, error: `table.columns must be an array of 1 to ${MAX_TABLE_COLUMNS} items` };
  }
  const columnAllowed = new Set(['label', 'semantic']);
  const columns: TableColumn[] = [];
  for (const c of data.columns) {
    if (!isRecord(c)) return { ok: false, error: 'table column must be an object' };
    const cUnknown = checkUnknownKeys(c, columnAllowed, 'table column');
    if (cUnknown) return { ok: false, error: cUnknown };
    const labelErr = checkString(c.label, MAX_TABLE_COLUMN_LABEL_UTF16, 'table column.label');
    if (labelErr) return { ok: false, error: labelErr };
    const column: TableColumn = { label: c.label as string };
    const semanticErr = copyOptionalName(c, column, 'semantic', SEMANTICS, 'table column.semantic');
    if (semanticErr) return { ok: false, error: semanticErr };
    columns.push(column);
  }

  if (!Array.isArray(data.rows) || data.rows.length > MAX_TABLE_ROWS) {
    return { ok: false, error: `table.rows must be an array of at most ${MAX_TABLE_ROWS} items` };
  }
  const cellAllowed = new Set(['text', 'semantic', 'bold']);
  const rows: TableCell[][] = [];
  for (const [rowIndex, r] of data.rows.entries()) {
    if (!Array.isArray(r)) return { ok: false, error: `table.rows[${rowIndex}] must be an array` };
    if (r.length !== columns.length) {
      return { ok: false, error: `table.rows[${rowIndex}] has ${r.length} cells; the table has ${columns.length} columns` };
    }
    const row: TableCell[] = [];
    for (const [cellIndex, cell] of r.entries()) {
      // Every refusal names its cell: a 200 by 12 table is 2,400 of them.
      const at = `table.rows[${rowIndex}][${cellIndex}]`;
      if (typeof cell === 'number') {
        if (!Number.isFinite(cell)) return { ok: false, error: `${at} must be a finite number` };
        row.push(cell);
        continue;
      }
      if (typeof cell === 'string') {
        const err = checkString(cell, MAX_TABLE_CELL_UTF16, at);
        if (err) return { ok: false, error: err };
        row.push(cell);
        continue;
      }
      if (!isRecord(cell)) return { ok: false, error: `${at} must be a string, a number or an object` };
      const cellUnknown = checkUnknownKeys(cell, cellAllowed, at);
      if (cellUnknown) return { ok: false, error: cellUnknown };
      const textErr = checkString(cell.text, MAX_TABLE_CELL_UTF16, `${at}.text`);
      if (textErr) return { ok: false, error: textErr };
      const cellObj: TableCellObject = { text: cell.text as string };
      const cellErr =
        copyOptionalName(cell, cellObj, 'semantic', SEMANTICS, `${at}.semantic`) ??
        copyOptionalBoolean(cell, cellObj, 'bold', `${at}.bold`);
      if (cellErr) return { ok: false, error: cellErr };
      row.push(cellObj);
    }
    rows.push(row);
  }

  const result: TableData = { columns, rows };
  if (data.highlight !== undefined) {
    if (!Array.isArray(data.highlight)) return { ok: false, error: 'table.highlight must be an array' };
    for (const h of data.highlight) {
      if (typeof h !== 'number' || !Number.isInteger(h) || h < 0 || h >= rows.length) {
        return { ok: false, error: 'table.highlight must contain row indices' };
      }
    }
    result.highlight = data.highlight as number[];
  }
  const err = copyFrameText(data, result, 'table');
  if (err) return { ok: false, error: err };
  return { ok: true, data: result };
}
