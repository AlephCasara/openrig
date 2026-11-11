import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const checkNode = () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (major !== 22 && major !== 24) throw new Error('Release tarball comparison requires Node 22 or 24 (Node 26 is unsupported)');
};

const listFiles = dir => {
  const files = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) files.push(relative(dir, path));
      else throw new Error(`Unsupported archive entry: ${relative(dir, path)}`);
    }
  };
  visit(dir);
  return files.sort();
};

const normalize = (path, value) => {
  if (!path.endsWith('/build-info.js')) return value;
  return value.replace(/(builtAt:\s*["'])[^"']+(["'])/g, '$1<BUILD_TIMESTAMP>$2');
};

export function compareReleaseTarballs(local, published) {
  checkNode();
  const root = mkdtempSync(join(tmpdir(), 'openrig-release-compare-'));
  try {
    const unpack = (archive, label) => {
      const dest = join(root, label);
      execFileSync('mkdir', ['-p', dest]);
      const names = execFileSync('tar', ['-tzf', resolve(archive)], { encoding: 'utf8' }).split('\n').filter(Boolean);
      for (const name of names) {
        if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`Unsafe archive entry: ${name}`);
      }
      execFileSync('tar', ['-xzf', resolve(archive), '-C', dest]);
      return dest;
    };
    const left = unpack(local, 'local');
    const right = unpack(published, 'published');
    const first = listFiles(left);
    const second = listFiles(right);
    const all = [...new Set([...first, ...second])].sort();
    const differences = [];
    for (const file of all) {
      if (!first.includes(file)) { differences.push(`Only in published: ${file}`); continue; }
      if (!second.includes(file)) { differences.push(`Only in local: ${file}`); continue; }
      const a = readFileSync(join(left, file));
      const b = readFileSync(join(right, file));
      if (a.equals(b)) continue;
      const normalizedA = normalize(file, a.toString('utf8'));
      const normalizedB = normalize(file, b.toString('utf8'));
      if (file.endsWith('/build-info.js') && normalizedA === normalizedB) continue;
      differences.push(`Different content: ${file}`);
    }
    return { localCount: first.length, publishedCount: second.length, differences };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/compare-release-tarballs.mjs <local.tgz> <published.tgz>');
    const result = compareReleaseTarballs(process.argv[2], process.argv[3]);
    console.log(`Local files: ${result.localCount}; published files: ${result.publishedCount}`);
    if (result.differences.length) {
      for (const diff of result.differences) console.error(diff);
      process.exitCode = 1;
    } else console.log('PASS: identical file lists and contents, except build-info.js builtAt');
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
