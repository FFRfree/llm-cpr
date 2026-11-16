export function translateRequest({ config, body, headers, backend, upstreamKey }) {
  const model = config.models.find((entry) => entry.id === body.model);
  if (!model) throw Object.assign(new Error(`model not allowed: ${body.model ?? ''}`), { statusCode: 400 });
  const translatedModel = model.backends[backend.family];
  if (!translatedModel) throw Object.assign(new Error(`model ${model.id} is not available on ${backend.family}`), { statusCode: 400 });
  const translatedHeaders = { ...headers, authorization: `Bearer ${upstreamKey}` };
  if (backend.family === 'ccg') delete translatedHeaders['x-opencode-session'];
  return { body: { ...body, model: translatedModel }, headers: translatedHeaders };
}
