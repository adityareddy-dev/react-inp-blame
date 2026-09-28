import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { warnOnce } from '../src/warn.js';

// Every warning ends with a link to the README on GitHub, by anchor. These tests read the anchors out of
// the source and check that each one is in README.md, on a line that links on to the same anchor in docs/, and
// that the answer is there, so a renamed heading or a new warning cannot leave a link pointing nowhere.

const core = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => fs.readFileSync(path.join(core, file), 'utf8');
const HELP = 'https://github.com/adityareddy-dev/react-inp-blame#';

/** The anchors a markdown file has: each `<a id>` and each heading, slugged the way GitHub does it. */
function anchorsOf(file: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  let fenced = false;
  for (const line of read(file).split('\n')) {
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

/** Each run of `<a id>`s in a markdown file, by each id in it: anchors stacked with nothing between land on one spot. */
function stackedIds(file: string): Map<string, string[]> {
  const stacks = new Map<string, string[]>();
  for (const run of read(file).matchAll(/(?:<a\s+id="[^"]+"><\/a>\s*)+/g)) {
    const ids = [...run[0].matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
    for (const id of ids) stacks.set(id, ids);
  }
  return stacks;
}

/** Where README.md's line for each anchor links on to: the link right after its `<a id>` and any stacked with it. */
function readmeLinks(): Map<string, { ids: string[]; to: string }> {
  const links = new Map<string, { ids: string[]; to: string }>();
  for (const match of read('../../README.md').matchAll(/((?:<a\s+id="[^"]+"><\/a>)+)\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const ids = [...match[1]!.matchAll(/id="([^"]+)"/g)].map((m) => m[1]!);
    for (const id of ids) links.set(id, { ids, to: match[2]! });
  }
  return links;
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

const readmeAnchors = () => anchorsOf('../../README.md');
/** Where the answers are: troubleshooting, and the setups a build-time warning sends people to. */
const answerPages = Object.fromEntries(
  ['docs/troubleshooting.md', 'docs/install.md'].map((page) => [page, { anchors: anchorsOf(`../../${page}`), stacks: stackedIds(`../../${page}`) }]),
);

/** Whether README.md's line for `anchor` links on to the same anchor in docs/troubleshooting.md or docs/install.md. */
function linksOn(anchor: string, link: { ids: string[]; to: string } | undefined): boolean {
  const to = link && /^(docs\/(?:troubleshooting|install)\.md)#(.+)$/.exec(link.to);
  if (!to) return false;
  const page = answerPages[to[1]!]!;
  if (!page.anchors.has(to[2]!)) return false;
  // Anchors stacked on one line of README.md share its link, which has to land where the page stacks them too.
  return to[2] === anchor || (link.ids.includes(to[2]!) && (page.stacks.get(to[2]!) ?? []).includes(anchor));
}

test('every anchor a warning links to is in README.md, on a line that links on to the same anchor in docs/', () => {
  const readme = readmeAnchors();
  const links = readmeLinks();
  const linked = { runtime: runtimeAnchors(), next: nextAnchors(), vite: viteAnchors(), astro: astroAnchors() };
  // Enough found that a regex gone stale would show.
  assert.ok(linked.runtime.length >= 14, linked.runtime.join(', '));
  assert.ok(linked.next.length >= 4, linked.next.join(', '));
  assert.ok(linked.vite.length >= 8, linked.vite.join(', '));
  assert.ok(linked.astro.length >= 1, linked.astro.join(', '));
  for (const [where, anchors] of Object.entries(linked)) {
    const missing = anchors.filter((anchor) => !readme.has(anchor));
    assert.deepEqual(missing, [], `${where} warnings link to anchors README.md does not have`);
    const unanswered = anchors.filter((anchor) => !linksOn(anchor, links.get(anchor))).map((anchor) => `${anchor} -> ${links.get(anchor)?.to ?? 'no link'}`);
    assert.deepEqual(unanswered, [], `${where} warnings link to lines of README.md that do not link on to the same anchor in docs/troubleshooting.md or docs/install.md`);
  }
});

test('headings are slugged the way GitHub does', () => {
  const readme = readmeAnchors();
  for (const anchor of ['start-with-vite', 'start-with-nextjs-142-or-later', 'when-the-blame-is-wrong', 'troubleshooting', 'late-install']) {
    assert.ok(readme.has(anchor), anchor);
  }
  // A heading with brackets. README.md has an <a id> of this name, so the heading is read where it is, in docs/api.md.
  assert.ok(anchorsOf('../../docs/api.md').has('installoptions'), 'installoptions');
});
