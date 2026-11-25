import { DatabaseSync } from 'node:sqlite';

export const legacyOwnerId = 'pulsewatch-legacy';
export const legacyEmail = 'legacy@pulsewatch.invalid';

const migration1 = `
  CREATE TABLE monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY,
    monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('up', 'down')),
    http_status INTEGER,
    response_ms INTEGER,
    error TEXT,
    checked_at INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX checks_monitor_time ON checks(monitor_id, checked_at DESC, id DESC);
  CREATE INDEX checks_time ON checks(checked_at);
`;

// Better Auth 1.7 core SQLite schema. Keep its columns in sync when upgrading the library.
const authSchema = `
  CREATE TABLE "user" (
    "id" TEXT NOT NULL PRIMARY KEY, "name" TEXT NOT NULL, "email" TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NOT NULL, "image" TEXT, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL
  );
  CREATE TABLE "session" (
    "id" TEXT NOT NULL PRIMARY KEY, "expiresAt" DATE NOT NULL, "token" TEXT NOT NULL UNIQUE,
    "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL, "ipAddress" TEXT, "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
  );
  CREATE TABLE "account" (
    "id" TEXT NOT NULL PRIMARY KEY, "accountId" TEXT NOT NULL, "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user"("id") ON DELETE CASCADE, "accessToken" TEXT,
    "refreshToken" TEXT, "idToken" TEXT, "accessTokenExpiresAt" DATE, "refreshTokenExpiresAt" DATE,
    "scope" TEXT, "password" TEXT, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL
  );
  CREATE TABLE "verification" (
    "id" TEXT NOT NULL PRIMARY KEY, "identifier" TEXT NOT NULL, "value" TEXT NOT NULL,
    "expiresAt" DATE NOT NULL, "createdAt" DATE NOT NULL, "updatedAt" DATE NOT NULL
  );
  CREATE INDEX "session_userId_idx" ON "session"("userId");
  CREATE INDEX "account_userId_idx" ON "account"("userId");
  CREATE INDEX "verification_identifier_idx" ON "verification"("identifier");
`;

function migrateOwnership(db: DatabaseSync) {
  db.exec(authSchema);
  const now = new Date().toISOString();
  db.prepare(`INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES (?, 'Dados legados', ?, 0, ?, ?)`).run(legacyOwnerId, legacyEmail, now, now);

  db.exec(`
    ALTER TABLE monitors RENAME TO monitors_v1;
    ALTER TABLE checks RENAME TO checks_v1;
    CREATE TABLE monitors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE RESTRICT,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(owner_id, url)
    ) STRICT;
    CREATE TABLE checks (
      id INTEGER PRIMARY KEY,
      monitor_id INTEGER NOT NULL REFERENCES monitors(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK (status IN ('up', 'down')),
      http_status INTEGER,
      response_ms INTEGER,
      error TEXT,
      checked_at INTEGER NOT NULL
    ) STRICT;
  `);
  db.prepare(`INSERT INTO monitors (id, owner_id, name, url, created_at)
    SELECT id, ?, name, url, created_at FROM monitors_v1`).run(legacyOwnerId);
  db.exec(`
    INSERT INTO checks SELECT * FROM checks_v1;
    INSERT INTO sqlite_sequence (name, seq)
      SELECT 'monitors', 0 WHERE NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'monitors');
    UPDATE sqlite_sequence SET seq = MAX(seq, COALESCE((SELECT seq FROM sqlite_sequence WHERE name = 'monitors_v1'), 0))
      WHERE name = 'monitors';
    DROP TABLE checks_v1;
    DROP TABLE monitors_v1;
    CREATE INDEX checks_monitor_time ON checks(monitor_id, checked_at DESC, id DESC);
    CREATE INDEX monitors_owner_created ON monitors(owner_id, created_at DESC, id DESC);
  `);
}

const authRateLimitSchema = `CREATE TABLE "rateLimit" (
  id TEXT NOT NULL PRIMARY KEY, "key" TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, "lastRequest" BIGINT NOT NULL
);`;

export function connectDatabase(path: string) {
  return new DatabaseSync(path, { timeout: 1500, enableForeignKeyConstraints: true });
}

export function openDatabase(path: string) {
  const db = connectDatabase(path);
  try {
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('BEGIN IMMEDIATE');
    try {
      const version = db.prepare('PRAGMA user_version').get()?.user_version;
      if (version !== 0 && version !== 1 && version !== 2 && version !== 3) throw new Error(`Versão do banco incompatível: ${version}`);
      if (version === 0) db.exec(migration1);
      if (version === 0 || version === 1) migrateOwnership(db);
      if (version !== 3) {
        db.exec(authRateLimitSchema);
        db.exec('PRAGMA user_version = 3');
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function claimLegacy(db: DatabaseSync, email: string) {
  const user = db.prepare(`SELECT u.id FROM "user" u WHERE u.email = ? AND u.id <> ?
    AND EXISTS (SELECT 1 FROM "account" a WHERE a."userId" = u.id AND a."providerId" = 'credential' AND a.password IS NOT NULL)`)
    .get(email.trim().toLowerCase(), legacyOwnerId);
  if (typeof user?.id !== 'string') throw new Error('Cadastre a conta de destino antes de transferir os monitores.');
  try {
    // A single UPDATE transfers the monitors atomically. The check foreign keys retain the same IDs.
    return db.prepare('UPDATE monitors SET owner_id = ? WHERE owner_id = ?').run(user.id, legacyOwnerId).changes;
  } catch (error) {
    if ((error as { errcode?: number }).errcode === 2067) {
      throw new Error('A conta de destino já tem uma URL legada cadastrada. Resolva a duplicidade e tente novamente.');
    }
    throw error;
  }
}
