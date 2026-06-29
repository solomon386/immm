import schedule from 'node-schedule';
import { createDataStore } from '../database.js';

const NODE_ENV = process.env.NODE_ENV || process.env.APP_ENV || 'development';
const CLEANUP_CRON = process.env.MEDIA_CLEANUP_CRON || '*/1 * * * *';
const RUN_ON_START = process.env.MEDIA_CLEANUP_RUN_ON_START !== 'false';

const dataStore = await createDataStore(NODE_ENV);
let running = false;

async function runCleanup(reason = 'schedule') {
  if (running) {
    console.log(`[media-cleanup] 上一次清理仍在执行，跳过本次任务：${reason}`);
    return;
  }

  running = true;
  try {
    const result = await dataStore.cleanupExpiredMediaFiles(Date.now());
    console.log(`[media-cleanup] ${reason} checked=${result.checked} deleted=${result.deleted}`);
  } catch (error) {
    console.error('[media-cleanup] 清理过期媒体文件失败', error);
  } finally {
    running = false;
  }
}

const job = schedule.scheduleJob(CLEANUP_CRON, () => {
  runCleanup('schedule');
});

if (!job) {
  console.error(`[media-cleanup] 无效的 MEDIA_CLEANUP_CRON：${CLEANUP_CRON}`);
  process.exit(1);
}

console.log(`[media-cleanup] 定时清理任务已启动，环境=${NODE_ENV}，cron="${CLEANUP_CRON}"`);

if (RUN_ON_START) {
  runCleanup('startup');
}

async function shutdown(signal) {
  console.log(`[media-cleanup] 收到 ${signal}，正在停止定时任务`);
  job.cancel();
  await dataStore.close();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
