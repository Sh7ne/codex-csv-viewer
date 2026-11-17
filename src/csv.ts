import Papa from 'papaparse';

export type CsvEncoding = 'auto' | 'utf-8' | 'gb18030' | 'utf-16le' | 'utf-16be';
export type CsvDelimiter = 'auto' | ',' | ';' | '\t' | '|';

export interface CsvIssue {
  message: string;
  row?: number;
}

export interface ParsedCsv {
  rows: string[][];
  delimiter: string;
  issues: CsvIssue[];
}

export interface CsvParseBudget {
  maxRows?: number;
  maxCells?: number;
}

export const DEFAULT_CSV_PARSE_BUDGET = Object.freeze({ maxRows: 100_000, maxCells: 1_000_000 });

export interface CsvRow {
  /** CSV record number; a quoted multiline value remains one record. */
  sourceRow: number;
  cells: string[];
}

export interface CsvTable {
  headers: string[];
  rows: CsvRow[];
  columnCount: number;
  unevenRowCount: number;
}

export interface CsvSort {
  column: number;
  direction: 'asc' | 'desc';
}

export function decodeCsvBytes(bytes: Uint8Array, requested: CsvEncoding = 'auto') {
  let encoding: Exclude<CsvEncoding, 'auto'> = requested === 'auto' ? 'utf-8' : requested;
  if (requested === 'auto') {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) encoding = 'utf-16le';
    else if (bytes[0] === 0xfe && bytes[1] === 0xff) encoding = 'utf-16be';
  }
  let hadDecodingErrors = false;
  let text: string;
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch {
    hadDecodingErrors = true;
    text = new TextDecoder(encoding).decode(bytes);
  }
  return { text, encoding, hadDecodingErrors };
}

export function parseCsv(text: string, delimiter: CsvDelimiter = 'auto', budget: CsvParseBudget = {}): ParsedCsv {
  // TextDecoder and Papa both tolerate a UTF-8 BOM; stripping here also covers
  // direct text callers without changing any source bytes.
  const content = text.replace(/^\uFEFF/, '');
  if (content.length === 0) return { rows: [], delimiter: delimiter === 'auto' ? ',' : delimiter, issues: [] };
  const maxRows = budget.maxRows ?? DEFAULT_CSV_PARSE_BUDGET.maxRows;
  const maxCells = budget.maxCells ?? DEFAULT_CSV_PARSE_BUDGET.maxCells;
  if (![maxRows, maxCells].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw new RangeError('CSV 记录数与单元格预算必须为正整数。');
  }
  const rows: string[][] = [];
  const issues: CsvIssue[] = [];
  let resolvedDelimiter: string = delimiter === 'auto' ? ',' : delimiter;
  let cellCount = 0;
  let previousCursor = -1;
  let wasTruncated = false;
  let omittedIssueCount = 0;
  const endsWithRecordSeparator = /(?:\r\n|\n|\r)$/.test(content);
  Papa.parse<string[]>(content, {
    delimiter: delimiter === 'auto' ? '' : delimiter,
    delimitersToGuess: [',', '\t', ';', '|'],
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    // Even with `step`, Papa's fast path otherwise splits the whole input into
    // a temporary row array before invoking callbacks. Bounded chunks also
    // keep delimiter detection from previewing a full large input at once.
    chunkSize: 64 * 1024,
    fastMode: false,
    step(result, parser) {
      resolvedDelimiter = result.meta.delimiter || resolvedDelimiter;
      const row = result.data;
      // The synthetic empty record after a final separator repeats the previous
      // cursor. A real final blank record advances it and must be retained.
      const syntheticFinalRecord = endsWithRecordSeparator
        && result.meta.cursor === content.length
        && previousCursor === content.length
        && row.length === 1 && row[0] === '';
      previousCursor = result.meta.cursor;
      if (syntheticFinalRecord) return;
      if (rows.length >= maxRows || cellCount + row.length > maxCells) {
        wasTruncated = true;
        parser.abort();
        return;
      }
      for (const error of result.errors) {
        if (error.code === 'UndetectableDelimiter') continue;
        if (issues.length >= 50) { omittedIssueCount++; continue; }
        issues.push({
          message: error.code === 'MissingQuotes'
            ? '引号未闭合；下面保留解析得到的内容，请检查原文件。'
            : error.code === 'InvalidQuotes'
              ? '发现异常引号；下面保留解析得到的内容，请检查原文件。'
              : error.message,
          row: rows.length + 1,
        });
      }
      rows.push(row);
      cellCount += row.length;
      if ((rows.length === maxRows || cellCount === maxCells) && result.meta.cursor < content.length) {
        wasTruncated = true;
        parser.abort();
      }
    },
  });
  if (omittedIssueCount) issues.push({ message: `另有 ${omittedIssueCount} 项解析提示未逐项列出。` });
  if (wasTruncated) issues.unshift({ message: `已达到查看预算，仅显示前 ${rows.length.toLocaleString()} 条完整 CSV 记录（含表头，如有），后续内容未加载。上限为 ${maxRows.toLocaleString()} 条记录或 ${maxCells.toLocaleString()} 个单元格；原文件保持不变。` });
  return { rows, delimiter: resolvedDelimiter, issues };
}

export function makeTable(rows: readonly string[][], hasHeader: boolean): CsvTable {
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const first = hasHeader ? rows[0] : undefined;
  const headers = Array.from({ length: columnCount }, (_, i) => first?.[i] || `列 ${i + 1}`);
  const start = hasHeader && rows.length ? 1 : 0;
  const data = rows.slice(start).map((cells, i) => ({ cells, sourceRow: start + i + 1 }));
  const expected = rows[0]?.length ?? 0;
  return { headers, rows: data, columnCount, unevenRowCount: rows.filter(row => row.length !== expected).length };
}

const collator = new Intl.Collator('zh-Hans', { numeric: true, sensitivity: 'base' });

export function selectRows(rows: readonly CsvRow[], query: string, sort: CsvSort | null): CsvRow[] {
  const needle = query.toLocaleLowerCase();
  const selected = needle
    ? rows.filter(row => row.cells.some(cell => cell.toLocaleLowerCase().includes(needle)))
    : [...rows];
  if (sort) {
    const direction = sort.direction === 'asc' ? 1 : -1;
    selected.sort((a, b) => direction * collator.compare(a.cells[sort.column] ?? '', b.cells[sort.column] ?? '') || a.sourceRow - b.sourceRow);
  }
  return selected;
}

export function safeHttpUrl(value: string): string | null {
  if (value !== value.trim() || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : null;
  } catch {
    return null;
  }
}
