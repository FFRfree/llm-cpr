// pi-driver.ts — e2e 打样驱动：锁版本安装 pi coding agent 并无头驱动它走 llm-cpr 推理口。
// 约束：不 import 仓内代码；不读写 ~/.llm-cpr / ~/.hermes / ~/.config；HOME 重定向到调用方给的 homeDir。
//
// 现查结论（npm view，2026-11）：
//   CLI 包名 = @mariozechner/pi-coding-agent（bin 名 pi）。文档线索里的 @mariozechner/pi 是另一个包
//   （vLLM pods 管理工具，bin pi-pods），千万别装错。
//   models.json 契约（docs/models.md）：~/.pi/agent/models.json，providers.<name>.{baseUrl, api, apiKey,
//   headers, models[]}；headers 支持字面量值 → 用来带 x-session-id；api 用 openai-completions；baseUrl 必须 /v1 结尾。
//   无头运行：pi --print --mode json <prompt>，stdout 每行一个 JSON 事件（docs/json.md）；
//   最后一条 assistant 的 message_end.content[].text 拼接即 finalText。
//   首次运行真实跑通的坑：--provider 必须指到 models.json 里的自定义 provider 名（默认 google 不会用我们
//   的 baseUrl）；--offline 防启动期联网检查；cwd 需要 git 仓（本驱动自动 git init）。
import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 锁定的包与版本（后续复用已装好的 pi-vendor，不再升级）。 */
export const PI_PACKAGE = '@mariozechner/pi-coding-agent';
export const PI_VERSION = '0.73.1';
export const PI_BIN = 'pi';

/** 与 cpr-instance.ts 约定一致的鉴权字面量与模型 id。 */
export const E2E_MASTER_KEY = 'e2e-test-key';
export const E2E_IDENTITY_HEADER = 'x-session-id';

export interface PiVendor {
  /** pi 可执行文件绝对路径（<vendorDir>/node_modules/.bin/pi）。 */
  binPath: string;
  /** 锁定版本号。 */
  version: string;
}

/** 安装/复用 pi。vendorDir 调用方持有（e2e 批次目录下）。已装且版本一致则直接复用。 */
export async function ensurePiVendor(vendorDir: string): Promise<PiVendor> {
  await fs.promises.mkdir(vendorDir, { recursive: true });
  const pkgJson = path.join(vendorDir, 'node_modules', PI_PACKAGE, 'package.json');
  let installed: { version?: string } | null = null;
  try { installed = JSON.parse(await fs.promises.readFile(pkgJson, 'utf8')) as { version?: string }; } catch { /* 未安装 */ }
  if (installed?.version !== PI_VERSION) {
    // 先清掉旧版本再装锁定版，保证幂等。
    await fs.promises.rm(path.join(vendorDir, 'node_modules', PI_PACKAGE), { recursive: true, force: true });
    await execFileAsync('npm', ['install', '--prefix', vendorDir, `${PI_PACKAGE}@${PI_VERSION}`], { timeout: 300_000 });
    installed = JSON.parse(await fs.promises.readFile(pkgJson, 'utf8')) as { version?: string };
  }
  const binPath = path.join(vendorDir, 'node_modules', '.bin', PI_BIN);
  if (!fs.existsSync(binPath)) throw new Error(`pi bin 不存在：${binPath}（包 ${PI_PACKAGE}@${installed?.version}）`);
  return { binPath, version: installed.version ?? PI_VERSION };
}

export interface PiRunOptions {
  /** llm-cpr 推理口端口（models.json baseUrl 指向 http://127.0.0.1:<inferPort>/v1）。 */
  inferPort: number;
  /** 请求的模型 id（必须等于 llm-cpr policy.ts 声明的 models[].id）。 */
  model: string;
  /** 会话头 x-session-id 的值（llm-cpr 按它做会话亲和）。 */
  sessionId: string;
  /** 单条用户 prompt（以 '-' 开头时本驱动前置一个空格防被当 flag）。 */
  prompt: string;
  /** pi 的工作目录（本驱动会先 git init——pi 要求 git 仓）。 */
  cwd: string;
  /** HOME 重定向目录（pi 一切 ~/.pi 状态都隔离在这里；本驱动写 homeDir/.pi/agent/models.json）。 */
  homeDir: string;
  /** 超时毫秒（默认 120_000，超时 SIGKILL）。 */
  timeoutMs?: number;
  /** pi provider 名（models.json 里的 key；默认 e2e-cpr）。 */
  provider?: string;
}

