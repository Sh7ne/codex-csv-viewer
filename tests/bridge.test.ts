import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM, VirtualConsole } from 'jsdom';

interface Rpc {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code: number; message: string };
}

const bundle = build({
  entryPoints: [fileURLToPath(new URL('../src/app.ts', import.meta.url))],
  bundle: true, write: false, format: 'esm', platform: 'browser', target: 'es2022',
  loader: { '.css': 'empty' },
});

async function until(predicate: () => boolean, message: string) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`Timed out: ${message}`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function hostFixture() {
  const dom = new JSDOM('<!doctype html><html><body><main id="app"></main></body></html>', {
    url: 'https://csv-viewer.test/', runScripts: 'dangerously', pretendToBeVisual: true,
    virtualConsole: new VirtualConsole(),
  });
  const window = dom.window;
  Object.assign(window, {
    TextEncoder, TextDecoder,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
  });
  const calls: Rpc[] = [];
  const pending: Rpc[] = [];
  const heldMethods = new Set<string>();
  const send = (message: Rpc) => window.dispatchEvent(new window.MessageEvent('message', { data: message, source: window as unknown as Window }));
  const reply = (request: Rpc, result: unknown = {}) => send({ jsonrpc: '2.0', id: request.id, result });
  window.postMessage = ((message: Rpc) => {
    calls.push(message);
    if (message.id === undefined) return;
    if (message.method === 'ui/initialize') {
      queueMicrotask(() => reply(message, {
        protocolVersion: '2026-01-26', hostInfo: { name: 'csv-test-host', version: '1.0.0' },
        hostCapabilities: { experimental: { 'openai/resource': {} } }, hostContext: { theme: 'light' },
      }));
    } else if (message.method === 'resources/read' || heldMethods.has(message.method!)) {
      pending.push(message);
    } else if (['resources/subscribe', 'resources/unsubscribe', 'ui/open-link'].includes(message.method!)) {
      queueMicrotask(() => reply(message, {}));
    } else {
      queueMicrotask(() => send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Unexpected method: ${message.method}` } }));
    }
  }) as typeof window.postMessage;
  // Execute only our bundled application in an isolated DOM, never the native Codex app.
  const result = await bundle;
  await window.eval(`(async () => {\n${result.outputFiles[0].text}\n})()`);
  assert.ok(calls.some(call => call.method === 'ui/notifications/initialized'));
  assert.equal(window.document.querySelector('.csv-error'), null, 'Handshake succeeds');
  const open = (uri: string, name = 'data.csv') => send({ jsonrpc: '2.0', method: 'ui/notifications/tool-input', params: { arguments: { file: { name, resourceUri: uri } } } });
  const getPending = (method: string, uri: string) => pending.find(request => request.method === method && request.params?.uri === uri);
  const read = async (uri: string) => {
    await until(() => !!getPending('resources/read', uri), `read ${uri}`);
    return getPending('resources/read', uri)!;
  };
  const deliver = (request: Rpc, csv: string) => reply(request, { contents: [{ uri: request.params!.uri, mimeType: 'text/csv', blob: Buffer.from(csv).toString('base64') }] });
  return { dom, window, calls, pending, heldMethods, open, read, deliver, reply, getPending, send, close: () => dom.window.close() };
}

test('host bridge discards late reads and clears a failed same-basename replacement without writing', async () => {
  const h = await hostFixture();
  try {
    h.open('host-resource://A');
    const a = await h.read('host-resource://A');
    h.open('host-resource://B');
    const b = await h.read('host-resource://B');
    h.deliver(b, 'name,value\nB-current,002');
    await until(() => h.window.document.querySelector('tbody')?.textContent?.includes('B-current') === true, 'B renders');
    h.deliver(a, 'name,value\nA-stale,001');
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(h.window.document.querySelector('tbody')!.textContent!, /B-current/);
    assert.doesNotMatch(h.window.document.body.textContent!, /A-stale/);

    h.open('host-resource://C');
    const c = await h.read('host-resource://C');
    h.send({ jsonrpc: '2.0', id: c.id, error: { code: -32000, message: 'The replacement file is unavailable' } });
    await until(() => !!h.window.document.querySelector('.csv-error'), 'C read error');
    assert.equal(h.window.document.querySelectorAll('tbody tr').length, 0);
    assert.doesNotMatch(h.window.document.body.textContent!, /B-current|A-stale/);
    assert.ok(h.calls.filter(call => call.method === 'resources/read').every(call => {
      const metadata = call.params?._meta as Record<string, { representation?: string }> | undefined;
      return metadata?.['openai/resource']?.representation === 'blob';
    }), 'Host reads explicitly request original file bytes');
    assert.equal(h.calls.some(call => /write/i.test(call.method ?? '')), false);
  } finally { h.close(); }
});

test('a delayed unsubscribe does not make an older file replace the newest one or its subscription', async () => {
  const h = await hostFixture();
  try {
    h.open('host-resource://A');
    h.deliver(await h.read('host-resource://A'), 'name\nA-original');
    await until(() => h.calls.some(call => call.method === 'resources/subscribe' && call.params?.uri === 'host-resource://A'), 'subscribe A');
    await new Promise(resolve => setTimeout(resolve, 10));
    h.heldMethods.add('resources/unsubscribe');
    h.open('host-resource://B');
    const b = await h.read('host-resource://B');
    await until(() => !!h.getPending('resources/unsubscribe', 'host-resource://A'), 'held unsubscribe A');
    h.open('host-resource://C');
    h.deliver(await h.read('host-resource://C'), 'name\nC-newest');
    await until(() => h.window.document.querySelector('tbody')?.textContent?.includes('C-newest') === true, 'C renders while unsubscribe waits');
    h.reply(h.getPending('resources/unsubscribe', 'host-resource://A')!);
    h.deliver(b, 'name\nB-stale');
    await until(() => h.calls.some(call => call.method === 'resources/subscribe' && call.params?.uri === 'host-resource://C'), 'subscribe newest file');
    assert.match(h.window.document.querySelector('tbody')!.textContent!, /C-newest/);
    assert.doesNotMatch(h.window.document.body.textContent!, /B-stale|A-original/);
    assert.equal(h.calls.some(call => call.method === 'resources/subscribe' && call.params?.uri === 'host-resource://B'), false);
    assert.equal(h.calls.some(call => /write/i.test(call.method ?? '')), false);
  } finally { h.close(); }
});
