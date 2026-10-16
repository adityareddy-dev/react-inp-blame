import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import kresus from './adapters/kresus.mjs';
import { yarnCommand } from './adapters/kresus-tools.mjs';

test('Linux keeps its Yarn executable and does not use a shell', () => {
    assert.deepEqual(yarnCommand(['install'], { platform: 'linux', executable: '/opt/node22/bin/yarn' }), {
        command: '/opt/node22/bin/yarn', args: ['install'], shell: false,
    });
});

test('Windows uses a shell only for command scripts', () => {
    assert.deepEqual(yarnCommand(['install'], { platform: 'win32', executable: 'yarn.cmd' }), {
        command: 'yarn.cmd', args: ['install'], shell: true,
    });
    assert.deepEqual(yarnCommand(['install'], { platform: 'win32', executable: 'C:\\tools with spaces\\yarn.cmd' }), {
        command: '"C:\\tools with spaces\\yarn.cmd"', args: ['install'], shell: true,
    });
    assert.deepEqual(yarnCommand(['install'], { platform: 'win32', executable: 'C:\\tools with spaces\\yarn.exe' }), {
        command: 'C:\\tools with spaces\\yarn.exe', args: ['install'], shell: false,
    });
});

for (const extension of ['js', 'cjs']) {
    test(`a Yarn .${extension} entry point preserves paths and arguments with spaces`, (t) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kresus yarn with spaces '));
        const cli = path.join(dir, `yarn entry.${extension}`);
        t.after(() => {
            fs.unlinkSync(cli);
            fs.rmdirSync(dir);
        });
        fs.writeFileSync(cli, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));\n');
        const args = ['install', 'value with spaces', '&|<>', '$HOME', '"quoted"'];
        const planned = yarnCommand(args, { platform: 'win32', executable: cli });
        assert.equal(planned.command, process.execPath);
        assert.equal(planned.shell, false);
        const result = spawnSync(planned.command, planned.args, { shell: planned.shell, encoding: 'utf8' });
        assert.equal(result.status, 0, result.error?.message || result.stderr);
        assert.deepEqual(JSON.parse(result.stdout), args);
    });
}

test('BENCH_KRESUS_YARN selects an exact CLI path without splitting it', (t) => {
    const previous = process.env.BENCH_KRESUS_YARN;
    t.after(() => {
        if (previous === undefined) delete process.env.BENCH_KRESUS_YARN;
        else process.env.BENCH_KRESUS_YARN = previous;
    });
    process.env.BENCH_KRESUS_YARN = 'C:\\local yarn\\bin\\yarn.js';
    const planned = yarnCommand(['--version']);
    assert.deepEqual(planned, {
        command: process.execPath,
        args: ['C:\\local yarn\\bin\\yarn.js', '--version'],
        shell: false,
    });
});

test('Windows prepare stops before creating credentials or starting services', { skip: process.platform !== 'win32' }, (t) => {
    const mkdir = t.mock.method(fs, 'mkdirSync', () => { throw new Error('prepare tried to create state'); });
    const write = t.mock.method(fs, 'writeFileSync', () => { throw new Error('prepare tried to write credentials'); });
    let commands = 0;
    assert.throws(() => kresus.prepare(() => { commands++; }), /native Windows service setup is unsupported.*PostgreSQL 16.*Woob/);
    assert.equal(mkdir.mock.callCount(), 0);
    assert.equal(write.mock.callCount(), 0);
    assert.equal(commands, 0);
});
