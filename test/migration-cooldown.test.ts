import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createIdentityStore } from '../lib/store/identity.ts';

test('migration cooldown remains active until one hour has elapsed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-cooldown-'));
  const store = createIdentityStore(path.join(dir, 'sessions.db'));
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  store.pin('session', 'identity', 'first');
  store.migrate('session', 'identity', 'second', 10_000);
  assert.equal(store.coolingDown('session', 'identity', 10_000 + 3_599_999), true);
  assert.equal(store.coolingDown('session', 'identity', 10_000 + 3_600_000), false);
});
