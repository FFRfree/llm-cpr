import type { Backend, QuotaSnapshot } from '../core/contracts.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageSnapshots } from '../core/store/snapshots.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
// Boundary: fixture JSON is untyped.
const status: { accounts: { monthly_percent: number; month_progress: number; monthly_resets_at: string; rolling_percent: number; rolling_resets_at: string; weekly_percent: number; weekly_resets_at: string }[] } = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'ocg-route-status.json'), 'utf8'));

const ocgBackend: Backend = {
  name: 'ocg-main',
  family: 'ocg',
  base_url: 'http://127.0.0.1:8731',
  key_env: 'OPENC_PROXY_MASTER_KEY',
  admin_key_env: 'OPENC_PROXY_MASTER_KEY',
  account: 'ocg-account-sample',
};

test('direct OCG usage parses all windows, sends browser UA, and calculates 30-day month progress', async () => {
  const now = Date.parse('2026-11-16T00:00:00.000Z');
  const resetsAt = new Date(now + 15 * 24 * 60 * 60 * 1000).toISOString();
  let requestedUrl;
  const captured: { headers?: Record<string, string> } = {};
  const snapshots = new UsageSnapshots({
    backends: [{ name: 'ocg-foxmail', family: 'ocg', direct: true, base_url: 'https://opencode.ai/zen/go/v1', key_env: 'OCG_KEY' }],
    env: { OCG_KEY: 'fixture-only' },
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      captured.headers = options?.headers as Record<string, string>;
      return Response.json({ usage: {
        rolling: { percent: 12, resetsAt },
        weekly: { percent: 34, resetsAt },
        monthly: { percent: 56, resetsAt },
      } });
    },
    now: () => now,
    logger: { warn: () => {} },
  });
  const out = await snapshots.refresh();
  const value = out.snapshots['ocg-foxmail'] as QuotaSnapshot & { fiveHour: NonNullable<QuotaSnapshot['fiveHour']>; weekly: NonNullable<QuotaSnapshot['weekly']> };

  assert.equal(requestedUrl, 'https://opencode.ai/zen/go/v1/usage');
  assert.equal((captured.headers as Record<string, string>).authorization, 'Bearer fixture-only');
  assert.ok((captured.headers as Record<string, string>)['user-agent'].includes('Mozilla/'));
  assert.equal(value.known, true);
  assert.equal(value.monthlyPercent, 56);
  assert.equal(value.monthProgress, 50);
  assert.equal(value.fiveHour.used, 12);
  assert.equal(value.weekly.used, 34);
  assert.equal(value.periodEnd, resetsAt);
});

test('direct OCG missing usage data and HTTP failures degrade to unknown snapshots', async () => {
  const direct: Backend = { name: 'ocg', family: 'ocg', direct: true, base_url: 'https://opencode.ai/zen/go/v1', key_env: 'KEY' };
  const incomplete = new UsageSnapshots({ backends: [direct], env: { KEY: 'x' }, fetchImpl: async () => Response.json({ usage: { monthly: { percent: 3 } } }), logger: { warn() {} } });
  await incomplete.refresh();
  assert.equal(incomplete.peek().snapshots.ocg.known, false);
  const failed = new UsageSnapshots({ backends: [direct], env: { KEY: 'x' }, fetchImpl: async () => new Response('', { status: 403 }), logger: { warn() {} } });
  await failed.refresh();
  assert.equal(failed.peek().snapshots.ocg.known, false);
  assert.equal(failed.peek().snapshots.ocg.degraded, true);
});

test('real OCG route-status account shape parses as a known snapshot', async () => {
  let requestedUrl;
  const captured: { headers?: Record<string, string> } = {};
  const snapshots = new UsageSnapshots({
    backends: [ocgBackend],
    env: { OPENC_PROXY_MASTER_KEY: 'fixture-only' },
    fetchImpl: async (url, options) => {
      requestedUrl = url;
      captured.headers = options?.headers as Record<string, string>;
      return { ok: true, json: async () => status } as Response;
    },
    now: () => 1_000_000,
    logger: { warn: () => {} },
  });

  const out = await snapshots.refresh();
  const value = out.snapshots['ocg-main'] as QuotaSnapshot & { fiveHour: NonNullable<QuotaSnapshot['fiveHour']>; weekly: NonNullable<QuotaSnapshot['weekly']> };
  const account = status.accounts[0];

  assert.equal(requestedUrl, 'http://127.0.0.1:8731/api/route/status');
  assert.equal((captured.headers as Record<string, string>).authorization, 'Bearer fixture-only');
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
