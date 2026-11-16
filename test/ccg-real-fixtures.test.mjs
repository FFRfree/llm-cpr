import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageSnapshots } from '../lib/snapshots.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, 'fixtures', name), 'utf8'));

const ccgBackend = {
  name: 'ccg-main',
  family: 'ccg',
  base_url: 'https://api.commandcode.ai/provider/v1',
  key_env: 'COMMANDCODE_API_KEY',
};

function stubFetch({ credits, usage, subscriptions }) {
  return async (url) => {
    if (url.endsWith('/billing/credits')) return { ok: true, json: async () => credits };
    if (url.endsWith('/usage/summary')) return { ok: true, json: async () => usage };
    if (url.endsWith('/billing/subscriptions')) return { ok: true, json: async () => subscriptions };
    throw new Error(`unexpected url: ${url}`);
  };
}

test('real CCG /alpha sample shapes parse into a known snapshot', async () => {
  const credits = fixture('ccg-credits.json');
  const usage = fixture('ccg-usage-summary.json');
  const subscriptions = fixture('ccg-subscriptions.json');
  const snap = new UsageSnapshots({
    backends: [ccgBackend], fetchImpl: stubFetch({ credits, usage, subscriptions }),
    now: () => 1_000_000, intervalMs: 60_000, logger: { warn: () => {} },
  });
  const out = await snap.refresh();
  const value = out.snapshots['ccg-main'];

  assert.equal(value.known, true);
  assert.equal(value.degraded, false);

  const remaining = credits.credits.monthlyCredits;
  const spent = usage.totalCost;
  assert.ok(Math.abs(value.monthlyRemaining - remaining) < 1e-6);
  assert.ok(Math.abs(value.monthlySpent - spent) < 1e-6);
  assert.ok(Math.abs(value.monthlyCap - (remaining + spent)) < 1e-6);
  assert.ok(value.monthlyPercent > 0 && value.monthlyPercent < 100);

  assert.equal(value.fiveHour.used, credits.windowLimits.fiveHour.used);
  assert.equal(value.fiveHour.cap, credits.windowLimits.fiveHour.cap);
  assert.equal(value.fiveHour.exceeded, false);
  assert.equal(value.weekly.used, credits.windowLimits.weekly.used);
  assert.equal(value.weekly.cap, credits.windowLimits.weekly.cap);
  // resetAt 是 epoch 毫秒，直接透传
  assert.equal(value.fiveHour.resetAt, credits.windowLimits.fiveHour.resetAt);

  // 真实 /alpha/billing/subscriptions 把字段包在 data 里
  assert.equal(value.periodStart, subscriptions.data.currentPeriodStart);
  assert.equal(value.periodEnd, subscriptions.data.currentPeriodEnd);
});

test('CCG sample with missing summary fields degrades instead of crashing', async () => {
  const credits = fixture('ccg-credits.json');
  const snap = new UsageSnapshots({
    backends: [ccgBackend],
    fetchImpl: stubFetch({ credits, usage: {}, subscriptions: {} }),
    now: () => 1_000_000, intervalMs: 60_000, logger: { warn: () => {} },
  });
  const out = await snap.refresh();
  const value = out.snapshots['ccg-main'];
  assert.equal(value.known, false);
  assert.equal(value.degraded, true);
  // 部分字段（窗口数据）仍可用，不因月度字段缺失而全废
  assert.equal(value.fiveHour.cap, credits.windowLimits.fiveHour.cap);
});
