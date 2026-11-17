import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { JSDOM } from 'jsdom';
import { createViewer, type ViewerOptions } from '../src/viewer.ts';
import { makeTable, parseCsv, selectRows } from '../src/csv.ts';

function fixture(options: ViewerOptions = {}) {
  const dom = new JSDOM('<main id="app"></main>');
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const key of ['document', 'HTMLAnchorElement'] as const) {
    previous.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
  }
  const root = dom.window.document.getElementById('app')!;
  return {
    dom, root, viewer: createViewer(root, options),
    close() {
      dom.window.close();
      for (const [key, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
}

function visibleRows(root: HTMLElement) {
  return [...root.querySelectorAll('tbody tr')].map(row => [...row.querySelectorAll('td')].map(cell => cell.textContent));
}

function findButton(root: HTMLElement, label: string) {
  const button = [...root.querySelectorAll('button')].find(node => node.textContent === label);
  assert.ok(button, `Button ${label} exists`);
  return button;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('public fictional CSV renders all 36 records and columns; search and sorting preserve source bytes', async () => {
  const source = new URL('../examples/sample.csv', import.meta.url);
  const bytes = await readFile(source);
  const original = Buffer.from(bytes);
  const originalHash = createHash('sha256').update(bytes).digest('hex');
  const expected = makeTable(parseCsv(bytes.toString('utf8')).rows, true);
  assert.equal(expected.rows.length, 36);
  assert.equal(expected.columnCount, 9);
  const f = fixture();
  try {
    f.viewer.load(bytes, 'sample.csv');
    assert.equal(f.root.querySelectorAll('tbody tr').length, 36);
    assert.equal(f.root.querySelectorAll('thead th').length, expected.columnCount + 1, 'Extra column is the row number');
    assert.deepEqual(visibleRows(f.root), expected.rows.map(row => row.cells));
    assert.equal(f.root.querySelector('.csv-stats')?.textContent, `36 条记录 · ${expected.columnCount} 列`);

    const search = f.root.querySelector<HTMLInputElement>('input[type=search]')!;
    search.value = '平衡';
    search.dispatchEvent(new f.dom.window.Event('input'));
    await delay(150);
    assert.equal(visibleRows(f.root).length, 12);
    assert.deepEqual(visibleRows(f.root), selectRows(expected.rows, '平衡', null).map(row => row.cells));
    search.value = '';
    search.dispatchEvent(new f.dom.window.Event('input'));
    await delay(150);

    f.root.querySelectorAll<HTMLButtonElement>('.csv-sort-button')[2].click();
    assert.deepEqual(visibleRows(f.root), selectRows(expected.rows, '', { column: 2, direction: 'asc' }).map(row => row.cells));
    findButton(f.root, '原始顺序').click();
    assert.deepEqual(visibleRows(f.root), expected.rows.map(row => row.cells));
    assert.deepEqual(bytes, original, 'The UI must not modify the input byte buffer');
    assert.equal(createHash('sha256').update(await readFile(source)).digest('hex'), originalHash, 'Original CSV remains byte-identical');
  } finally { f.close(); }
});

test('pagination and header toggles expose complete records without mutating CSV input', () => {
  const bytes = new TextEncoder().encode(`编号,名称\n${Array.from({ length: 205 }, (_, i) => `${String(i + 1).padStart(4, '0')},动作 ${i + 1}`).join('\n')}`);
  const original = bytes.slice();
  const f = fixture();
  try {
    f.viewer.load(bytes, 'large.csv');
    assert.equal(visibleRows(f.root).length, 100);
    assert.equal(f.root.querySelector('.csv-page-label')?.textContent, '1 / 3');
    assert.equal(visibleRows(f.root)[0][0], '0001');
    findButton(f.root, '下一页').click();
    assert.equal(visibleRows(f.root)[0][0], '0101');
    findButton(f.root, '下一页').click();
    assert.equal(visibleRows(f.root).length, 5);
    assert.equal(visibleRows(f.root)[4][0], '0205');
    assert.equal(findButton(f.root, '下一页').disabled, true);
    findButton(f.root, '上一页').click();
    assert.equal(visibleRows(f.root)[0][0], '0101');
    const header = f.root.querySelector<HTMLInputElement>('.csv-checkbox input')!;
    header.checked = false;
    header.dispatchEvent(new f.dom.window.Event('change'));
    assert.deepEqual(visibleRows(f.root)[0], ['编号', '名称']);
    assert.equal(f.root.querySelector('.csv-stats')?.textContent, '206 条记录 · 2 列');
    assert.deepEqual(bytes, original);
  } finally { f.close(); }
});

test('markup and formulas remain literal, only HTTP links open, and multiline detail is preserved', () => {
  const calls: string[] = [];
  const malicious = '<img src=x onerror="globalThis.csvExecuted=true"><script>globalThis.csvExecuted=true</script>';
  const multiline = '第一行\n第二行';
  const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
  const csv = ['内容,链接,公式', [malicious, 'https://example.invalid/video?id=test', '=1+1'].map(quote).join(','), [multiline, 'javascript:alert(1)', '00001234567890123456789'].map(quote).join(',')].join('\n');
  const f = fixture({ onOpenLink: url => calls.push(url) });
  try {
    f.viewer.load(new TextEncoder().encode(csv), 'untrusted.csv');
    assert.equal(f.root.querySelector('script,img'), null);
    assert.equal(Reflect.get(f.dom.window, 'csvExecuted'), undefined);
    assert.equal(visibleRows(f.root)[0][0], malicious);
    assert.equal(visibleRows(f.root)[0][2], '=1+1');
    assert.equal(visibleRows(f.root)[1][2], '00001234567890123456789');
    const links = f.root.querySelectorAll<HTMLAnchorElement>('a');
    assert.equal(links.length, 1);
    assert.equal(links[0].rel, 'noopener noreferrer');
    links[0].click();
    assert.deepEqual(calls, ['https://example.invalid/video?id=test']);
    const cell = f.root.querySelectorAll<HTMLTableRowElement>('tbody tr')[1].querySelector('td')!;
    cell.click();
    assert.equal(f.root.querySelector('.csv-cell-content')?.textContent, multiline);
    assert.equal(f.root.querySelector<HTMLDetailsElement>('details')?.open, true);
  } finally { f.close(); }
});

test('a failed replacement read clears old cells even when both files have the same basename', () => {
  const f = fixture();
  try {
    f.viewer.load(new TextEncoder().encode('name,value\nold-file-secret,1'), 'data.csv');
    f.root.querySelector<HTMLTableCellElement>('tbody td')!.click();
    assert.ok(f.root.textContent?.includes('old-file-secret'));
    f.viewer.setLoading('data.csv');
    f.viewer.setError('无法读取另一个目录里的文件');
    assert.equal(f.root.querySelectorAll('tbody tr').length, 0);
    assert.equal(f.root.textContent?.includes('old-file-secret'), false);
    assert.equal(f.root.querySelector<HTMLDetailsElement>('details')?.hidden, true);
    assert.match(f.root.querySelector('.csv-status')!.textContent!, /无法读取/);
    const delimiter = f.root.querySelector<HTMLSelectElement>('select[aria-label="分隔符"]')!;
    delimiter.value = ';';
    delimiter.dispatchEvent(new f.dom.window.Event('change'));
    assert.equal(f.root.querySelectorAll('tbody tr').length, 0, 'A control change cannot revive the old buffer');
  } finally { f.close(); }
});
