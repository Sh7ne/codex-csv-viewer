import { decodeCsvBytes, makeTable, parseCsv, safeHttpUrl, selectRows } from './csv';
import type { CsvDelimiter, CsvEncoding, CsvSort, CsvTable, ParsedCsv } from './csv';

export interface ViewerOptions {
  onRefresh?: () => void;
  onOpenLink?: (url: string) => void;
}

export interface CsvViewer {
  load(bytes: Uint8Array, fileName: string): void;
  setError(message: string): void;
  setLoading(fileName?: string): void;
  setStatus(message: string): void;
}

const PAGE_SIZE = 100;
const MAX_RENDERED_COLUMNS = 500;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text: string, action: () => void, title?: string) {
  const node = element('button', 'csv-button', text);
  node.type = 'button';
  if (title) node.title = title;
  node.addEventListener('click', action);
  return node;
}

function makeSelect(label: string, values: readonly [string, string][], initial: string) {
  const wrapper = element('label', 'csv-control');
  wrapper.append(element('span', '', label));
  const select = element('select');
  select.setAttribute('aria-label', label);
  for (const [value, caption] of values) {
    const option = element('option', '', caption);
    option.value = value;
    select.append(option);
  }
  select.value = initial;
  wrapper.append(select);
  return { wrapper, select };
}

function makeCheckbox(label: string, checked: boolean) {
  const wrapper = element('label', 'csv-checkbox');
  const input = element('input');
  input.type = 'checkbox';
  input.checked = checked;
  wrapper.append(input, document.createTextNode(label));
  return { wrapper, input };
}

function formatDelimiter(delimiter: string) {
  return ({ ',': '逗号', ';': '分号', '\t': 'Tab', '|': '竖线' } as Record<string, string>)[delimiter] ?? delimiter;
}

