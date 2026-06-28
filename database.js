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

function sortedFriendship(pair = []) {
  return [...pair].sort();
}

function hasModelData(data) {
  return data.users.length || data.friendRequests.length || data.friendships.length || data.messages.length;
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
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      avatar_color TEXT NOT NULL,
      avatar_url TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS friend_requests (
      id TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS friendships (
      user_a_id TEXT NOT NULL,
      user_b_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (user_a_id, user_b_id)
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      from_user_id TEXT NOT NULL,
      to_user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      file_json TEXT,
      created_at TEXT NOT NULL,
      read_at TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status);
  `);

  const selectUsers = db.prepare('SELECT * FROM users ORDER BY created_at ASC');
  const selectRequests = db.prepare('SELECT * FROM friend_requests ORDER BY created_at ASC');
  const selectFriendships = db.prepare('SELECT * FROM friendships ORDER BY created_at ASC');
  const selectMessages = db.prepare('SELECT * FROM messages ORDER BY created_at ASC');
  const selectLegacyState = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_state'");

  const replaceAll = db.transaction(nextData => {
    const data = normalizeData(nextData);
    db.exec('DELETE FROM messages; DELETE FROM friendships; DELETE FROM friend_requests; DELETE FROM users;');

    const insertUser = db.prepare(`
      INSERT INTO users (id, username, display_name, password_hash, avatar_color, avatar_url, created_at)
      VALUES (@id, @username, @displayName, @passwordHash, @avatarColor, @avatarUrl, @createdAt)
    `);
    data.users.forEach(user => insertUser.run({
      ...user,
      avatarUrl: user.avatarUrl || '',
      createdAt: user.createdAt || new Date().toISOString()
    }));

    const insertRequest = db.prepare(`
      INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at, updated_at)
      VALUES (@id, @from, @to, @status, @createdAt, @updatedAt)
    `);
    data.friendRequests.forEach(request => insertRequest.run({
      ...request,
      updatedAt: request.updatedAt || null
    }));

    const insertFriendship = db.prepare(`
      INSERT OR IGNORE INTO friendships (user_a_id, user_b_id, created_at)
      VALUES (?, ?, ?)
    `);
    data.friendships.forEach(pair => {
      const [userA, userB] = sortedFriendship(pair);
      insertFriendship.run(userA, userB, new Date().toISOString());
    });

    const insertMessage = db.prepare(`
      INSERT INTO messages (id, conversation_id, from_user_id, to_user_id, type, text, file_json, created_at, read_at, updated_at)
      VALUES (@id, @conversationId, @from, @to, @type, @text, @fileJson, @createdAt, @readAt, @updatedAt)
    `);
    data.messages.forEach(message => insertMessage.run({
      ...message,
      text: message.text || '',
      fileJson: message.file ? JSON.stringify(message.file) : null,
      readAt: message.readAt || null,
      updatedAt: message.editedAt || message.createdAt || new Date().toISOString()
    }));
  });

  return {
    type: 'sqlite',
    file: sqliteFile,
    async load() {
      const data = normalizeData({
        users: selectUsers.all().map(row => ({
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          passwordHash: row.password_hash,
          avatarColor: row.avatar_color,
          avatarUrl: row.avatar_url || '',
          createdAt: row.created_at
        })),
        friendRequests: selectRequests.all().map(row => ({
          id: row.id,
          from: row.from_user_id,
          to: row.to_user_id,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at || undefined
        })),
        friendships: selectFriendships.all().map(row => [row.user_a_id, row.user_b_id]),
        messages: selectMessages.all().map(row => ({
          id: row.id,
          conversationId: row.conversation_id,
          from: row.from_user_id,
          to: row.to_user_id,
          type: row.type,
          text: row.text || '',
          file: row.file_json ? JSON.parse(row.file_json) : null,
          createdAt: row.created_at,
          readAt: row.read_at || null,
          editedAt: row.updated_at !== row.created_at ? row.updated_at : undefined
        }))
      });
      if (hasModelData(data)) return data;
      if (selectLegacyState.get()) {
        const legacy = db.prepare('SELECT data FROM app_state WHERE id = ?').get('default');
        if (legacy?.data) return normalizeData(JSON.parse(legacy.data));
      }
      return loadLegacyJsonData();
    },
    async save(nextData) {
      replaceAll(nextData);
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
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(191) NOT NULL UNIQUE,
      display_name VARCHAR(255) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      avatar_color VARCHAR(64) NOT NULL,
      avatar_url TEXT,
      created_at VARCHAR(32) NOT NULL
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS friend_requests (
      id VARCHAR(64) PRIMARY KEY,
      from_user_id VARCHAR(64) NOT NULL,
      to_user_id VARCHAR(64) NOT NULL,
      status VARCHAR(32) NOT NULL,
      created_at VARCHAR(32) NOT NULL,
      updated_at VARCHAR(32) NULL,
      INDEX idx_friend_requests_to (to_user_id, status)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS friendships (
      user_a_id VARCHAR(64) NOT NULL,
      user_b_id VARCHAR(64) NOT NULL,
      created_at VARCHAR(32) NOT NULL,
      PRIMARY KEY (user_a_id, user_b_id)
    )
  `);
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS messages (
      id VARCHAR(64) PRIMARY KEY,
      conversation_id VARCHAR(191) NOT NULL,
      from_user_id VARCHAR(64) NOT NULL,
      to_user_id VARCHAR(64) NOT NULL,
      type VARCHAR(32) NOT NULL,
      text TEXT,
      file_json JSON NULL,
      created_at VARCHAR(32) NOT NULL,
      read_at VARCHAR(32) NULL,
      updated_at VARCHAR(32) NOT NULL,
      INDEX idx_messages_conversation (conversation_id, created_at)
    )
  `);

  return {
    type: 'mysql',
    async load() {
      const [users] = await pool.execute('SELECT * FROM users ORDER BY created_at ASC');
      const [requests] = await pool.execute('SELECT * FROM friend_requests ORDER BY created_at ASC');
      const [friendships] = await pool.execute('SELECT * FROM friendships ORDER BY created_at ASC');
      const [messages] = await pool.execute('SELECT * FROM messages ORDER BY created_at ASC');
      const data = normalizeData({
        users: users.map(row => ({
          id: row.id,
          username: row.username,
          displayName: row.display_name,
          passwordHash: row.password_hash,
          avatarColor: row.avatar_color,
          avatarUrl: row.avatar_url || '',
          createdAt: row.created_at
        })),
        friendRequests: requests.map(row => ({
          id: row.id,
          from: row.from_user_id,
          to: row.to_user_id,
          status: row.status,
          createdAt: row.created_at,
          updatedAt: row.updated_at || undefined
        })),
        friendships: friendships.map(row => [row.user_a_id, row.user_b_id]),
        messages: messages.map(row => ({
          id: row.id,
          conversationId: row.conversation_id,
          from: row.from_user_id,
          to: row.to_user_id,
          type: row.type,
          text: row.text || '',
          file: typeof row.file_json === 'string' ? JSON.parse(row.file_json) : row.file_json || null,
          createdAt: row.created_at,
          readAt: row.read_at || null,
          editedAt: row.updated_at && row.updated_at !== row.created_at ? row.updated_at : undefined
        }))
      });
      if (hasModelData(data)) return data;
      const [legacyTables] = await pool.execute("SHOW TABLES LIKE 'app_state'");
      if (legacyTables.length) {
        const [legacyRows] = await pool.execute('SELECT data FROM app_state WHERE id = ?', ['default']);
        if (legacyRows.length) {
          const legacy = typeof legacyRows[0].data === 'string' ? JSON.parse(legacyRows[0].data) : legacyRows[0].data;
          return normalizeData(legacy);
        }
      }
      return loadLegacyJsonData();
    },
    async save(nextData) {
      const data = normalizeData(nextData);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.query('DELETE FROM messages');
        await connection.query('DELETE FROM friendships');
        await connection.query('DELETE FROM friend_requests');
        await connection.query('DELETE FROM users');

        for (const user of data.users) {
          await connection.execute(`
            INSERT INTO users (id, username, display_name, password_hash, avatar_color, avatar_url, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `, [
            user.id,
            user.username,
            user.displayName,
            user.passwordHash,
            user.avatarColor,
            user.avatarUrl || '',
            user.createdAt || new Date().toISOString()
          ]);
        }

        for (const request of data.friendRequests) {
          await connection.execute(`
            INSERT INTO friend_requests (id, from_user_id, to_user_id, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `, [
            request.id,
            request.from,
            request.to,
            request.status,
            request.createdAt,
            request.updatedAt || null
          ]);
        }

        for (const pair of data.friendships) {
          const [userA, userB] = sortedFriendship(pair);
          await connection.execute(`
            INSERT IGNORE INTO friendships (user_a_id, user_b_id, created_at)
            VALUES (?, ?, ?)
          `, [userA, userB, new Date().toISOString()]);
        }

        for (const message of data.messages) {
          await connection.execute(`
            INSERT INTO messages (id, conversation_id, from_user_id, to_user_id, type, text, file_json, created_at, read_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            message.id,
            message.conversationId,
            message.from,
            message.to,
            message.type,
            message.text || '',
            message.file ? JSON.stringify(message.file) : null,
            message.createdAt,
            message.readAt || null,
            message.editedAt || message.createdAt || new Date().toISOString()
          ]);
        }

        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
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
