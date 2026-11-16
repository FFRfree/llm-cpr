import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

function contentText(content) {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  try { return JSON.stringify(content); } catch { return String(content); }
}

export function resolveIdentity({ headers = {}, body = {}, remoteAddress = 'unknown' }) {
  const session = headers['x-opencode-session'];
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
  const insert = db.prepare('INSERT OR IGNORE INTO session_routes (identity_kind, identity_hash, backend_name) VALUES (?, ?, ?)');
  const identityHash = (key) => createHash('sha256').update(String(key)).digest('hex');
  return {
    get(kind, key) { return select.get(kind, identityHash(key))?.backend_name; },
    pin(kind, key, backendName) {
      insert.run(kind, identityHash(key), backendName);
      return select.get(kind, identityHash(key)).backend_name;
    },
    close() { db.close(); },
  };
}
