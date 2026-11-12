import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { scenarioMetrics, deliveredJs } from './bench.mjs';

test('scenario metrics count only what they are given, and the INP estimate is the worst', () => {
  const m = scenarioMetrics(
    [{ duration: 40 }, { duration: 120 }, { duration: 64 }],
    [{ blockingDuration: 30 }, { blockingDuration: 0 }],
    [{ duration: 80 }, { duration: 40 }],
  );
  assert.deepEqual(m, { interactionCount: 3, inp: 120, totalInteractionMs: 224, loafCount: 2, loafBlockingMs: 30, longTaskCount: 2, longTaskBlockingMs: 30 });
  assert.equal(scenarioMetrics([], [], []).inp, null);
});

test('delivered JS matches build files once each and leaves out what is not in the build', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-js-'));
  try {
    fs.mkdirSync(path.join(dir, 'dist-a', 'static'), { recursive: true });
    const body = 'console.log("x");'.repeat(50);
    fs.writeFileSync(path.join(dir, 'dist-a', 'static', 'a.js'), body);
    const app = { dir, dists: { A: 'dist-a' } };
    const out = deliveredJs(app, 'A', [
      { url: 'http://127.0.0.1:5310/static/a.js', bytes: body.length },
      { url: 'http://127.0.0.1:5310/static/a.js?again', bytes: body.length },
      { url: 'blob:http://127.0.0.1:5310/abc', bytes: 10 },
      { url: 'http://127.0.0.1:5310/../outside.js', bytes: 10 },
    ]);
    assert.equal(out.files.length, 1);
    assert.equal(out.totalBytes, body.length);
    assert.equal(out.totalGzipBytes, zlib.gzipSync(Buffer.from(body), { level: 9 }).length);
    assert.deepEqual(out.unmatched, ['blob:http://127.0.0.1:5310/abc', 'http://127.0.0.1:5310/../outside.js']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
