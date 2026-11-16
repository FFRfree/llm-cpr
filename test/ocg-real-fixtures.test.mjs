import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageSnapshots } from '../lib/snapshots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const status = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'ocg-route-status.json'), 'utf8'));

const ocgBackend = {
  name: 'ocg-main',
  family: 'ocg',
  base_url: 'http://127.0.0.1:8731',
  key_env: 'OPENC_PROXY_MASTER_KEY',
  admin_key_env: 'OPENC_PROXY_MASTER_KEY',
  account: 'ocg-account-sample',
};

test('real OCG route-status account shape parses as a known snapshot', async () => {
  let requestedUrl;
  let requestHeaders;
  const snapshots = new UsageSnapshots({
    backends: [ocgBackend],
    env: { OPENC_PROXY_MASTER_KEY: 'fixture-only' },
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      requestHeaders = options.headers;
      return { ok: true, json: async () => status };
    },
    now: () => 1_000_000,
    logger: { warn: () => {} },
  });

  const out = await snapshots.refresh();
  const value = out.snapshots['ocg-main'];
  const account = status.accounts[0];

  assert.equal(requestedUrl, 'http://127.0.0.1:8731/api/route/status');
  assert.equal(requestHeaders.authorization, 'Bearer fixture-only');
  assert.equal(value.known, true);
  assert.equal(value.degraded, false);
  assert.equal(value.monthlyPercent, account.monthly_percent);
  assert.equal(value.monthProgress, account.month_progress);
  assert.equal(value.periodEnd, account.monthly_resets_at);
  assert.equal(value.fiveHour.used, account.rolling_percent);
  assert.equal(value.fiveHour.resetAt, account.rolling_resets_at);
  assert.equal(value.weekly.used, account.weekly_percent);
  assert.equal(value.weekly.resetAt, account.weekly_resets_at);
  assert.equal(value.fiveHour.exceeded, false);
  assert.equal(value.weekly.exceeded, false);
});
