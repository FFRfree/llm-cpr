import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase } from '../lib/store/db.ts';
import { createSystemEventStore } from '../lib/store/events.ts';

test('rebind cooldown remains active until one hour has elapsed; first bind does not arm it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-cooldown-'));
  const store = createSystemEventStore(openDatabase(path.join(dir, 'data.db')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  store.append({ kind: 'route.bind', identity: { kind: 'session', key: 'identity' }, backendName: 'first' });
  // 首绑不算改绑：新会话不得自带一小时改绑锁
  assert.equal(store.coolingDown('default', 'session', 'identity', 10_000 + 3_599_999), false);
  store.append({ kind: 'route.rebind', identity: { kind: 'session', key: 'identity' }, backendName: 'second', ts: 10_000, detail: { trigger: 'quota-wall', source: 'builtin' } });
  assert.equal(store.coolingDown('default', 'session', 'identity', 10_000 + 3_599_999), true);
  assert.equal(store.coolingDown('default', 'session', 'identity', 10_000 + 3_600_000), false);
});
