import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { compareReleaseTarballs } from './compare-release-tarballs.mjs';

test('release comparator accepts only builtAt changes in stamp files', () => {
  const root = mkdtempSync(join(tmpdir(), 'release-compare-'));
  try {
    const archives = [];
    for (const [index, builtAt] of ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'].entries()) {
      const dir = join(root, `build-${index}`);
      mkdirSync(join(dir, 'package', 'daemon', 'dist'), { recursive: true });
      writeFileSync(join(dir, 'package', 'daemon', 'dist', 'build-info.js'), `export const BUILD_INFO = { commit: "abcdef", builtAt: "${builtAt}" };\n`);
      writeFileSync(join(dir, 'package', 'cli.js'), 'export default 42;\n');
      const archive = join(root, `build-${index}.tgz`);
      execFileSync('tar', ['-czf', archive, '-C', dir, 'package']);
      archives.push(archive);
    }
    assert.equal(compareReleaseTarballs(...archives).differences.length, 0);
    mkdirSync(join(root, 'extra', 'package'), { recursive: true });
    writeFileSync(join(root, 'extra', 'package', 'extra.txt'), 'new');
    const different = join(root, 'different.tgz');
    execFileSync('tar', ['-czf', different, '-C', join(root, 'extra'), 'package']);
    assert.match(compareReleaseTarballs(archives[0], different).differences.join('\n'), /extra\.txt|cli\.js/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