export function createViewer(root: HTMLElement, options: ViewerOptions = {}): CsvViewer {
  root.classList.add('csv-viewer');
  root.replaceChildren();
  let sourceBytes: Uint8Array | null = null;
  let sourceName = '';
  let parsed: ParsedCsv = { rows: [], delimiter: ',', issues: [] };
  let table: CsvTable = makeTable([], true);
  let decodingIssue = false;
  let actualEncoding = 'utf-8';
  let page = 0;
  let sort: CsvSort | null = null;
  let queryTimer: ReturnType<typeof setTimeout> | undefined;

  const heading = element('header', 'csv-heading');
  const titleGroup = element('div', 'csv-title-group');
  const badge = element('div', 'csv-label', 'CSV 查看器');
  const title = element('h1', 'csv-title', '打开 CSV 文件');
  titleGroup.append(badge, title);
  const refresh = button('刷新', () => options.onRefresh?.(), '重新读取原文件');
  refresh.disabled = !options.onRefresh;
  heading.append(titleGroup, refresh);

  const toolbar = element('div', 'csv-toolbar');
  const searchWrap = element('label', 'csv-search');
  const search = element('input');
  search.type = 'search';
  search.placeholder = '搜索所有单元格…';
  search.setAttribute('aria-label', '搜索所有单元格');
  searchWrap.append(search);
  const resetSort = button('原始顺序', () => { sort = null; page = 0; render(); });
  resetSort.disabled = true;
  toolbar.append(searchWrap, resetSort);

  const controls = element('div', 'csv-options');
  const delimiter = makeSelect('分隔符', [['auto', '自动识别'], [',', '逗号 ,'], [';', '分号 ;'], ['\t', 'Tab'], ['|', '竖线 |']], 'auto');
  const encoding = makeSelect('编码', [['auto', '自动 / UTF-8'], ['utf-8', 'UTF-8'], ['gb18030', 'GB18030 / GBK'], ['utf-16le', 'UTF-16 LE'], ['utf-16be', 'UTF-16 BE']], 'auto');
  const header = makeCheckbox('首行为表头', true);
  const wrap = makeCheckbox('单元格换行', false);
  controls.append(delimiter.wrapper, encoding.wrapper, header.wrapper, wrap.wrapper);

  const status = element('div', 'csv-status', '等待打开文件');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  const warnings = element('div', 'csv-warnings');
  warnings.hidden = true;
  const viewport = element('div', 'csv-viewport');
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', 'CSV 表格，可横向和纵向滚动');
  const grid = element('table', 'csv-table');
  const thead = element('thead');
  const tbody = element('tbody');
  grid.append(thead, tbody);
  const empty = element('div', 'csv-empty', '在 Codex 中打开一个 CSV 文件，即可在此查看。');
  viewport.append(grid, empty);
  grid.hidden = true;

  const footer = element('footer', 'csv-footer');
  const stats = element('div', 'csv-stats');
  const pagination = element('div', 'csv-pagination');
  const prev = button('上一页', () => { page = Math.max(0, page - 1); render(); viewport.scrollTop = 0; });
  const pageLabel = element('span', 'csv-page-label', '0 / 0');
  const next = button('下一页', () => { page++; render(); viewport.scrollTop = 0; });
  prev.disabled = next.disabled = true;
  pagination.append(prev, pageLabel, next);
  footer.append(stats, pagination);

  const details = element('details', 'csv-cell-details');
  details.hidden = true;
  const detailSummary = element('summary', '', '单元格完整内容');
  const detailText = element('pre', 'csv-cell-content');
  details.append(detailSummary, detailText);
  root.append(heading, toolbar, controls, status, warnings, viewport, footer, details);

  search.addEventListener('input', () => {
    clearTimeout(queryTimer);
    queryTimer = setTimeout(() => { page = 0; render(); }, 120);
  });
  delimiter.select.addEventListener('change', () => { page = 0; sort = null; parseSource(); });
  encoding.select.addEventListener('change', () => { page = 0; sort = null; parseSource(); });
  header.input.addEventListener('change', () => { table = makeTable(parsed.rows, header.input.checked); page = 0; sort = null; render(); });
  wrap.input.addEventListener('change', () => { root.classList.toggle('csv-wrap', wrap.input.checked); });

  function showCell(value: string, sourceRow: number, column: number) {
    detailSummary.textContent = `第 ${sourceRow} 条记录 · ${table.headers[column] ?? `列 ${column + 1}`} · 完整内容`;
    detailText.textContent = value === '' ? '（空单元格）' : value;
    details.hidden = false;
    details.open = true;
  }

  function parseSource() {
    if (!sourceBytes) return;
    try {
      const decoded = decodeCsvBytes(sourceBytes, encoding.select.value as CsvEncoding);
      actualEncoding = decoded.encoding;
      decodingIssue = decoded.hadDecodingErrors;
      parsed = parseCsv(decoded.text, delimiter.select.value as CsvDelimiter);
      table = makeTable(parsed.rows, header.input.checked);
      status.classList.remove('csv-error');
      status.textContent = `已读取 · ${actualEncoding.toUpperCase()} · ${formatDelimiter(parsed.delimiter)}分隔 · 原文件保持不变`;
      render();
    } catch (error) {
      showError(error instanceof Error ? error.message : String(error));
    }
  }

  function render() {
    const selected = selectRows(table.rows, search.value, sort);
    const pageCount = Math.ceil(selected.length / PAGE_SIZE);
    page = Math.min(page, Math.max(0, pageCount - 1));
    const visible = selected.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
    const renderedColumns = Math.min(table.columnCount, MAX_RENDERED_COLUMNS);
    stats.textContent = search.value
      ? `${selected.length.toLocaleString()} / ${table.rows.length.toLocaleString()} 条记录 · ${table.columnCount.toLocaleString()} 列`
      : `${table.rows.length.toLocaleString()} 条记录 · ${table.columnCount.toLocaleString()} 列`;
    pageLabel.textContent = `${pageCount ? page + 1 : 0} / ${pageCount}`;
    pageLabel.title = `每页 ${PAGE_SIZE} 条记录`;
    prev.disabled = page <= 0;
    next.disabled = page + 1 >= pageCount;
    resetSort.disabled = sort === null;
    grid.hidden = table.columnCount === 0;
    empty.hidden = visible.length > 0;
    empty.textContent = sourceBytes === null
      ? '在 Codex 中打开一个 CSV 文件，即可在此查看。'
      : parsed.rows.length === 0
        ? parsed.issues.length ? '未能显示记录，请查看上方提示。' : '这个文件是空的。'
        : table.rows.length === 0
          ? '只有表头，没有数据记录。可取消「首行为表头」查看全部内容。'
          : '没有匹配的记录。';
    const notices: string[] = [];
    if (decodingIssue) notices.push('当前编码无法完整解码此文件。若文字乱码，请切换「编码」；原文件没有修改。');
    if (table.unevenRowCount) notices.push(`${table.unevenRowCount} 条记录的列数与首条不同，额外单元格已保留，缺少的位置以空格显示。`);
    if (table.columnCount > MAX_RENDERED_COLUMNS) notices.push(`此文件有 ${table.columnCount} 列，当前视图显示前 ${MAX_RENDERED_COLUMNS} 列；搜索仍覆盖全部列。`);
    for (const issue of parsed.issues.slice(0, 5)) notices.push(`${issue.row ? `第 ${issue.row} 条记录：` : ''}${issue.message}`);
    if (parsed.issues.length > 5) notices.push(`另有 ${parsed.issues.length - 5} 项解析提示。`);
    warnings.replaceChildren(...notices.map(notice => element('div', '', notice)));
    warnings.hidden = notices.length === 0;
    thead.replaceChildren();
    const headRow = element('tr');
    const numberHead = element('th', 'csv-row-number', '#');
    numberHead.scope = 'col';
    numberHead.title = '原文件中的 CSV 记录序号（多行字段计为一条）';
    headRow.append(numberHead);
    for (let c = 0; c < renderedColumns; c++) {
      const th = element('th');
      th.scope = 'col';
      th.setAttribute('aria-sort', sort?.column === c ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none');
      const name = table.headers[c];
      const sortButton = button(name, () => {
        sort = sort?.column !== c ? { column: c, direction: 'asc' } : sort.direction === 'asc' ? { column: c, direction: 'desc' } : null;
        page = 0;
        render();
      }, `${name}：点击排序，再次点击倒序，第三次恢复原始顺序`);
      sortButton.className = 'csv-sort-button';
      sortButton.append(element('span', 'csv-sort-indicator', sort?.column === c ? (sort.direction === 'asc' ? '↑' : '↓') : '↕'));
      th.append(sortButton);
      headRow.append(th);
    }
    thead.append(headRow);
    const fragment = document.createDocumentFragment();
    for (const row of visible) {
      const tr = element('tr');
      const index = element('th', 'csv-row-number', String(row.sourceRow));
      index.scope = 'row';
      tr.append(index);
      for (let c = 0; c < renderedColumns; c++) {
        const value = row.cells[c] ?? '';
        const td = element('td');
        td.tabIndex = 0;
        td.title = value;
        td.setAttribute('aria-label', `${table.headers[c]}：${value === '' ? '空' : value}`);
        const content = element('div', 'csv-cell');
        const url = safeHttpUrl(value);
        if (url) {
          const link = element('a', 'csv-link', value);
          link.href = url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          if (options.onOpenLink) link.addEventListener('click', event => { event.preventDefault(); options.onOpenLink?.(url); });
          content.append(link);
        } else content.textContent = value;
        td.append(content);
        td.addEventListener('click', event => { if (!(event.target instanceof HTMLAnchorElement)) showCell(value, row.sourceRow, c); });
        td.addEventListener('keydown', event => {
          if (event.key === 'Enter' && event.target === td) { event.preventDefault(); showCell(value, row.sourceRow, c); }
        });
        tr.append(td);
      }
      fragment.append(tr);
    }
    tbody.replaceChildren(fragment);
  }

  function showError(message: string) {
    status.classList.add('csv-error');
    status.textContent = message;
  }

  return {
    load(bytes, fileName) {
      const changed = fileName !== sourceName;
      sourceBytes = bytes;
      sourceName = fileName;
      title.textContent = fileName;
      title.title = fileName;
      if (changed) { page = 0; sort = null; search.value = ''; details.hidden = true; }
      parseSource();
    },
    setError: showError,
    setLoading(fileName) {
      if (fileName) {
        title.textContent = fileName;
        title.title = fileName;
        if (fileName !== sourceName) {
          search.value = '';
          page = 0;
          sort = null;
        }
      }
      // Names are not file identities: two different directories can both have
      // data.csv. Never leave old cells visible while a new read may fail.
      sourceBytes = null;
      parsed = { rows: [], delimiter: ',', issues: [] };
      table = makeTable([], header.input.checked);
      detailText.textContent = '';
      details.hidden = true;
      decodingIssue = false;
      render();
      status.classList.remove('csv-error');
      status.textContent = '正在读取文件…';
    },
    setStatus(message) {
      status.classList.remove('csv-error');
      status.textContent = message;
    },
  };
}
