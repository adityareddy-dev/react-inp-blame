import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('Actual server isolates the worker, serves WASM and refuses missing assets and traversal', async () => {
  const { serveActual } = await import('./adapters/actual-server.mjs');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'actual-server-'));
  await fs.writeFile(path.join(dir, 'index.html'), '<html>Actual</html>');
  await fs.writeFile(path.join(dir, 'sql.wasm'), Buffer.from([0, 97, 115, 109]));
  const server = await serveActual(dir, 0);
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const wasm = await fetch(`${origin}/sql.wasm`);
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.equal(wasm.headers.get('cross-origin-opener-policy'), 'same-origin');
    assert.equal(wasm.headers.get('cross-origin-embedder-policy'), 'require-corp');
    assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer())], [0, 97, 115, 109]);
    assert.equal((await fetch(`${origin}/missing.js`)).status, 404);
    assert.equal((await fetch(`${origin}/budget`, { headers: { accept: 'text/html' } })).status, 200);
    assert.equal((await fetch(`${origin}/%2e%2e%2fsecret`)).status, 403);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
});
