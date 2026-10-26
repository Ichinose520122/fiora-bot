// 进程单实例锁：确保同一数据目录下只有一个 QQ Agent 核心在跑。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const lockFileName = process.env.QQ_AGENT_LOCK_NAME || 'fiora-bot.lock';
const LOCK_FILE = path.join(DATA_DIR, lockFileName);

/** 进程是否还活着（Windows / POSIX 通用：signal 0 不杀进程，只探测）。 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows 上 EPERM 说明该 PID 已被系统进程/服务复用，并非当前用户的 Node 进程
    if (process.platform === 'win32' && error?.code === 'EPERM') {
      return false;
    }
    return error?.code === 'EPERM';
  }
}

/**
 * 尝试获取单实例锁。
 *
 * 用 `wx`（O_CREAT|O_EXCL）原子创建锁文件：文件已存在则创建失败，
 * 这是唯一能真正防"两个进程同时通过检查、都以为自己拿到锁"的机制。
 * 存在时再读 PID 判断是活锁（拒绝）还是残留锁（删除后重试一次）。
 *
 * @returns {{ ok: boolean, reason?: string, existingPid?: number }}
 */
export function acquireInstanceLock() {
  if (process.env.DISABLE_INSTANCE_LOCK === '1') {
    return { ok: true };
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch { /* 忽略，下面写文件会再试 */ }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // wx：仅当文件不存在时创建，已存在则抛 EEXIST —— 原子操作，无竞态窗口
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx' });
      return { ok: true };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        return { ok: false, reason: `无法写入实例锁文件：${error?.message ?? error}` };
      }
      // 锁文件已存在：读 PID 判断是否活锁
      let existingPid = null;
      try {
        existingPid = Number(String(fs.readFileSync(LOCK_FILE, 'utf8')).trim()) || null;
      } catch { /* 读不出就当残留 */ }
      if (existingPid && existingPid !== process.pid && pidAlive(existingPid)) {
        return { ok: false, reason: `已有 QQ Agent 实例在运行（PID ${existingPid}）`, existingPid };
      }
      // 残留锁（进程已死 / 锁是自己上次异常留下的）：删掉，下一轮用 wx 重新抢
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 删不掉则下一轮 wx 仍 EEXIST，最终报错 */ }
    }
  }
  return { ok: false, reason: '实例锁被占用且无法清除（可能有实例正在启动）' };
}

/** 释放单实例锁（正常退出时调用）。 */
export function releaseInstanceLock() {
  if (process.env.DISABLE_INSTANCE_LOCK === '1') return;
  try {
    // 只删自己的锁：万一锁被新实例抢走了，不能误删
    const content = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim();
    if (Number(content) === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* 文件不存在/读不出都无所谓 */ }
}

/** 注册退出时自动释放锁（SIGINT/SIGTERM/正常 exit）。 */
export function registerLockCleanup() {
  const cleanup = () => releaseInstanceLock();
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      const fuse = setTimeout(() => process.exit(1), 30000);
      fuse.unref?.();
    });
  }
}
