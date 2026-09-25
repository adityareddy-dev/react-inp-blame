import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { warnOnce } from '../src/warn.js';

// Every warning ends with a link to the README on GitHub, by anchor. These tests read the anchors out of
// the source and check that each one is in README.md, so a renamed heading or a new warning cannot leave
// a link pointing nowhere.

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(core, file), 'utf8');
const HELP = 'https://github.com/adityareddy-dev/react-inp-blame#';

/** The anchors README.md has: each `<a id>` and each heading, slugged the way GitHub does it. */
function readmeAnchors(): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of read('../../README.md').split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced) continue;
    for (const match of line.matchAll(/<a\s+id="([^"]+)"/g)) anchors.add(match[1]!);
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (!heading) continue;
    const slug = heading[1]!
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s/g, '-');
    const count = seen.get(slug) ?? 0;
    seen.set(slug, count + 1);
    anchors.add(count ? `${slug}-${count}` : slug);
  }
  return anchors;
}

/** Each call of `warnOnce(` in `source`, not counting its definition. */
const calls = (source: string) => source.split('warnOnce(').length - 1 - (source.match(/function warnOnce\(/g)?.length ?? 0);

/** The anchors the browser's warnings link to: a call's key, unless it names another anchor. */
function runtimeAnchors(): string[] {
  const anchors: string[] = [];
  let made = 0;
  let found = 0;
  for (const file of fs.readdirSync(path.join(core, 'src')).filter((f) => f.endsWith('.ts'))) {
    const source = read(`src/${file}`);
    made += calls(source);
    for (const match of source.matchAll(/warnOnce\(\s*'([a-z-]+)'/g)) {
      anchors.push(match[1]!);
      found++;
    }
    // A react-dom that cannot be read is warned about by its message, and linked by the kind of problem.
    if (source.includes('warnOnce(renderer.problem.message, renderer.problem.message, renderer.problem.kind)')) {
      found++;
      for (const match of source.matchAll(/(?:problem|stopReading)\((?:renderer, )?'([a-z-]+)'/g)) anchors.push(match[1]!);
    }
  }
  assert.equal(found, made, 'every warnOnce call has a literal key, or is the one linked by the kind of problem');
  return anchors;
}

/** The anchors withInpBlame's warnings link to: the last argument of each call. */
function nextAnchors(): string[] {
  const source = read('next.cjs');
  const anchors = [...source.matchAll(/warnOnce\(\s*'[A-Z_]+',[\s\S]*?'([a-z-]+)',?\s*\);/g)].map((m) => m[1]!);
  assert.equal(anchors.length, calls(source), 'every withInpBlame warning names its anchor');
  return anchors;
}

/** The anchors the Vite plugin's messages link to, written after its README constant or as a framework's section. */
function viteAnchors(): string[] {
  const source = read('vite.mjs');
  return [...source.matchAll(/\$\{README\}([a-z0-9-]+)/g), ...source.matchAll(/section: '([a-z0-9-]+)'/g)].map((m) => m[1]!);
}

/** The anchors the Astro integration's messages link to. */
function astroAnchors(): string[] {
  return [...read('astro.mjs').matchAll(/react-inp-blame#([a-z0-9-]+)/g)].map((m) => m[1]!);
}

test('a warning in the browser ends with a link to its anchor in the README', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  warnOnce('troubleshooting-test', 'something happened.');
  warnOnce('troubleshooting-test-2', 'something else happened.', 'another-anchor');
  assert.equal(warn.mock.calls[0]!.arguments[0], `[react-inp-blame] something happened. See ${HELP}troubleshooting-test`);
  assert.equal(warn.mock.calls[1]!.arguments[0], `[react-inp-blame] something else happened. See ${HELP}another-anchor`);
});

test('every anchor a warning links to is in README.md', () => {
  const readme = readmeAnchors();
  const linked = { runtime: runtimeAnchors(), next: nextAnchors(), vite: viteAnchors(), astro: astroAnchors() };
  // Enough found that a regex gone stale would show.
  assert.ok(linked.runtime.length >= 14, linked.runtime.join(', '));
  assert.ok(linked.next.length >= 4, linked.next.join(', '));
  assert.ok(linked.vite.length >= 8, linked.vite.join(', '));
  assert.ok(linked.astro.length >= 1, linked.astro.join(', '));
  for (const [where, anchors] of Object.entries(linked)) {
    const missing = anchors.filter((anchor) => !readme.has(anchor));
    assert.deepEqual(missing, [], `${where} warnings link to anchors README.md does not have`);
  }
});

test('the README slugs headings the way GitHub does', () => {
  const readme = readmeAnchors();
  for (const anchor of ['install-with-vite', 'installoptions', 'install-with-nextjs-142-or-later', 'troubleshooting', 'late-install']) {
    assert.ok(readme.has(anchor), anchor);
  }
});
