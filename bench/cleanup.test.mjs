import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const retired = /excalidraw|tt-(?:fuzzy|virtual)|tanstack[ /-](?:table|virtual)|shadcn(?:-v\d|-sheet|\/ui docs|.*documentation)|twentyhq|twenty(?:-crm|\/|['’]s)|cal[.-](?:diy|com)|before-after\.mjs/i;

test('retired benchmark material stays out of tracked source and docs', () => {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' }).split('\0');
  for (const file of files) {
    if (!file || file.startsWith('.github/agents/') || file === 'bench/cleanup.test.mjs') continue;
    assert.doesNotMatch(file, retired, file);
    if (!/\.(?:md|mjs|cjs|ts|tsx|json|yml|yaml|patch)$/.test(file) || file.endsWith('package-lock.json')) continue;
    const absolute = path.join(ROOT, file);
    if (!fs.existsSync(absolute)) continue;
    let text = fs.readFileSync(absolute, 'utf8');
    // The purge audit must identify removed paths, not reproduce their contents.
    if (file === 'docs/benchmarks/README.md') text = text.split('\n## History purge\n')[0];
    assert.doesNotMatch(text, retired, file);
  }
});

test('obsolete benchmark artifacts are absent', () => {
  for (const file of ['before-after.mjs', 'apps', 'patches', 'twenty-login.mjs', 'caldiy-login.mjs', 'apps-twenty.mjs', 'apps-caldiy.mjs', 'apps-shadcn-sheet.mjs', '.gitattributes']) {
    assert.equal(fs.existsSync(path.join(ROOT, 'bench', file)), false, file);
  }
});
