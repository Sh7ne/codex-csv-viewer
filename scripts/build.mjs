import { build } from 'esbuild';
import { mkdir, readFile, writeFile, readdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const dist = path.join(root, 'plugins/csv-viewer/dist');
await mkdir(dist, { recursive: true });
const result = await build({
  absWorkingDir: root, entryPoints: ['src/app.ts'], bundle: true, write: false,
  outdir: 'build', format: 'esm', platform: 'browser', target: 'es2022',
  minify: true, legalComments: 'none', metafile: true,
});
const js = result.outputFiles.find(f => f.path.endsWith('.js')).text;
const css = result.outputFiles.find(f => f.path.endsWith('.css'))?.text ?? '';
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>CSV 表格查看器</title><style>${css.replace(/<\/style/gi, '<\\/style')}</style></head><body><main id="app"></main><script type="module">${js.replace(/<\/script/gi, '<\\/script')}</script></body></html>`;
await writeFile(path.join(dist, 'viewer.html'), html);
const serverResult = await build({
  absWorkingDir: root, entryPoints: ['src/server.ts'], bundle: true,
  outfile: path.join(dist, 'server.mjs'), format: 'esm', platform: 'node', target: 'node22',
  banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  minify: true, legalComments: 'eof', metafile: true,
});
const bundledPackages = new Set();
for (const input of [...Object.keys(result.metafile.inputs), ...Object.keys(serverResult.metafile.inputs)]) {
  const match = input.match(/^node_modules\/((?:@[^/]+\/)?[^/]+)/);
  if (match) bundledPackages.add(match[1]);
}
const notices = [];
for (const name of [...bundledPackages].sort()) {
  const directory = path.join(root, 'node_modules', name);
  const info = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
  const licenseFiles = (await readdir(directory)).filter(name => /^(licen[sc]e|copying|notice)(\..*)?$/i.test(name));
  const texts = await Promise.all(licenseFiles.map(name => readFile(path.join(directory, name), 'utf8')));
  notices.push(`${info.name} ${info.version}\nLicense: ${typeof info.license === 'string' ? info.license : JSON.stringify(info.license)}\n${texts.join('\n')}`);
}
await writeFile(path.join(root, 'plugins/csv-viewer/THIRD-PARTY-NOTICES.txt'), notices.join('\n\n' + '='.repeat(72) + '\n\n'));
await copyFile(path.join(root, 'LICENSE'), path.join(root, 'plugins/csv-viewer/LICENSE'));
console.log('Built CSV viewer UI and bundled stdio server.');
