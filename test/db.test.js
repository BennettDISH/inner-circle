// The pg Pool on its own, outside the running app.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Run an ES module snippet in a fresh Node process from the repo root. */
function runModule(source) {
  return new Promise((resolve, reject) => {
    // No DATABASE_URL: the Pool only connects on its first query, and this never sends one.
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: root,
      env: { PATH: process.env.PATH },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, out }));
  });
}

describe('database pool', () => {
  it('an error on an idle connection is logged and the process keeps running', async () => {
    // pg emits 'error' on the pool when an idle client's connection drops (a database restart,
    // a network blip). With no listener Node treats it as uncaught and the server exits.
    const { code, out } = await runModule(`
      import pool from './config/db.js';
      setTimeout(() => pool.emit('error', new Error('Connection terminated unexpectedly')));
      setTimeout(() => { console.log('still running'); process.exit(0); }, 200);
    `);
    assert.equal(code, 0, out);
    assert.match(out, /Postgres idle client error: Connection terminated unexpectedly/);
    assert.match(out, /still running/);
  });
});
