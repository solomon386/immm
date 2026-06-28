import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const defaultData = {
  users: [],
  friendRequests: [],
  friendships: [],
  messages: []
};

function normalizeData(data) {
  return { ...structuredClone(defaultData), ...(data || {}) };
}

function loadLegacyJsonData() {
  const legacyFile = path.join(__dirname, 'data.json');
  if (!fs.existsSync(legacyFile)) return structuredClone(defaultData);
  try {
    return normalizeData(JSON.parse(fs.readFileSync(legacyFile, 'utf8')));
  } catch {
    return structuredClone(defaultData);
  }
}

function mysqlConfigFromEnv() {
  if (process.env.DATABASE_URL) {
    return { uri: process.env.DATABASE_URL };
  }
  return {
    host: process.env.MYSQL_HOST || '127.0.0.1',
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || 'root',
    password: process.env.MYSQL_PASSWORD || '',
    database: process.env.MYSQL_DATABASE || 'web_im_chat',
    waitForConnections: true,
    connectionLimit: Number(process.env.MYSQL_CONNECTION_LIMIT || 10)
  };
}

function createMemoryStore() {
  let data = structuredClone(defaultData);
  return {
    type: 'memory',
    async load() {
      return normalizeData(data);
    },
    async save(nextData) {
      data = normalizeData(nextData);
    },
    async close() {}
  };
}

function createSqliteStore() {
  const sqliteFile = process.env.SQLITE_FILE || path.join(__dirname, 'data.sqlite');
  const sqliteDir = path.dirname(sqliteFile);
  if (!fs.existsSync(sqliteDir)) fs.mkdirSync(sqliteDir, { recursive: true });
  const db = new Database(sqliteFile);

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  const selectState = db.prepare('SELECT data FROM app_state WHERE id = ?');
  const upsertState = db.prepare(`
    INSERT INTO app_state (id, data, updated_at)
    VALUES (@id, @data, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET
      data = excluded.data,
      updated_at = excluded.updated_at
  `);

  return {
    type: 'sqlite',
    file: sqliteFile,
    async load() {
      const row = selectState.get('default');
      if (!row) return loadLegacyJsonData();
      return normalizeData(JSON.parse(row.data));
    },
    async save(nextData) {
      upsertState.run({
        id: 'default',
        data: JSON.stringify(normalizeData(nextData)),
        updatedAt: new Date().toISOString()
      });
    },
    async close() {
      db.close();
    }
  };
}

async function createMysqlStore() {
  const config = mysqlConfigFromEnv();
  const pool = config.uri ? mysql.createPool(config.uri) : mysql.createPool(config);

  await pool.execute(`
    CREATE TABLE IF NOT EXISTS app_state (
      id VARCHAR(64) PRIMARY KEY,
      data JSON NOT NULL,
      updated_at DATETIME NOT NULL
    )
  `);

  return {
    type: 'mysql',
    async load() {
      const [rows] = await pool.execute('SELECT data FROM app_state WHERE id = ?', ['default']);
      if (!rows.length) return loadLegacyJsonData();
      const data = typeof rows[0].data === 'string' ? JSON.parse(rows[0].data) : rows[0].data;
      return normalizeData(data);
    },
    async save(nextData) {
      await pool.execute(`
        INSERT INTO app_state (id, data, updated_at)
        VALUES (?, ?, NOW())
        ON DUPLICATE KEY UPDATE
          data = VALUES(data),
          updated_at = VALUES(updated_at)
      `, ['default', JSON.stringify(normalizeData(nextData))]);
    },
    async close() {
      await pool.end();
    }
  };
}

export async function createDataStore(nodeEnv = process.env.NODE_ENV || 'development') {
  if (nodeEnv === 'test') return createMemoryStore();
  if (nodeEnv === 'production') return createMysqlStore();
  return createSqliteStore();
}
