import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveIdentity } from '../core/store/identity.ts';
import { openDatabase } from '../core/store/db.ts';
import { createSystemEventStore } from '../core/store/events.ts';

const request = (headers: Record<string, string> = {}, body: Record<string, unknown> = {}, remoteAddress: string = '127.0.0.1'): { headers: Record<string, string>; body: Record<string, unknown>; remoteAddress: string } => ({ headers, body, remoteAddress });

test('identity resolution prefers session header, then chat fingerprint, then address', () => {
  const withHeader = resolveIdentity(request({ 'x-session-id': 'session-1' }, { messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(withHeader.kind, 'session');
  const legacyHeader = resolveIdentity(request({ 'x-opencode-session': 'legacy-1' }, { messages: [{ role: 'user', content: 'hi' }] }));
  assert.deepEqual(legacyHeader, { kind: 'session', key: 'legacy-1' });
  const customHeader = resolveIdentity({ ...request({ 'x-my-gateway-session': 'custom-1' }, { messages: [{ role: 'user', content: 'hi' }] }), identityHeader: 'x-my-gateway-session' });
  assert.deepEqual(customHeader, { kind: 'session', key: 'custom-1' });
  const fingerprint = resolveIdentity(request({}, { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }] }));
  assert.equal(fingerprint.kind, 'fingerprint');
  const address = resolveIdentity(request({}, { messages: [] }, '::1'));
  assert.deepEqual(address, { kind: 'address', key: '::1' });
  assert.equal(resolveIdentity(request({ 'x-session-id': '' }, {}, 'client')).key, 'client');
});

test('fingerprints are stable for identical system and first user content and change with either', () => {
  const a = { messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }] };
  const b = { messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'different later reply' }] };
  assert.equal(resolveIdentity(request({}, a)).key, resolveIdentity(request({}, b)).key);
  assert.notEqual(resolveIdentity(request({}, a)).key, resolveIdentity(request({}, { ...a, messages: [{ role: 'system', content: 'changed' }, ...a.messages.slice(1)] })).key);
  assert.notEqual(resolveIdentity(request({}, a)).key, resolveIdentity(request({}, { ...a, messages: [...a.messages.slice(0, 1), { role: 'user', content: 'changed' }] })).key);
  assert.equal(resolveIdentity(request({}, { messages: [{ role: 'user', content: 'x'.repeat(10000) }] })).kind, 'fingerprint');
});

test('affinity is the latest bind/rebind event and survives reopening the sqlite database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-affinity-'));
  const filename = path.join(dir, 'data.db');
  try {
    let store = createSystemEventStore(openDatabase(filename));
    assert.equal(store.affinity('default', 'session', 'id-1'), undefined);
    store.append({ kind: 'route.bind', identity: { kind: 'session', key: 'id-1' }, backendName: 'backend-a', detail: { trigger: 'new-session', source: 'builtin', note: 'monthly-debt' } });
    assert.equal(store.affinity('default', 'session', 'id-1'), 'backend-a');
    store.append({ kind: 'route.rebind', identity: { kind: 'session', key: 'id-1' }, backendName: 'backend-b', detail: { trigger: 'quota-wall', source: 'builtin', note: 'monthly-debt' } });
    assert.equal(store.affinity('default', 'session', 'id-1'), 'backend-b');
    // hold 事件不改变归属
    store.append({ kind: 'route.hold', identity: { kind: 'session', key: 'id-1' }, detail: { cause: 'cooldown', status: 429 } });
    assert.equal(store.affinity('default', 'session', 'id-1'), 'backend-b');
    store = createSystemEventStore(openDatabase(filename));
    assert.equal(store.affinity('default', 'session', 'id-1'), 'backend-b');
    assert.deepEqual(store.mappingOverview(), [{ tenant: 'default', backend: 'backend-b', identities: 1 }]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
