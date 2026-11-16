import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../lib/config.mjs';

const backend = (name) => ({ name, family: 'ocg', base_url: 'http://localhost:3000', key_env: 'KEY' });

test('configuration rejects duplicate backend identities before routing starts', () => {
  const config = { backends: [backend('same'), backend('same')], models: [{ id: 'model', backends: { ocg: 'native' } }] };
  assert.throws(() => validateConfig(config), /duplicate backend name/i);
});
