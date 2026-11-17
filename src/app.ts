import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
import { OpenAIExtensions, OpenAIFileEntrypointInputSchema } from '@openai/mcp-extensions/app';
import { createViewer } from './viewer';
import './viewer.css';
import { VERSION } from './version';

const app = new App({ name: 'CSV 表格查看器', version: VERSION });
const extensions = new OpenAIExtensions(app);
let currentFile: { name: string; resourceUri: string } | undefined;
let subscribedUri: string | undefined;
let requestGeneration = 0;
let subscriptionWork: Promise<void> = Promise.resolve();
const MAX_BYTES = 32 * 1024 * 1024;

const viewer = createViewer(document.getElementById('app')!, {
  onRefresh: () => { void reload(); },
  onOpenLink: (url) => {
    if (/^https?:\/\//i.test(url)) {
      void app.openLink({ url }).catch(() => viewer.setStatus('无法打开链接，可以复制单元格中的地址。'));
    }
  },
});

function applyContext(context: ReturnType<App['getHostContext']>) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}

function decodeBase64(blob: string): Uint8Array {
  if (blob.length > Math.ceil(MAX_BYTES / 3) * 4 + 4) throw new Error('文件超过当前查看器的 32 MB 限制。');
  const binary = atob(blob);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

async function reload() {
  const file = currentFile;
  if (!file) return;
  const generation = ++requestGeneration;
  viewer.setLoading(file.name);
  try {
    if (!extensions.resources) throw new Error('当前宿主未开放文件读取接口。请从 Codex 的 CSV 文件查看器入口打开此文件。');
    const response = await extensions.resources.read({ uri: file.resourceUri, representation: 'blob' });
    if (generation !== requestGeneration) return;
    const content = response.contents.find(c => c.uri === file.resourceUri) ?? response.contents[0];
    if (!content) throw new Error('没有读取到文件内容。');
    let bytes: Uint8Array;
    if ('blob' in content && typeof content.blob === 'string') bytes = decodeBase64(content.blob);
    else if ('text' in content && typeof content.text === 'string') bytes = new TextEncoder().encode(content.text);
    else throw new Error('宿主返回了无法识别的文件内容。');
    if (bytes.byteLength > MAX_BYTES) throw new Error('文件超过当前查看器的 32 MB 限制。');
    viewer.load(bytes, file.name);
  } catch (error) {
    if (generation === requestGeneration) viewer.setError(error instanceof Error ? error.message : String(error));
  }
}

function updateSubscription() {
  // Serialize subscription changes so a late response for a previously opened
  // file can never unsubscribe or replace the active file's subscription.
  subscriptionWork = subscriptionWork.catch(() => undefined).then(async () => {
    const resources = extensions.resources;
    if (!resources) return;
    const wanted = currentFile?.resourceUri;
    if (subscribedUri === wanted) return;
    const previous = subscribedUri;
    subscribedUri = undefined;
    if (previous) await resources.unsubscribe({ uri: previous }).catch(() => undefined);
    if (!wanted || currentFile?.resourceUri !== wanted) return;
    try {
      await resources.subscribe({ uri: wanted });
      subscribedUri = wanted;
    } catch {
      // Manual refresh remains available on hosts without live subscriptions.
    }
  });
}

async function openFile(args: unknown) {
  const parsed = OpenAIFileEntrypointInputSchema.safeParse(args);
  if (!parsed.success) {
    currentFile = undefined;
    ++requestGeneration;
    updateSubscription();
    viewer.setLoading();
    viewer.setError('请点击一个 CSV 文件，并选择「CSV 表格查看器」。');
    return;
  }
  currentFile = parsed.data.file;
  updateSubscription();
  await reload();
}

app.addEventListener('hostcontextchanged', applyContext);
app.addEventListener('toolinput', ({ arguments: args }) => { void openFile(args); });
app.onerror = (error) => viewer.setStatus(error instanceof Error ? error.message : '连接暂时中断，可尝试重新打开文件。');
try {
  await app.connect();
  applyContext(app.getHostContext());
  extensions.resources?.addUpdateHandler(({ params }) => {
    if (params.uri === currentFile?.resourceUri) void reload();
  });
} catch (error) {
  viewer.setError(`查看器连接失败：${error instanceof Error ? error.message : String(error)}`);
}