export interface PiRunResult {
  exitCode: number | null;
  /** stdout 逐行解析出的 JSON 事件（含首行 session header；非 JSON 行跳过并记入 rawLines）。 */
  events: Record<string, unknown>[];
  /** stdout 原始行（JSONL 字符串数组，便于回放/断言）。 */
  rawLines: string[];
  /** 最后一条 assistant 消息的文本拼接（message_end 事件，role=assistant，content[].type==='text'）。 */
  finalText: string;
  /** stderr 原文（pi 把部分诊断写这里）。 */
  stderr: string;
  /** 超时被杀时为 true。 */
  timedOut: boolean;
}

function renderModelsJson(inferPort: number, model: string, sessionId: string, provider: string): string {
  return JSON.stringify({
    providers: {
      [provider]: {
        baseUrl: `http://127.0.0.1:${inferPort}/v1`,
        api: 'openai-completions',
        apiKey: E2E_MASTER_KEY,
        headers: { [E2E_IDENTITY_HEADER]: sessionId },
        models: [
          { id: model, name: model, reasoning: false, input: ['text'], contextWindow: 128_000, maxTokens: 4_096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
        ],
      },
    },
  }, null, 2);
}

/** 无头跑一次 pi。cwd/homeDir 都由调用方持有（e2e 归属目录）；HOME 只在此进程内重定向。 */
export async function runPi(options: PiRunOptions): Promise<PiRunResult> {
  const { inferPort, model, sessionId, prompt, cwd, homeDir } = options;
  const provider = options.provider ?? 'e2e-cpr';
  const vendorDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'pi-vendor');
  const { binPath } = await ensurePiVendor(vendorDir);

  // HOME 隔离：pi 读 ~/.pi/agent/models.json（docs/models.md）。
  await fs.promises.mkdir(path.join(homeDir, '.pi', 'agent'), { recursive: true });
  await fs.promises.writeFile(path.join(homeDir, '.pi', 'agent', 'models.json'), renderModelsJson(inferPort, model, sessionId, provider), 'utf8');

  // pi 要求工作目录是 git 仓（未初始化则 init，已存在则静默跳过）。
  await fs.promises.mkdir(cwd, { recursive: true });
  try { await execFileAsync('git', ['init', '-q'], { cwd, timeout: 15_000 }); } catch { /* 已是 git 仓即可 */ }

  const promptArg = prompt.startsWith('-') ? ` ${prompt}` : prompt;
  const args = ['--print', '--mode', 'json', '--provider', provider, '--model', model, '--offline', '--no-session', promptArg];
  const child = spawn(binPath, args, {
    cwd,
    env: { ...process.env, HOME: homeDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const rawLines: string[] = [];
  const events: Record<string, unknown>[] = [];
  let stderrBuf = '';
  let timedOut = false;
  child.stdout!.on('data', (chunk: Buffer) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      rawLines.push(line);
      try { events.push(JSON.parse(line) as Record<string, unknown>); } catch { /* 非 JSON 行忽略 */ }
    }
  });
  child.stderr!.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString('utf8'); });

  const timeoutMs = options.timeoutMs ?? 120_000;
  const spawnFailed = new Promise<never>((_resolve, reject) => {
    child.once('error', (error) => reject(new Error(`pi 进程启动失败：${(error as NodeJS.ErrnoException).message}`)));
  });
  const exitCode = await Promise.race([
    new Promise<number | null>((resolve) => {
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
    }),
    spawnFailed,
  ]);

  // finalText：最后一条 assistant 的 message_end，拼 content[].text。
  let finalText = '';
  for (const event of events) {
    if (event.type !== 'message_end') continue;
    const message = event.message as { role?: string; content?: { type?: string; text?: string }[] } | undefined;
    if (message?.role !== 'assistant') continue;
    finalText = (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
  }
  return { exitCode, events, rawLines, finalText, stderr: stderrBuf, timedOut };
}
