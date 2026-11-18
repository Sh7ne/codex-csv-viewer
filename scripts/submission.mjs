import { createHash } from 'node:crypto';
import { mkdir, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import { REQUIRED_RELEASE_FILES, readReleaseFile, verifyPublicContent } from './package.mjs';

// The portal consumes one plugin, so all the plugin's files live at the ZIP root.
// Use the same bundled application bytes and runtime allowlist as the GitHub release.
const root = await realpath(fileURLToPath(new URL('..', import.meta.url)));
const pluginPrefix = 'plugins/csv-viewer/';
const manifestName = '.codex-plugin/plugin.json';
const files = {};
for (const sourceName of REQUIRED_RELEASE_FILES.filter(name => name.startsWith(pluginPrefix))) {
  const bytes = await readReleaseFile(root, sourceName);
  verifyPublicContent(sourceName, bytes, root);
  files[sourceName.slice(pluginPrefix.length)] = bytes;
}

const manifest = JSON.parse(files[manifestName].toString('utf8'));
const listing = JSON.parse(await readReleaseFile(root, 'submission/listing.json'));
const review = JSON.parse(await readReleaseFile(root, 'submission/review.json'));
if (review.test_cases?.positive?.length !== 5 || review.test_cases?.negative?.length !== 3) {
  throw new Error('Initial review requires five positive cases and three negative cases.');
}
for (const field of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
  const url = new URL(listing[field]);
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`Invalid listing URL: ${field}`);
}
Object.assign(manifest.interface, listing);
manifest.homepage = listing.websiteURL;
manifest.repository = listing.websiteURL;
manifest.extensions ??= {};
manifest.extensions['com.openai'] = {
  ...manifest.extensions['com.openai'],
  review,
  publication: {
    release_notes: `CSV Viewer ${manifest.version} includes the local server, table interface and JavaScript dependencies. It requires Node.js 22.16 or later on PATH.`,
    translations: {
      'zh-CN': {
        subtitle: '直接以表格查看 CSV 原文件',
        description: '打开本地 CSV 即可搜索、排序和逐行查看。支持编码与分隔符选择，单文件上限为 32 MiB。需要在 PATH 中安装 Node.js 22.16 或更新版本。sh7ne 出品，与 Codex 协作开发。',
      },
    },
  },
};
const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
verifyPublicContent(manifestName, manifestBytes, root);
files[manifestName] = manifestBytes;

const archive = zipSync(files, { mtime: new Date(2000, 0, 1), level: 9 });
const outputDirectory = path.join(root, 'release', 'submission');
await mkdir(outputDirectory, { recursive: true });
const filename = `csv-viewer-${manifest.version}.zip`;
const destination = path.join(outputDirectory, filename);
const temporaryFile = `${destination}.tmp-${process.pid}`;
await writeFile(temporaryFile, archive);
await rename(temporaryFile, destination);
const digest = createHash('sha256').update(archive).digest('hex');
console.log(`${digest}  ${destination}`);
if (!review.demo_recording_url) {
  console.log('The ZIP includes review cases. Add the accessible walkthrough URL before submitting it for review.');
}
