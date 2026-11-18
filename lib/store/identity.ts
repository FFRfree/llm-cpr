import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { ChatBody, Identity } from '../contracts.ts';

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (content === undefined || content === null) return '';
  try { return JSON.stringify(content) ?? String(content); } catch { return String(content); }
}

export const DEFAULT_IDENTITY_HEADER = 'x-session-id';

export interface IdentityQuery {
  headers?: Record<string, string | string[] | undefined>;
  body?: ChatBody;
  remoteAddress?: string;
  identityHeader?: string;
}

export function resolveIdentity({ headers = {}, body = {}, remoteAddress = 'unknown', identityHeader = DEFAULT_IDENTITY_HEADER }: IdentityQuery = {}): Identity {
  // 主头（默认 x-session-id，业界通用）优先；老客户端直接发 x-opencode-session 也认
  const primary = (identityHeader || DEFAULT_IDENTITY_HEADER).toLowerCase();
  let session = headers[primary];
  if ((typeof session !== 'string' || session.trim().length === 0) && primary !== 'x-opencode-session') {
    session = headers['x-opencode-session'];
  }
  if (typeof session === 'string' && session.trim().length > 0) return { kind: 'session', key: session };

  const messages = body.messages;
  if (Array.isArray(messages)) {
    const entries = messages.filter((message): message is { role?: unknown; content?: unknown } => Boolean(message) && typeof message === 'object');
    const systemMessages = entries.filter((message) => message.role === 'system');
    const firstUser = entries.find((message) => message.role === 'user');
    if (firstUser) {
      const prompt = systemMessages.map((message) => contentText(message.content)).join('\n');
      const user = contentText(firstUser.content);
      const digest = createHash('sha256').update(JSON.stringify([prompt, user])).digest('hex');
      return { kind: 'fingerprint', key: digest };
    }
  }
  return { kind: 'address', key: typeof remoteAddress === 'string' && remoteAddress ? remoteAddress : 'unknown' };
}

export interface RouteMapping {
  backend: string;
  identities: number;
}
export interface IdentityStore {
  get(kind: string, key: string): string | undefined;
  pin(kind: string, key: string, backendName: string): string;
  coolingDown(kind: string, key: string, now?: number, cooldownMs?: number): boolean;
  migrate(kind: string, key: string, backendName: string, now?: number): string | undefined;
  mappingOverview(): RouteMapping[];
  close(): void;
}

// node:sqlite hands back untyped rows; the table shape is fixed by the DDL below.
const backendName = (row: Record<string, unknown> | undefined): string | undefined =>
  typeof row?.backend_name === 'string' ? row.backend_name : undefined;

export function createIdentityStore(filename: string): IdentityStore {
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
  const identityHash = (key: string): string => createHash('sha256').update(String(key)).digest('hex');
  return {
    get(kind, key) { return backendName(select.get(kind, identityHash(key))); },
    pin(kind, key, name) {
      insert.run(kind, identityHash(key), name);
      const pinned = backendName(select.get(kind, identityHash(key)));
      if (pinned === undefined) throw new Error('session pin was not persisted');
      return pinned;
    },
    coolingDown(kind, key, now = Date.now(), cooldownMs = 60 * 60 * 1000) {
      const migratedAt = migrationTime.get(kind, identityHash(key))?.migrated_at;
      return typeof migratedAt === 'number' && Number.isFinite(migratedAt) && now - migratedAt < cooldownMs;
    },
    migrate(kind, key, name, now = Date.now()) {
      const hash = identityHash(key);
      replace.run(name, kind, hash);
      recordMigration.run(kind, hash, now);
      return backendName(select.get(kind, hash));
    },
    mappingOverview() {
      const rows = db.prepare(`SELECT backend_name AS backend, COUNT(*) AS identities FROM session_routes GROUP BY backend_name ORDER BY backend_name`).all();
      return rows as unknown as RouteMapping[];
    },
    close() { db.close(); },
  };
}
