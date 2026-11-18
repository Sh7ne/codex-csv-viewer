import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, zipSync } from 'fflate';

const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

// Explicitly list every shipped file. Never recursively archive the workspace:
// source fixtures, CSV materials, local paths, logs and node_modules stay out.
export const REQUIRED_RELEASE_FILES = Object.freeze([
  '.agents/plugins/marketplace.json',
  'README.md',
  'LICENSE',
  'examples/sample.csv', // Intentionally authored public sample; no other CSV.
  'plugins/csv-viewer/.codex-plugin/plugin.json',
  'plugins/csv-viewer/.mcp.json',
  'plugins/csv-viewer/LICENSE',
  'plugins/csv-viewer/THIRD-PARTY-NOTICES.txt',
  'plugins/csv-viewer/assets/icon.svg',
  'plugins/csv-viewer/dist/server.mjs',
  'plugins/csv-viewer/dist/viewer.html',
]);
export const OPTIONAL_RELEASE_FILES = Object.freeze(['CHANGELOG.md', 'PRIVACY.md']);

export async function readReleaseFile(root, relativeName) {
  const file = path.join(root, ...relativeName.split('/'));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new Error(`Release input must be a regular file, not a symlink: ${relativeName}`);
  }
  const resolved = await realpath(file);
  const relativeResolved = path.relative(root, resolved);
  if (relativeResolved.startsWith(`..${path.sep}`) || relativeResolved === '..' || path.isAbsolute(relativeResolved)) {
    throw new Error(`Release input resolves outside the project: ${relativeName}`);
  }
  return readFile(file);
}

export function verifyPublicContent(relativeName, bytes, root) {
  if (/(?:^|\/)(?:node_modules|test-results|reference|\.git)(?:\/|$)/.test(relativeName)) {
    throw new Error(`Private/development directory in release: ${relativeName}`);
  }
  if (/\.csv$/i.test(relativeName) && relativeName !== 'examples/sample.csv') {
    throw new Error(`Only the authored public sample CSV may be released: ${relativeName}`);
  }
  const text = bytes.toString('utf8');
  const normalized = text.replace(/\\\//g, '/');
  // This intentionally rejects host-specific home/temp paths in documentation
  // as well as compiled assets; file names are reported without exposing matches.
  const hostPath = /\/Users\/|\/home\/|[A-Za-z]:[\\/]+Users[\\/]+|\/private\/(?:var|tmp)\//;
  if (hostPath.test(normalized) || normalized.includes(root)) {
    throw new Error(`Host-specific absolute path found in release input: ${relativeName}`);
  }
}

function jsonFrom(files, name) {
  try {
    return JSON.parse(files.get(name).toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid release JSON: ${name}`, { cause: error });
  }
}

function verifyInstallableStructure(files, version) {
  const manifest = jsonFrom(files, 'plugins/csv-viewer/.codex-plugin/plugin.json');
  if (manifest.name !== 'csv-viewer' || manifest.version !== version) {
    throw new Error('Root package version and csv-viewer manifest version must match.');
  }
  if (manifest.mcpServers !== './.mcp.json' || manifest.requires_local_executor !== true) {
    throw new Error('The release must register the bundled local .mcp.json server.');
  }
  for (const value of [manifest.interface?.composerIcon, manifest.interface?.logo]) {
    if (typeof value !== 'string' || !value.startsWith('./') || value.includes('..')) {
      throw new Error('Plugin icons must use safe relative file paths.');
    }
    if (!files.has(`plugins/csv-viewer/${value.slice(2)}`)) {
      throw new Error('A plugin icon is not included in the release allowlist.');
    }
  }
  const mcp = jsonFrom(files, 'plugins/csv-viewer/.mcp.json').mcpServers?.['csv-viewer'];
  if (mcp?.command !== 'node' || mcp.cwd !== '.' || JSON.stringify(mcp.args) !== JSON.stringify(['./dist/server.mjs'])) {
    throw new Error('The packaged MCP command must run the self-contained ./dist/server.mjs with Node from the plugin root.');
  }
  const marketplace = jsonFrom(files, '.agents/plugins/marketplace.json');
  const entry = marketplace.plugins?.find(plugin => plugin.name === 'csv-viewer');
  if (!marketplace.name || entry?.source?.source !== 'local' || entry.source.path !== './plugins/csv-viewer') {
    throw new Error('Marketplace must refer to ./plugins/csv-viewer using the local source type.');
  }
}

/** Build a deterministic, locally installable ZIP without invoking OS tools. */
export async function packageRelease(projectRoot = PROJECT_ROOT) {
  const root = await realpath(projectRoot);
  const packageInfo = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = packageInfo.version;
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?(?:\+[A-Za-z0-9.-]+)?$/.test(version)) {
    throw new Error('package.json must contain a safe semantic version.');
  }
  const files = new Map();
  for (const name of REQUIRED_RELEASE_FILES) {
    files.set(name, await readReleaseFile(root, name));
  }
  for (const name of OPTIONAL_RELEASE_FILES) {
    try {
      files.set(name, await readReleaseFile(root, name));
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const [name, bytes] of files) verifyPublicContent(name, bytes, root);
  verifyInstallableStructure(files, version);

  const folder = `codex-csv-viewer-${version}`;
  const entries = {};
  // ZIP stores local calendar fields. This fixed local date generates the same
  // DOS timestamp in every timezone and avoids source file mtime dependence.
  const timestamp = new Date(2000, 0, 1, 0, 0, 0);
  for (const [name, bytes] of [...files].sort(([a], [b]) => a.localeCompare(b, 'en'))) {
    entries[`${folder}/${name}`] = [new Uint8Array(bytes), {
      level: 9,
      mtime: timestamp,
      os: 3,
      attrs: (0o100644 * 65536) >>> 0,
    }];
  }
  const archive = zipSync(entries, { level: 9 });
  const unpacked = unzipSync(archive);
  const expectedNames = Object.keys(entries).sort();
  if (JSON.stringify(Object.keys(unpacked).sort()) !== JSON.stringify(expectedNames)) {
    throw new Error('Archive verification failed: missing or unexpected entries.');
  }
  for (const [name, bytes] of files) {
    if (!Buffer.from(unpacked[`${folder}/${name}`]).equals(bytes)) {
      throw new Error(`Archive verification failed: byte mismatch for ${name}`);
    }
  }

  const directory = path.join(root, 'release');
  await mkdir(directory, { recursive: true });
  const fileName = `${folder}.zip`;
  const archivePath = path.join(directory, fileName);
  const sumPath = path.join(directory, 'SHA256SUMS');
  const checksum = createHash('sha256').update(archive).digest('hex');
  const archiveTemporaryPath = `${archivePath}.tmp-${process.pid}`;
  const sumTemporaryPath = `${sumPath}.tmp-${process.pid}`;
  await writeFile(archiveTemporaryPath, archive);
  await rename(archiveTemporaryPath, archivePath);
  await writeFile(sumTemporaryPath, `${checksum}  ${fileName}\n`, 'utf8');
  await rename(sumTemporaryPath, sumPath);
  return { archivePath, sumPath, sha256: checksum, bytes: archive.length, fileCount: files.size, entries: expectedNames };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await packageRelease();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(`Packaging failed: ${error.message}`);
    process.exitCode = 1;
  }
}
