export function translateRequest({ config, body, headers, backend, upstreamKey, identityHeader = config?.identityHeader || 'x-coding-plan-session' }) {
  const model = config.models.find((entry) => entry.id === body.model);
  if (!model) throw Object.assign(new Error(`model not allowed: ${body.model ?? ''}`), { statusCode: 400 });
  const translatedModel = model.backends[backend.family];
  if (!translatedModel) throw Object.assign(new Error(`model ${model.id} is not available on ${backend.family}`), { statusCode: 400 });
  const translatedHeaders = { ...headers, authorization: `Bearer ${upstreamKey}` };
  // 会话头翻译：客户端只认识统一头名（默认 x-coding-plan-session，与 opencode 解耦）。
  // ocg 家族 → 重写为下游 OpenCode 强制要求的 x-opencode-session；ccg 家族 → 剥除。
  // 兼容：直接带 x-opencode-session 的老客户端在 ocg 家族上原样透传，在 ccg 上剥除。
  const sessionKey = (identityHeader || 'x-coding-plan-session').toLowerCase();
  const sessionValue = translatedHeaders[sessionKey];
  delete translatedHeaders[sessionKey];
  if (backend.family === 'ccg') {
    delete translatedHeaders['x-opencode-session'];
  } else if (sessionValue !== undefined) {
    translatedHeaders['x-opencode-session'] = sessionValue;
  }
  return { body: { ...body, model: translatedModel }, headers: translatedHeaders };
}
