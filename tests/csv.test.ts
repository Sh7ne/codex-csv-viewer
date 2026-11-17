import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CSV_PARSE_BUDGET, decodeCsvBytes, makeTable, parseCsv, safeHttpUrl, selectRows } from '../src/csv';

test('preserves Chinese, leading zeros, long integers, formulas and markup as text', () => {
  const parsed = parseCsv('\uFEFF名字,代码,长数字,公式,HTML\r\n冲浪,00023,9223372036854775807123,=1+2,<img src=x onerror=alert(1)>\r\n');
  assert.deepEqual(parsed.rows[1], ['冲浪', '00023', '9223372036854775807123', '=1+2', '<img src=x onerror=alert(1)>']);
  assert.equal(parsed.rows.length, 2);
});

test('parses quoted separators, escaped quotes and multiline fields', () => {
  const result = parseCsv('name,note\n"Smith, Jane","a ""quote""\nsecond line"\n');
  assert.deepEqual(result.rows, [['name', 'note'], ['Smith, Jane', 'a "quote"\nsecond line']]);
  assert.equal(result.issues.length, 0);
});

test('handles CR, LF and CRLF record separators', () => {
  for (const separator of ['\r', '\n', '\r\n']) {
    assert.deepEqual(parseCsv(`a,b${separator}1,2${separator}`).rows, [['a', 'b'], ['1', '2']]);
  }
});

test('retains empty records and trailing empty fields without a synthetic last record', () => {
  assert.deepEqual(parseCsv('a,b\n\n1,\n\n').rows, [['a', 'b'], [''], ['1', ''], ['']]);
  assert.deepEqual(parseCsv('\n').rows, [['']]);
  assert.deepEqual(parseCsv('').rows, []);
  assert.deepEqual(parseCsv('a,b,').rows, [['a', 'b', '']]);
});

test('detects supported delimiters and honors a manual delimiter', () => {
  for (const delimiter of [',', ';', '\t', '|'] as const) {
    const parsed = parseCsv(`name${delimiter}count\nriver${delimiter}12\nindoor${delimiter}3`);
    assert.equal(parsed.delimiter, delimiter);
    assert.deepEqual(parsed.rows[1], ['river', '12']);
  }
  assert.deepEqual(parseCsv('a;b,c\nx;y,z', ';').rows, [['a', 'b,c'], ['x', 'y,z']]);
});

test('keeps extra cells from uneven rows and can show a headerless file', () => {
  const rows = parseCsv('a,b\n1,2,3\n4\n').rows;
  const table = makeTable(rows, true);
  assert.equal(table.columnCount, 3);
  assert.equal(table.unevenRowCount, 2);
  assert.deepEqual(table.headers, ['a', 'b', '列 3']);
  assert.deepEqual(table.rows, [{ sourceRow: 2, cells: ['1', '2', '3'] }, { sourceRow: 3, cells: ['4'] }]);
  const headerless = makeTable(rows, false);
  assert.equal(headerless.rows.length, 3);
  assert.equal(headerless.rows[0].sourceRow, 1);
  assert.deepEqual(headerless.headers, ['列 1', '列 2', '列 3']);
});

test('surfaces unmatched quote errors without dropping parsed data', () => {
  const result = parseCsv('a,b\n1,"unfinished\nnext');
  assert.ok(result.issues.length > 0);
  assert.equal(result.rows[1][0], '1');
  assert.equal(result.rows[1][1], 'unfinished\nnext');
});

test('filtering and stable natural sorting do not mutate source rows or values', () => {
  const table = makeTable([['name', 'n'], ['室内', '10'], ['RIVER', '2'], ['室内', '2'], ['外浪', '2']], true);
  const before = JSON.stringify(table);
  assert.deepEqual(selectRows(table.rows, 'river', null).map(r => r.sourceRow), [3]);
  assert.deepEqual(selectRows(table.rows, '室内', { column: 1, direction: 'asc' }).map(r => r.sourceRow), [4, 2]);
  assert.deepEqual(selectRows(table.rows, '', { column: 1, direction: 'asc' }).map(r => r.sourceRow), [3, 4, 5, 2]);
  assert.equal(JSON.stringify(table), before);
});

