import type { Backend } from '../src/contracts.ts';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../src/policy/config.ts';

const backend = (name: string): Backend => ({ name, family: 'ocg', base_url: 'http://localhost:3000', key_env: 'KEY' });

test('configuration rejects duplicate backend identities before routing starts', () => {
  const config = { backends: [backend('same'), backend('same')], models: [{ id: 'model', backends: { ocg: 'native' } }] };
  assert.throws(() => validateConfig(config), /duplicate backend name/i);
});

test('routing numeric params must be non-negative finite numbers when set', () => {
  const base = { backends: [backend('a')], models: [{ id: 'model', backends: { ocg: 'native' } }] };
  assert.doesNotThrow(() => validateConfig({ ...base, routing: { rebind_cooldown_ms: 60_000, wall_retry_max_attempts: 0, wall_retry_max_after_ms: 2000, long_session_min_requests: 0 } }));
  assert.doesNotThrow(() => validateConfig({ ...base, routing: { migration_cooldown_ms: 60_000 } })); // v0.1.0 旧键别名仍合法
  assert.throws(() => validateConfig({ ...base, routing: { wall_retry_max_attempts: -1 } }), /routing\.wall_retry_max_attempts/);
  assert.throws(() => validateConfig({ ...base, routing: { rebind_cooldown_ms: Number.NaN } }), /routing\.rebind_cooldown_ms/);
  assert.throws(() => validateConfig({ ...base, routing: { migration_cooldown_ms: Number.NaN } }), /routing\.migration_cooldown_ms/);
  assert.throws(() => validateConfig({ ...base, routing: { wall_retry_max_after_ms: '2000' as unknown as number } }), /routing\.wall_retry_max_after_ms/);
  assert.throws(() => validateConfig({ ...base, routing: { long_session_min_requests: Infinity } }), /routing\.long_session_min_requests/);
});
