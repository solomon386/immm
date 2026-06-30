import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';
import { createClient } from 'redis';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const defaultData = {
  users: [],
  friendRequests: [],
  friendships: [],
  groups: [],
  messages: []
};

function normalizeData(data) {
  return { ...structuredClone(defaultData), ...(data || {}) };
}

function sortedFriendship(pair = []) {
  return [...pair].sort();
}

function hasModelData(data) {
  return data.users.length || data.friendRequests.length || data.friendships.length || data.groups.length || data.messages.length;
}

function hasSqlModelData(data) {
  return data.users.length || data.friendRequests.length || data.friendships.length || data.groups.length;
}

function dataSummary(data) {
  return {
    users: data.users?.length || 0,
    friendRequests: data.friendRequests?.length || 0,
    friendships: data.friendships?.length || 0,
    groups: data.groups?.length || 0,
    messages: data.messages?.length || 0
  };
}

function messageRetentionSeconds() {
  if (process.env.MESSAGE_RETENTION_SECONDS) {
    return Number(process.env.MESSAGE_RETENTION_SECONDS);
  }
  return process.env.NODE_ENV === 'production' ? 24 * 60 * 60 : 60;
}

function redisUrl() {
  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

function redisPrefix() {
  return process.env.REDIS_KEY_PREFIX || 'im';
}

function removeMediaFileByUrl(url) {
  if (!url?.startsWith('/uploads/')) return false;
  const uploadsDir = path.join(__dirname, 'uploads');
  const filename = path.basename(url);
  const filePath = path.join(uploadsDir, filename);
  if (!filePath.startsWith(uploadsDir) || !fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
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

function publicMysqlConfig(config) {
  if (config.uri) return { uri: '[DATABASE_URL 已配置，内容已隐藏]' };
  return {
    host: config.host,
    port: config.port,
    user: config.user,
    database: config.database,
    connectionLimit: config.connectionLimit
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
    async cleanupExpiredMediaFiles() {
      return { checked: 0, deleted: 0 };
    },
    async close() {}
  };
}

async function createRedisMessageStore() {
  const prefix = redisPrefix();
  const retentionSeconds = messageRetentionSeconds();
  const retentionMs = retentionSeconds * 1000;
  const client = createClient({ url: redisUrl() });
  client.on('error', error => {
    console.error('[redis] 连接或执行失败', error.message);
  });
  await client.connect();

  const globalIndexKey = `${prefix}:messages:index`;
  const mediaIndexKey = `${prefix}:messages:media:index`;
  const mediaMetaKey = `${prefix}:messages:media:meta`;
  const dataKey = messageId => `${prefix}:messages:data:${messageId}`;
  const conversationKey = conversationId => `${prefix}:messages:conversation:${conversationId}`;

  function mediaMeta(message) {
    if (!message?.file?.url || message.type === 'text') return null;
    return JSON.stringify({
      id: message.id,
      url: message.file.url,
      type: message.type,
      conversationId: message.conversationId,
      createdAt: message.createdAt
    });
  }

  async function removeMessageFromIndexes(messageId, message) {
    await client.zRem(globalIndexKey, messageId);
    await client.zRem(mediaIndexKey, messageId);
    await client.hDel(mediaMetaKey, messageId);
    if (message?.conversationId) {
      await client.zRem(conversationKey(message.conversationId), messageId);
    }
    await client.del(dataKey(messageId));
  }

  async function cleanupExpiredIndexEntries() {
    const minAliveScore = Date.now() - retentionMs;
    await client.zRemRangeByScore(globalIndexKey, 0, minAliveScore);
  }

  return {
    type: 'redis',
    retentionSeconds,
    async load() {
      await cleanupExpiredIndexEntries();
      const ids = await client.zRange(globalIndexKey, 0, -1);
      if (!ids.length) return [];
      const values = await client.mGet(ids.map(dataKey));
      const messages = [];
      const staleIds = [];

      values.forEach((value, index) => {
        if (!value) {
          staleIds.push(ids[index]);
          return;
        }
        messages.push(JSON.parse(value));
      });

      if (staleIds.length) {
        await client.zRem(globalIndexKey, staleIds);
      }
      return messages.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    },
    async save(nextMessages = []) {
      await cleanupExpiredIndexEntries();
      const now = Date.now();
      const currentIds = await client.zRange(globalIndexKey, 0, -1);
      const nextById = new Map(nextMessages.map(message => [message.id, message]));

      for (const messageId of currentIds) {
        if (nextById.has(messageId)) continue;
        const raw = await client.get(dataKey(messageId));
        await removeMessageFromIndexes(messageId, raw ? JSON.parse(raw) : null);
      }

      for (const message of nextMessages) {
        const createdAtMs = Date.parse(message.createdAt);
        if (!Number.isFinite(createdAtMs)) continue;
        const expiresAtMs = createdAtMs + retentionMs;
        if (expiresAtMs <= now) {
          await removeMessageFromIndexes(message.id, message);
          continue;
        }

        await client.set(dataKey(message.id), JSON.stringify(message), { PXAT: expiresAtMs });
        await client.zAdd(globalIndexKey, [{ score: createdAtMs, value: message.id }]);
        await client.zAdd(conversationKey(message.conversationId), [{ score: createdAtMs, value: message.id }]);
        const meta = mediaMeta(message);
        if (meta) {
          await client.hSet(mediaMetaKey, message.id, meta);
          await client.zAdd(mediaIndexKey, [{ score: expiresAtMs, value: message.id }]);
        } else {
          await client.hDel(mediaMetaKey, message.id);
          await client.zRem(mediaIndexKey, message.id);
        }
        await client.expire(conversationKey(message.conversationId), retentionSeconds + 3600);
      }
    },
    async cleanupExpiredMediaFiles(now = Date.now()) {
      const expiredIds = await client.zRangeByScore(mediaIndexKey, 0, now);
      if (!expiredIds.length) return { checked: 0, deleted: 0 };

      const metas = await Promise.all(expiredIds.map(messageId => client.hGet(mediaMetaKey, messageId)));
      let deleted = 0;
      for (const meta of metas) {
        if (!meta) continue;
        const payload = JSON.parse(meta);
        if (removeMediaFileByUrl(payload.url)) deleted += 1;
      }

      await Promise.all(expiredIds.map(messageId => client.zRem(mediaIndexKey, messageId)));
      await Promise.all(expiredIds.map(messageId => client.hDel(mediaMetaKey, messageId)));
      return { checked: expiredIds.length, deleted };
    },
    async close() {
      await client.quit();
    }
  };
}

function loadLegacySqliteMessages(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
  if (!table) return [];
  return db.prepare('SELECT * FROM messages ORDER BY created_at ASC').all().map(row => ({
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
  }));
}

async function loadLegacyMysqlMessages(pool) {
  const [tables] = await pool.execute("SHOW TABLES LIKE 'messages'");
  if (!tables.length) return [];
  const [messages] = await pool.execute('SELECT * FROM messages ORDER BY created_at ASC');
  return messages.map(row => ({
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
  }));
}

function createSqliteStore(messageStore) {
  const sqliteFile = process.env.SQLITE_FILE || path.join(__dirname, 'data.sqlite');
  const sqliteDir = path.dirname(sqliteFile);
  if (!fs.existsSync(sqliteDir)) fs.mkdirSync(sqliteDir, { recursive: true });
  console.info('[sqlite] 初始化本地数据库', { file: sqliteFile });
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

    CREATE TABLE IF NOT EXISTS groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      member_ids_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_friend_requests_to ON friend_requests(to_user_id, status);
  `);

  const selectUsers = db.prepare('SELECT * FROM users ORDER BY created_at ASC');
  const selectRequests = db.prepare('SELECT * FROM friend_requests ORDER BY created_at ASC');
  const selectFriendships = db.prepare('SELECT * FROM friendships ORDER BY created_at ASC');
  const selectGroups = db.prepare('SELECT * FROM groups ORDER BY created_at ASC');
  const selectLegacyState = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'app_state'");

  const replaceAll = db.transaction(nextData => {
    const data = normalizeData(nextData);
    db.exec('DELETE FROM groups; DELETE FROM friendships; DELETE FROM friend_requests; DELETE FROM users;');

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

    const insertGroup = db.prepare(`
      INSERT INTO groups (id, name, owner_id, member_ids_json, created_at)
      VALUES (@id, @name, @ownerId, @memberIdsJson, @createdAt)
    `);
    data.groups.forEach(group => insertGroup.run({
      id: group.id,
      name: group.name,
      ownerId: group.ownerId,
      memberIdsJson: JSON.stringify(group.memberIds || []),
      createdAt: group.createdAt || new Date().toISOString()
    }));

  });

  return {
    type: 'sqlite',
    file: sqliteFile,
    async load() {
      console.info('[sqlite] 开始加载数据');
      let messages = await messageStore.load();
      if (!messages.length) {
        messages = loadLegacySqliteMessages(db);
      }
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
        groups: selectGroups.all().map(row => ({
          id: row.id,
          name: row.name,
          ownerId: row.owner_id,
          memberIds: JSON.parse(row.member_ids_json || '[]'),
          createdAt: row.created_at
        })),
        messages
      });
      console.info('[sqlite] 加载完成', dataSummary(data));
      if (hasModelData(data)) return data;
      if (selectLegacyState.get()) {
        const legacy = db.prepare('SELECT data FROM app_state WHERE id = ?').get('default');
        if (legacy?.data) {
          const legacyData = normalizeData(JSON.parse(legacy.data));
          console.info('[sqlite] 使用 app_state 旧数据', dataSummary(legacyData));
          return legacyData;
        }
      }
      const legacyJson = loadLegacyJsonData();
      console.info('[sqlite] 使用 data.json 旧数据', dataSummary(legacyJson));
      return legacyJson;
    },
    async save(nextData) {
      const data = normalizeData(nextData);
      console.info('[sqlite] 开始保存数据', dataSummary(data));
      replaceAll(data);
      await messageStore.save(data.messages);
      console.info('[sqlite] 保存完成', dataSummary(data));
    },
    async close() {
      db.close();
      await messageStore.close();
    },
    async cleanupExpiredMediaFiles(now) {
      return messageStore.cleanupExpiredMediaFiles(now);
    }
  };
}

async function createMysqlStore(messageStore) {
  const config = mysqlConfigFromEnv();
  console.info('[mysql] 初始化连接池', publicMysqlConfig(config));
  const pool = config.uri ? mysql.createPool(config.uri) : mysql.createPool(config);

  console.info('[mysql] 开始初始化数据表');
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
    CREATE TABLE IF NOT EXISTS groups (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      owner_id VARCHAR(64) NOT NULL,
      member_ids_json JSON NOT NULL,
      created_at VARCHAR(32) NOT NULL
    )
  `);
  console.info('[mysql] 数据表初始化完成');

  return {
    type: 'mysql',
    async load() {
      console.info('[mysql] 开始加载数据');
      const [users] = await pool.execute('SELECT * FROM users ORDER BY created_at ASC');
      const [requests] = await pool.execute('SELECT * FROM friend_requests ORDER BY created_at ASC');
      const [friendships] = await pool.execute('SELECT * FROM friendships ORDER BY created_at ASC');
      const [groups] = await pool.execute('SELECT * FROM groups ORDER BY created_at ASC');
      let messages = await messageStore.load();
      if (!messages.length) {
        messages = await loadLegacyMysqlMessages(pool);
      }
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
        groups: groups.map(row => ({
          id: row.id,
          name: row.name,
          ownerId: row.owner_id,
          memberIds: typeof row.member_ids_json === 'string' ? JSON.parse(row.member_ids_json) : row.member_ids_json || [],
          createdAt: row.created_at
        })),
        messages
      });
      console.info('[mysql] 加载完成', dataSummary(data));
      if (hasModelData(data)) return data;
      const [legacyTables] = await pool.execute("SHOW TABLES LIKE 'app_state'");
      if (legacyTables.length) {
        const [legacyRows] = await pool.execute('SELECT data FROM app_state WHERE id = ?', ['default']);
        if (legacyRows.length) {
          const legacy = typeof legacyRows[0].data === 'string' ? JSON.parse(legacyRows[0].data) : legacyRows[0].data;
          const legacyData = normalizeData(legacy);
          console.info('[mysql] 使用 app_state 旧数据', dataSummary(legacyData));
          return legacyData;
        }
      }
      const legacyJson = loadLegacyJsonData();
      console.info('[mysql] 使用 data.json 旧数据', dataSummary(legacyJson));
      return legacyJson;
    },
    async save(nextData) {
      const data = normalizeData(nextData);
      const connection = await pool.getConnection();
      try {
        console.info('[mysql] 开始保存数据', dataSummary(data));
        await connection.beginTransaction();
        await connection.execute('DELETE FROM groups');
        await connection.execute('DELETE FROM friendships');
        await connection.execute('DELETE FROM friend_requests');
        await connection.execute('DELETE FROM users');

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

        for (const group of data.groups) {
          await connection.execute(`
            INSERT INTO groups (id, name, owner_id, member_ids_json, created_at)
            VALUES (?, ?, ?, ?, ?)
          `, [
            group.id,
            group.name,
            group.ownerId,
            JSON.stringify(group.memberIds || []),
            group.createdAt || new Date().toISOString()
          ]);
        }

        await connection.commit();
        console.info('[mysql] 事务提交完成', dataSummary(data));
      } catch (error) {
        await connection.rollback();
        console.error('[mysql] 事务回滚:', error.message);
        throw error;
      } finally {
        connection.release();
      }
      await messageStore.save(data.messages);
      console.info('[mysql] 消息存储同步完成', { messages: data.messages.length });
    },
    async close() {
      await pool.end();
      await messageStore.close();
    },
    async cleanupExpiredMediaFiles(now) {
      return messageStore.cleanupExpiredMediaFiles(now);
    }
  };
}

export async function createDataStore(nodeEnv = process.env.NODE_ENV || 'development') {
  if (nodeEnv === 'test') return createMemoryStore();
  const messageStore = await createRedisMessageStore();
  if (nodeEnv === 'production') return createMysqlStore(messageStore);
  return createSqliteStore(messageStore);
}
