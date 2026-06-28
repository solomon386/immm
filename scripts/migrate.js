import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import mysql from 'mysql2/promise';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');
const migrationsRoot = path.join(projectRoot, 'migrations');

function databaseDialect() {
  if (process.env.DB_DIALECT) return process.env.DB_DIALECT;
  return process.env.NODE_ENV === 'production' ? 'mysql' : 'sqlite';
}

function sqliteFile() {
  return process.env.SQLITE_FILE || path.join(projectRoot, 'data.sqlite');
}

function mysqlConfigFromEnv() {
  if (process.env.DATABASE_URL) return { uri: process.env.DATABASE_URL };
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

function migrationFiles(dialect) {
  const dir = path.join(migrationsRoot, dialect);
  if (!fs.existsSync(dir)) {
    throw new Error(`迁移目录不存在：${path.relative(projectRoot, dir)}`);
  }
  return fs.readdirSync(dir)
    .filter(file => file.endsWith('.sql'))
    .sort()
    .map(file => ({
      name: file,
      path: path.join(dir, file),
      sql: fs.readFileSync(path.join(dir, file), 'utf8')
    }));
}

function splitSqlStatements(sql) {
  return sql
    .split(';')
    .map(statement => statement.trim())
    .filter(Boolean);
}

function createMigrationName(rawName = '') {
  const safeName = rawName
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5]+/g, '_')
    .replace(/^_+|_+$/g, '') || 'change_model';
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  return `${stamp}_${safeName}.sql`;
}

function createMigrationFiles(name) {
  const fileName = createMigrationName(name);
  for (const dialect of ['sqlite', 'mysql']) {
    const dir = path.join(migrationsRoot, dialect);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, fileName);
    fs.writeFileSync(filePath, `-- ${dialect} migration: ${fileName}\n\n`);
    console.log(`已创建 ${path.relative(projectRoot, filePath)}`);
  }
}

function runSqlite(command) {
  const file = sqliteFile();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const db = new Database(file);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name TEXT PRIMARY KEY,
        executed_at TEXT NOT NULL
      )
    `);

    const executed = new Set(db.prepare('SELECT name FROM schema_migrations').all().map(row => row.name));
    const files = migrationFiles('sqlite');
    if (command === 'status') {
      printStatus(files, executed, 'sqlite');
      return;
    }

    const insert = db.prepare('INSERT INTO schema_migrations (name, executed_at) VALUES (?, ?)');
    for (const fileInfo of files) {
      if (executed.has(fileInfo.name)) continue;
      console.log(`执行 sqlite 迁移：${fileInfo.name}`);
      const run = db.transaction(() => {
        db.exec(fileInfo.sql);
        insert.run(fileInfo.name, new Date().toISOString());
      });
      run();
    }
  } finally {
    db.close();
  }
}

async function runMysql(command) {
  const config = mysqlConfigFromEnv();
  const pool = config.uri ? mysql.createPool(config.uri) : mysql.createPool(config);
  try {
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        executed_at DATETIME NOT NULL
      )
    `);

    const [rows] = await pool.execute('SELECT name FROM schema_migrations');
    const executed = new Set(rows.map(row => row.name));
    const files = migrationFiles('mysql');
    if (command === 'status') {
      printStatus(files, executed, 'mysql');
      return;
    }

    for (const fileInfo of files) {
      if (executed.has(fileInfo.name)) continue;
      console.log(`执行 mysql 迁移：${fileInfo.name}`);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        for (const statement of splitSqlStatements(fileInfo.sql)) {
          await connection.query(statement);
        }
        await connection.execute(
          'INSERT INTO schema_migrations (name, executed_at) VALUES (?, NOW())',
          [fileInfo.name]
        );
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      } finally {
        connection.release();
      }
    }
  } finally {
    await pool.end();
  }
}

function printStatus(files, executed, dialect) {
  console.log(`数据库类型：${dialect}`);
  if (!files.length) {
    console.log('暂无迁移文件');
    return;
  }
  files.forEach(file => {
    console.log(`${executed.has(file.name) ? '已执行' : '未执行'} ${file.name}`);
  });
}

async function main() {
  const command = process.argv[2] || 'up';
  if (command === 'create') {
    createMigrationFiles(process.argv.slice(3).join(' '));
    return;
  }

  if (!['up', 'status'].includes(command)) {
    throw new Error('未知命令，请使用 up、status 或 create');
  }

  const dialect = databaseDialect();
  if (dialect === 'sqlite') {
    runSqlite(command);
    return;
  }
  if (dialect === 'mysql') {
    await runMysql(command);
    return;
  }
  throw new Error(`不支持的数据库类型：${dialect}`);
}

main().catch(error => {
  console.error(`[migration] ${error.message}`);
  process.exitCode = 1;
});