test('UTF-8 and UTF-16 BOMs decode correctly; incorrect UTF-8 is reported', () => {
  const utf8 = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode('动作,场景\n360,室内')]);
  assert.equal(decodeCsvBytes(utf8).text, '动作,场景\n360,室内');
  const str = '动作,室内';
  const utf16 = new Uint8Array(2 + str.length * 2);
  utf16.set([0xff, 0xfe]);
  for (let i = 0; i < str.length; i++) { utf16[2 + 2 * i] = str.charCodeAt(i) & 255; utf16[3 + 2 * i] = str.charCodeAt(i) >> 8; }
  assert.equal(decodeCsvBytes(utf16).text, str);
  assert.equal(decodeCsvBytes(utf16).encoding, 'utf-16le');
  assert.equal(decodeCsvBytes(new Uint8Array([0xff])).hadDecodingErrors, true);
  assert.equal(decodeCsvBytes(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]), 'gb18030').text, '中文');
});

test('only complete HTTP(S) values become links', () => {
  assert.equal(safeHttpUrl('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
  assert.equal(safeHttpUrl('http://localhost:8080/a'), 'http://localhost:8080/a');
  for (const bad of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', '<a href=x>', ' see https://x.com', 'https://x.com ']) {
    assert.equal(safeHttpUrl(bad), null);
  }
});

test('record budget aborts with an explicit warning and retains a real last empty record', () => {
  const result = parseCsv('name\n\nthird\nfourth\n', ',', { maxRows: 2 });
  assert.deepEqual(result.rows, [['name'], ['']]);
  assert.match(result.issues[0].message, /仅显示前 2 条完整 CSV 记录/);
  assert.match(result.issues[0].message, /后续内容未加载/);
});

test('cell budget keeps only complete records and stops before exceeding its limit', () => {
  const result = parseCsv('a,b\n1,2,3\n4,5\n', ',', { maxCells: 4 });
  assert.deepEqual(result.rows, [['a', 'b']]);
  assert.match(result.issues[0].message, /仅显示前 1 条完整 CSV 记录/);
  const wideFirstRecord = parseCsv('a,b,c\n1,2,3', ',', { maxCells: 2 });
  assert.deepEqual(wideFirstRecord.rows, []);
  assert.match(wideFirstRecord.issues[0].message, /查看预算/);
});

test('an exact budget at EOF does not claim truncation or count a synthetic trailing row', () => {
  for (const newline of ['\r', '\n', '\r\n']) {
    const result = parseCsv(`a,b${newline}1,2${newline}`, ',', { maxRows: 2, maxCells: 4 });
    assert.deepEqual(result.rows, [['a', 'b'], ['1', '2']]);
    assert.deepEqual(result.issues, []);
    const blankFinal = parseCsv(`a${newline}${newline}`, ',', { maxRows: 2, maxCells: 2 });
    assert.deepEqual(blankFinal.rows, [['a'], ['']]);
    assert.deepEqual(blankFinal.issues, []);
  }
});

test('default budgets cap many short records without silently reporting a complete file', () => {
  assert.deepEqual(DEFAULT_CSV_PARSE_BUDGET, { maxRows: 100_000, maxCells: 1_000_000 });
  const result = parseCsv('x\n'.repeat(DEFAULT_CSV_PARSE_BUDGET.maxRows + 5), ',');
  assert.equal(result.rows.length, DEFAULT_CSV_PARSE_BUDGET.maxRows);
  assert.match(result.issues[0].message, /后续内容未加载/);
});

test('chunk boundaries preserve a quoted multiline record and final blank records', () => {
  const value = 'x'.repeat(70_000) + '\nsecond line';
  const result = parseCsv(`name,note\nitem,"${value}"\n\n`, ',', { maxRows: 3, maxCells: 5 });
  assert.deepEqual(result.rows, [['name', 'note'], ['item', value], ['']]);
  assert.deepEqual(result.issues, []);
});
