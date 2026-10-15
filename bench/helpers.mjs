// Helpers shared by every app definition: apps.mjs and the apps kept in files of their own.

import { spawnSync } from 'node:child_process';

export /** Waits until the page has been quiet (no long task, no pending work) for `quietMs`. */
async function settle(page, quietMs = 400, timeoutMs = 20000) {
  await page.waitForFunction(
    (q) => {
      const w = window;
      if (!w.__benchLastLongTask) w.__benchLastLongTask = 0;
      return performance.now() - Math.max(w.__benchLastLongTask, w.__benchLoadedAt || 0) > q;
    },
    quietMs,
    { timeout: timeoutMs, polling: 100 },
  );
}

export

async function pollFor(read, ok, timeoutMs = 20000, everyMs = 200) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    last = await read();
    if (ok(last)) return last;
    if (Date.now() > deadline) return last;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

export /** Throws unless `origin` is on 127.0.0.1, the only host a sign-in is ever sent to. */
function localOrigin(origin) {
  if (new URL(origin).hostname !== '127.0.0.1') throw new Error(`${origin} is not on 127.0.0.1, and the harness only signs in there`);
}

export /** Resolves once the URL answers, or throws after `timeoutMs`. */
async function waitForHttp(url, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url, { redirect: 'manual' });
      if (res.status > 0) return;
    } catch {
      /* not listening yet */
    }
    if (Date.now() > deadline) throw new Error(`${url} never answered within ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export /**
 * Kills a process and everything it spawned. `next start` runs its render work in child
 * processes, and killing only the parent on Windows leaves them holding the port.
 */
function killTree(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.benchKilled = true;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      child.kill('SIGKILL');
    }
  }
}
