// 泄漏取证扫描器（observability 票 04）：转发路径上对请求正文跑密钥/敏感串规则，
// 命中只回报「规则名 + 命中串的白名单比对结果」——原文与命中片段绝不返回、绝不落库。
// 规则库：自维护最小集（零运行时依赖是仓库铁律；gitleaks 只取其规则「思路」，不取代码）。
// 每条规则按精度分层：known（已知密钥格式，正则直判）与 assignment（变量名赋值形态，
// 过熵值阈值滤掉普通代码常量）。误报兜底三件套：自带 key 精确白名单 + 用户前缀豁免 +
// 同消息同规则进程内去重（见 capture.ts 的接线）。
export type LeakCategory = 'known' | 'assignment';

export interface LeakRule {
  id: string;
  category: LeakCategory;
  pattern: RegExp;
  // assignment 规则取第 1 捕获组做熵值判定；known 规则整串即命中值。
  group?: number;
  // 熵值下限（香农熵，bit/char）：assignment 规则的降噪门槛。
  minEntropy?: number;
  // 最短命中长度（assignment 规则的降噪门槛）。
  minLength?: number;
}

export const LEAK_RULES: LeakRule[] = [
  // ---- known：已知密钥格式（高精度） ----
  { id: 'aws-access-key', category: 'known', pattern: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/ },
  { id: 'github-token', category: 'known', pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  { id: 'gitlab-token', category: 'known', pattern: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: 'slack-token', category: 'known', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'google-api-key', category: 'known', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'openai-style-key', category: 'known', pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'private-key-block', category: 'known', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'jwt', category: 'known', pattern: /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // ---- assignment：赋值形态（变量名敏感 + 值过熵值/长度门槛）----
  { id: 'credential-assignment', category: 'assignment', group: 1, minEntropy: 3.5, minLength: 16,
    pattern: /(?:password|passwd|secret|api[-_]?key|apikey|token|credential)["']?\s*[:=]\s*["']?([A-Za-z0-9_+/=\-.]{16,})/gi },
];

export interface LeakHit {
  rule: string;
  category: LeakCategory;
}

// 香农熵（bit/char）：随机串高、普通词低。扫描器内部临时持有命中片段做白名单比对，
// 返回的 LeakHit 不含任何原文。
function entropy(text: string): number {
  if (!text) return 0;
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// 白名单命中判断：命中串包含任一白名单值（完整 key 或用户前缀）即豁免。
function allowed(candidate: string, allow: readonly string[]): boolean {
  return allow.some((value) => value.length > 0 && candidate.includes(value));
}

export function scanForLeaks(text: string, { allow = [] }: { allow?: readonly string[] } = {}): LeakHit[] {
  const hits: LeakHit[] = [];
  for (const rule of LEAK_RULES) {
    const re = new RegExp(rule.pattern.source, rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`);
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      // assignment 规则：捕获组即候选值，过长度/熵值门槛再判白名单。
      const candidate = match[rule.group ?? 0] ?? match[0];
      if (rule.minLength !== undefined && candidate.length < rule.minLength) continue;
      if (rule.minEntropy !== undefined && entropy(candidate) < rule.minEntropy) continue;
      if (!allowed(candidate, allow)) hits.push({ rule: rule.id, category: rule.category });
      // 零宽风险防御：正则可能匹配空串导致死循环（现规则不会，但护栏便宜）。
      if (match.index === re.lastIndex) re.lastIndex += 1;
    }
  }
  return hits;
}
