import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

export const DEFAULT_IDENTITY_HEADER = 'x-session-id';

export function resolveIdentity({ headers = {}, body = {}, remoteAddress = 'unknown', identityHeader = DEFAULT_IDENTITY_HEADER }) {
  // 主头（默认 x-session-id，业界通用）优先；老客户端直接发 x-opencode-session 也认
  const primary = (identityHeader || DEFAULT_IDENTITY_HEADER).toLowerCase();
  let session = headers[primary];
  if ((typeof session !== 'string' || session.trim().length === 0) && primary !== 'x-opencode-session') {
    session = headers['x-opencode-session'];
  }
  if (typeof session === 'string' && session.trim().length > 0) return { kind: 'session', key: session };

  if (Array.isArray(body.messages)) {
    const systemMessages = body.messages.filter((message) => message && message.role === 'system');
    const firstUser = body.messages.find((message) => message && message.role === 'user');
    if (firstUser) {
      const prompt = systemMessages.map((message) => contentText(message.content)).join('\n');
      const user = contentText(firstUser.content);
      const digest = createHash('sha256').update(JSON.stringify([prompt, user])).digest('hex');
      return { kind: 'fingerprint', key: digest };
    }
  }
  return { kind: 'address', key: typeof remoteAddress === 'string' && remoteAddress ? remoteAddress : 'unknown' };
}

export function createIdentityStore(filename) {
  const db = new DatabaseSync(filename);
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_routes (
      identity_kind TEXT NOT NULL,
      identity_hash TEXT NOT NULL,
      backend_name TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (identity_kind, identity_hash)
    )
  `);
  const select = db.prepare('SELECT backend_name FROM session_routes WHERE identity_kind = ? AND identity_hash = ?');
  db.exec(`CREATE TABLE IF NOT EXISTS identity_migrations (
    identity_kind TEXT NOT NULL,
    identity_hash TEXT NOT NULL,
    migrated_at INTEGER NOT NULL,
    PRIMARY KEY (identity_kind, identity_hash)
  )`);
  const insert = db.prepare('INSERT OR IGNORE INTO session_routes (identity_kind, identity_hash, backend_name) VALUES (?, ?, ?)');
  const replace = db.prepare('UPDATE session_routes SET backend_name = ? WHERE identity_kind = ? AND identity_hash = ?');
  const migrationTime = db.prepare('SELECT migrated_at FROM identity_migrations WHERE identity_kind = ? AND identity_hash = ?');
  const recordMigration = db.prepare(`INSERT INTO identity_migrations (identity_kind, identity_hash, migrated_at) VALUES (?, ?, ?)
    ON CONFLICT(identity_kind, identity_hash) DO UPDATE SET migrated_at = excluded.migrated_at`);
  const identityHash = (key) => createHash('sha256').update(String(key)).digest('hex');
  return {
    get(kind, key) { return select.get(kind, identityHash(key))?.backend_name; },
    pin(kind, key, backendName) {
      insert.run(kind, identityHash(key), backendName);
      return select.get(kind, identityHash(key)).backend_name;
    },
    coolingDown(kind, key, now = Date.now(), cooldownMs = 60 * 60 * 1000) {
      const migratedAt = migrationTime.get(kind, identityHash(key))?.migrated_at;
      return Number.isFinite(migratedAt) && now - migratedAt < cooldownMs;
    },
    migrate(kind, key, backendName, now = Date.now()) {
      const hash = identityHash(key);
      replace.run(backendName, kind, hash);
      recordMigration.run(kind, hash, now);
      return select.get(kind, hash)?.backend_name;
    },
    mappingOverview() {
      return db.prepare(`SELECT backend_name AS backend, COUNT(*) AS identities FROM session_routes GROUP BY backend_name ORDER BY backend_name`).all();
    },
    close() { db.close(); },
  };
}
