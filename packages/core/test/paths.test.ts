// v0.2.0 路径层：~/.llm-cpr 单目录默认 + CPR_* 接缝 + .env 加载器 + 引擎 DB 兜底落点。
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { configDir, dataDir, defaultDbPath, envFile } from '../src/paths.ts';
import { loadDotEnv } from '../src/envfile.ts';
import { createGatewayServers } from '../src/http/server.ts';

test('paths：默认全部落 ~/.llm-cpr（os.homedir() 口径）', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-paths-home-'));
  const prev = process.env.HOME;
  process.env.HOME = home;
  try {
    const env: NodeJS.ProcessEnv = {};
    assert.equal(configDir(env), path.join(home, '.llm-cpr'));
    assert.equal(dataDir(env), path.join(home, '.llm-cpr'));
    assert.equal(defaultDbPath(env), path.join(home, '.llm-cpr', 'data.db'));
    assert.equal(envFile(env), path.join(home, '.llm-cpr', '.env'));
  } finally {
    if (prev === undefined) delete process.env.HOME;
    else process.env.HOME = prev;
  }
  fs.rmSync(home, { recursive: true, force: true });
});

test('paths：CPR_CONFIG_DIR / CPR_DATA_DIR / CPR_ENV_FILE 接缝优先', () => {
  const env: NodeJS.ProcessEnv = { CPR_CONFIG_DIR: '/cfg', CPR_DATA_DIR: '/data', CPR_ENV_FILE: '/e/.env' };
  assert.equal(configDir(env), '/cfg');
  assert.equal(dataDir(env), '/data');
  assert.equal(defaultDbPath(env), path.join('/data', 'data.db'));
  assert.equal(envFile(env), '/e/.env');
});

test('loadDotEnv：只填缺失键、剥配对引号、跳注释与非法行、文件缺失零动作', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-dotenv-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, [
    '# 注释',
    '',
    'A_KEY=plain',
    'B_KEY="quoted value"',
    "C_KEY='single'",
    'INVALID_LINE_NO_EQ',
    'D_KEY=  spaced  ',
  ].join('\n'));
  const target: NodeJS.ProcessEnv = { A_KEY: 'from-real-env' };
  assert.equal(loadDotEnv(file, target), 3);
  assert.equal(target.A_KEY, 'from-real-env'); // 真实环境变量不被覆盖
  assert.equal(target.B_KEY, 'quoted value');
  assert.equal(target.C_KEY, 'single');
  assert.equal(target.D_KEY, 'spaced');
  assert.equal(loadDotEnv(path.join(dir, 'nope.env'), target), 0);
  // 读不了 ≠ 不存在：路径是目录时原样抛（review P2 修正），不当无事发生吞掉
  assert.throws(() => loadDotEnv(dir, target), /EISDIR/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('引擎无 CPR_DB_FILE 时默认落 CPR_DATA_DIR/data.db，父目录自动创建', async (t: TestContext) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpr-db-default-'));
  const dbDir = path.join(dir, 'nested', 'deeper'); // 故意不预建——SQLite 不自建父目录，引擎负责
  const env: NodeJS.ProcessEnv = { CPR_MASTER: 'master', KEY: 'upstream', CPR_DATA_DIR: dbDir };
  const logger = { log: () => {}, warn: () => {}, error: () => {} };
  const fetchImpl = async (): Promise<Response> => new Response('{}'); // 快照刷新静默失败即可，不影响断言
  const gateway = createGatewayServers({
    master_key_env: 'CPR_MASTER',
    models: [{ id: 'unified', backends: { ocg: 'native' } }],
    backends: [{ name: 'subscription-a', family: 'ocg', account: 'account-a', base_url: 'http://127.0.0.1:1', key_env: 'KEY' }],
  }, { env, logger, fetchImpl });
  gateway.forwardServer.listen(0, '127.0.0.1');
  await once(gateway.forwardServer, 'listening');
  t.after(async () => {
    await new Promise<void>((resolve) => gateway.forwardServer.close(() => resolve()));
    gateway.audit?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.ok(fs.existsSync(path.join(dbDir, 'data.db')), '默认库应落在 CPR_DATA_DIR/data.db 且父目录自动创建');
});
