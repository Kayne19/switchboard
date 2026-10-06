import type { TableCell, TableData } from '../controller/types';
import type { Noun } from './countText';
import { ListViewport } from './ListViewport';
import { MetaTitle } from './MetaTitle';
import type { Slot } from './slot';
import { TechFrame } from './TechFrame';

export type ColumnAlignment = 'start' | 'end';

// A cell's text once a number is drawn: the page shows what the agent sent.
export function cellText(cell: TableCell): string {
  if (typeof cell === 'number') return String(cell);
  if (typeof cell === 'string') return cell;
  return cell.text;
}

// Text that reads as a quantity: a sign, a currency symbol, digits with
// separators, a fraction or exponent, then a short unit such as `s`, `ms`,
// `%`, `GB`, `req/s`; a compound duration such as `1m 48s`; or a clock time
// such as `01:42:18`.
const QUANTITY = /^(?:[-+\u2212]?(?:[$\u20ac\u00a3\u00a5\u20b9]\s?)?(?:\d[\d,_ ]*(?:\.\d+)?|\.\d+)(?:e[-+]?\d+)?\s*(?:[%\u2030\u00b0]|[a-z\u00b5]{1,4}(?:\/[a-z]{1,4})?)?(?:\s+\d+(?:\.\d+)?\s*[a-z\u00b5]{1,4})*|\d{1,2}(?::\d{2}){1,2})$/i;
// A cell with nothing to align: empty, a dash, or a placeholder.
const BLANK = /^(?:|[-\u2013\u2014]|n\/a|\u2026)$/i;

function readsAsQuantity(cell: TableCell): boolean | null {
  if (typeof cell === 'number') return true;
  const text = cellText(cell).trim();
  if (BLANK.test(text)) return null;
  return QUANTITY.test(text);
}

/**
 * The alignment of each column, inferred from its cells: a column whose
 * cells are all quantities is set to the end so their digits line up; any
 * other column, and an empty one, is set to the start. The agent sends no
 * `align`; this is the page's decision (docs/display-tool.md, "Table v1 rules").
 */
export function inferColumnAlignment(data: TableData): ColumnAlignment[] {
  return data.columns.map((_, columnIndex) => {
    let quantities = 0;
    for (const row of data.rows) {
      const reading = readsAsQuantity(row[columnIndex]);
      if (reading === false) return 'start';
      if (reading === true) quantities += 1;
    }
    return quantities > 0 ? 'end' : 'start';
  });
}

function CellText({ cell }: { cell: TableCell }) {
  const semantic = typeof cell === 'object' ? cell.semantic : undefined;
  const bold = typeof cell === 'object' && cell.bold === true;
  const className = [
    'table-grid__text',
    bold ? 'table-grid__text--bold' : '',
    semantic ? `semantic-${semantic}` : '',
  ].filter(Boolean).join(' ');
  return <span className={className}>{cellText(cell)}</span>;
}

// What the rims count a table's rows as.
const ROW: Noun = ['ROW', 'ROWS'];

// Rows of named columns inside the interrupted-rails frame, scrolling only
// when they overflow it and clipped to its inside (the same mask the code
// viewport uses). Thin rules separate rows; a highlighted row carries the
// orange accent the code viewport gives a hot line. The meta line stands
// in the mask's top row, beside the frame's top-right step, above the
// scroll, so the sticky header is the scroll's top edge and a row
// scrolling up passes under it rather than showing above it. A table that
// scrolls does so in the list viewport, which counts its rows past each edge
// below the header and pages it by the keys every scroller takes. In the
// main slot the scene frame above shows the title (MetaTitle).
export function TablePrimitive({ data, slot = 'primary' }: { data: TableData; slot?: Slot }) {
  const alignment = inferColumnAlignment(data);
  const highlighted = new Set(data.highlight ?? []);
  const meta = (
    <div className="table-viewport__meta tech micro">
      <MetaTitle title={data.title ?? 'TABLE'} slot={slot} />
      <span>{data.rows.length} ROWS / {data.columns.length} COLS</span>
    </div>
  );
  return (
    <div className={`table-viewport${slot === 'focus' ? ' table-viewport--focused' : ''}`} data-testid="table">
      <TechFrame variant="code" />
      <div className="table-viewport__mask">
        {meta}
        <ListViewport noun={ROW} countSelector="tr[data-row]" pinned="thead" scrollClassName="table-viewport__scroll" label={data.title ?? 'Table'}>
          <table className="table-grid">
            <thead>
              <tr>
                {data.columns.map((column, columnIndex) => (
                  <th
                    key={columnIndex}
                    scope="col"
                    className={`tech table-grid__head table-grid__cell--${alignment[columnIndex]}`}
                  >
                    <span className={`table-grid__text${column.semantic ? ` semantic-${column.semantic}` : ''}`}>{column.label}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row, rowIndex) => (
                <tr
                  key={rowIndex}
                  className={`table-grid__row${highlighted.has(rowIndex) ? ' table-grid__row--hot' : ''}`}
                  data-row={rowIndex}
                >
                  {row.map((cell, columnIndex) => (
                    <td key={columnIndex} className={`table-grid__cell table-grid__cell--${alignment[columnIndex]}`}>
                      <CellText cell={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data.rows.length === 0 ? <div className="table-grid__empty tech micro">NO ROWS</div> : null}
        </ListViewport>
      </div>
    </div>
  );
}
