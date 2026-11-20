// fake-registry.ts — slow-lane 用本地假 npm registry（零依赖单文件，Node ≥22.18）

// 目的：让容器内的 `cpr install` 走真 npm 下载路径（npm install -g --prefix <pkg>@<version>），
// 但 registry 指向本进程，绝不碰外网。宿主侧 npm pack 产物（tgz）经只读 bind-mount 进容器，
// 本进程按 npm registry 协议把 packument + tarball 喂给 npm。

// CLI：node fake-registry.ts --port <p> --tgz <path.tgz> --name <pkg-name>
//   - 只监听 127.0.0.1
//   - GET /<name> 或 /<name(encoded)>   → packument JSON（dist-tags.latest = tgz 内 version）
//   - GET /<name>/-/<basename>.tgz      → tarball 字节
//   - GET /<name>/latest                → 精简 manifest（core /api/version 现查走这条）
//   - 其他 → 404。stderr 每请求一行 [fake-registry] 日志。
//   - tarball 的 shasum(SHA1)/integrity(SHA512) 现算，packument 的 dist 字段如实携带——npm 会校验。

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith('--')) throw new Error(`bad argv: ${key}`);
    out[key.slice(2)] = argv[i + 1];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port);
const TGZ = path.resolve(args.tgz);
const NAME = args.name;
if (!PORT || !fs.existsSync(TGZ) || !NAME) {
  console.error('usage: node fake-registry.ts --port <p> --tgz <path.tgz> --name <pkg-name>');
  process.exit(1);
}
for (const forbidden of [8740, 8741]) {
  if (PORT === forbidden) {
    console.error(`fake-registry: port ${forbidden} 是生产保留口，拒绝`);
    process.exit(1);
  }
}

// 从 tgz 内 package.json 取 version（tar -tzf 现场解出，不引第三方）
const { execFileSync } = await import('node:child_process');
const pkgJson = execFileSync('tar', ['-xOzf', TGZ, 'package/package.json'], { encoding: 'utf8' });
const VERSION = (JSON.parse(pkgJson) as { version: string }).version;

const tarball = fs.readFileSync(TGZ);
const shasum = crypto.createHash('sha1').update(tarball).digest('hex');
const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
const tarballBasename = path.basename(TGZ);

const packument = {
  _id: NAME,
  name: NAME,
  'dist-tags': { latest: VERSION },
  versions: {
    [VERSION]: {
      _id: `${NAME}@${VERSION}`,
      name: NAME,
      version: VERSION,
      engines: (JSON.parse(pkgJson) as { engines?: unknown }).engines ?? {},
      description: (JSON.parse(pkgJson) as { description?: string }).description ?? '',
      bin: (JSON.parse(pkgJson) as { bin?: unknown }).bin ?? {},
      files: (JSON.parse(pkgJson) as { files?: unknown }).files ?? [],
      dist: {
        shasum,
        integrity,
        tarball: `http://127.0.0.1:${PORT}/${NAME}/-/${tarballBasename}`,
      },
    },
  },
};
const latestManifest = { name: NAME, version: VERSION };

let count = 0;
const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = decodeURIComponent(url.pathname);
  console.error(`[fake-registry] #${++count} ${req.method} ${pathname}`);
  const sendJson = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (pathname === `/${NAME}` && req.method === 'GET') return sendJson(200, packument);
  if (pathname === `/${NAME}/latest` && req.method === 'GET') return sendJson(200, latestManifest);
  if (pathname === `/${NAME}/-/${tarballBasename}` && req.method === 'GET') {
    res.writeHead(200, { 'content-type': 'application/x-tar', 'content-length': tarball.length });
    return res.end(tarball);
  }
  return sendJson(404, { error: 'not found' });
});
server.listen(PORT, '127.0.0.1', () => {
  console.error(`[fake-registry] serving ${NAME}@${VERSION} (tgz ${tarball.length}B shasum ${shasum}) on 127.0.0.1:${PORT}`);
});

export {};
