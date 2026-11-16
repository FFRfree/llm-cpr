import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveIdentity, createIdentityStore } from '../lib/identity.mjs';

const request = (headers = {}, body = {}, remoteAddress = '127.0.0.1') => ({ headers, body, remoteAddress });

test('identity resolution prefers session header, then chat fingerprint, then address', () => {
  const withHeader = resolveIdentity(request({ 'x-opencode-session': 'session-1' }, { messages: [{ role: 'user', content: 'hi' }] }));
  assert.equal(withHeader.kind, 'session');
  const fingerprint = resolveIdentity(request({}, { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'hi' }] }));
  assert.equal(fingerprint.kind, 'fingerprint');
  const address = resolveIdentity(request({}, { messages: [] }, '::1'));
  assert.deepEqual(address, { kind: 'address', key: '::1' });
  assert.equal(resolveIdentity(request({ 'x-opencode-session': '' }, {}, 'client')).key, 'client');
});

test('fingerprints are stable for identical system and first user content and change with either', () => {
  const a = { messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' }] };
  const b = { messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'different later reply' }] };
  assert.equal(resolveIdentity(request({}, a)).key, resolveIdentity(request({}, b)).key);
  assert.notEqual(resolveIdentity(request({}, a)).key, resolveIdentity(request({}, { ...a, messages: [{ role: 'system', content: 'changed' }, ...a.messages.slice(1)] })).key);
  assert.notEqual(resolveIdentity(request({}, a)).key, resolveIdentity(request({}, { ...a, messages: [...a.messages.slice(0, 1), { role: 'user', content: 'changed' }] })).key);
  assert.equal(resolveIdentity(request({}, { messages: [{ role: 'user', content: 'x'.repeat(10000) }] })).kind, 'fingerprint');
});

test('identity subscription mapping is immutable and survives reopening the sqlite database', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-identity-'));
  const filename = path.join(dir, 'sessions.db');
  try {
    let store = createIdentityStore(filename);
    assert.equal(store.get('session', 'id-1'), undefined);
    assert.equal(store.pin('session', 'id-1', 'backend-a'), 'backend-a');
    assert.equal(store.pin('session', 'id-1', 'backend-b'), 'backend-a');
    store.close();
    store = createIdentityStore(filename);
    assert.equal(store.get('session', 'id-1'), 'backend-a');
    store.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
