// 极简 .env 加载器（零依赖，systemd EnvironmentFile 之外的前台运行也能拿到密钥）：
// - 只填目标 env 里尚不存在的键，绝不覆盖真实环境变量；
// - 跳过空行与 # 注释；KEY=VALUE 之外的行容忍跳过（.env 是用户手编文件，不因一行小错拒启动）；
// - 值整体剥首尾配对引号，不做变量展开等魔法。
import fs from 'node:fs';

export function loadDotEnv(file: string, target: NodeJS.ProcessEnv = process.env): number {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    // 只有「文件不存在」是无事发生；存在但读不出来（路径是目录、权限等）原样抛——
    // 静默吞掉等于用户配错了 .env 却毫无提示（review P2 修正）。
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return 0;
    throw error;
  }
  let loaded = 0;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1);
    }
    if (target[key] === undefined) {
      target[key] = value;
      loaded += 1;
    }
  }
  return loaded;
}
