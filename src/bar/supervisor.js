// 注入器守护进程：injector.js 意外退出（被杀/崩溃）时自动拉起。
//
// 为什么需要：用户反馈过"仪表盘按钮突然点不动"，查下来是 injector.js 进程已经不在了，
// 但页面上残留的底栏还在显示旧数据——没有任何东西负责把它拉回来。
//
// 约定：
// - 子进程正常退出码 0 = 已经有另一个注入器在跑（单实例锁）或收到停止信号 → 守护也退出；
// - 其它退出（被杀、崩溃）= 意外 → 2 秒后重启；短时间内反复重启（>12 次/10 分钟）则放弃，
//   避免坏掉的版本把机器打满；
// - 存在 %USERPROFILE%\.codex-bar\.supervisor-pause 时守护退出（测试/安装/卸载用它暂停守护，
//   避免和"故意停掉注入器"的逻辑打架）。
//
// 启动方式：launch.vbs / install.ps1 用 node supervisor.js 隐藏启动；测试仍可直接用
// injector-only.vbs 启动裸注入器。
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const CHILD = process.argv[2] || path.join(HERE, 'injector.js');
const BAR_DIR = path.join(os.homedir(), '.codex-bar');
const PAUSE = process.env.DSH_SUPERVISOR_PAUSE || path.join(BAR_DIR, '.supervisor-pause');
const LOG = path.join(BAR_DIR, 'bar.log');

const RESTART_DELAY_MS = 2000;
const RESTART_WINDOW_MS = 10 * 60 * 1000;
const MAX_RESTARTS = 12;

function log(...args) {
  const line = `[${new Date().toISOString()}] supervisor: ${args.join(' ')}`;
  try {
    if (fs.existsSync(LOG) && fs.statSync(LOG).size > 2 * 1024 * 1024) fs.writeFileSync(LOG, '');
    fs.appendFileSync(LOG, line + '\n');
  } catch (_) { /* 日志写不了不影响守护 */ }
}

function paused() {
  try {
    fs.accessSync(PAUSE);
    return true;
  } catch (_) {
    return false;
  }
}

if (!fs.existsSync(CHILD)) {
  log('child not found:', CHILD);
  process.exit(1);
}
if (paused()) {
  log('paused at start, exiting');
  process.exit(0);
}

const restarts = [];
let child = null;
let stopping = false;

function start() {
  child = spawn(process.execPath, [CHILD], { stdio: 'ignore', windowsHide: true });
  child.on('error', (error) => log('spawn error:', error.message));
  child.on('exit', (code, signal) => {
    child = null;
    if (stopping) return;
    if (paused()) {
      log('paused, exiting');
      process.exit(0);
    }
    if (code === 0) {
      // 单实例锁冲突或正常停止：不要再拉起
      log('child exited 0 (another injector or clean stop), exiting');
      process.exit(0);
    }
    const now = Date.now();
    while (restarts.length && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift();
    restarts.push(now);
    if (restarts.length > MAX_RESTARTS) {
      log(`child exited (${code}/${signal}) too many times (${restarts.length} in 10min), giving up`);
      process.exit(1);
    }
    log(`child exited (${code}/${signal}), restarting in ${RESTART_DELAY_MS}ms (${restarts.length}/${MAX_RESTARTS})`);
    setTimeout(() => {
      if (paused()) { log('paused before restart, exiting'); process.exit(0); }
      start();
    }, RESTART_DELAY_MS);
  });
}

function stop() {
  stopping = true;
  if (child) {
    try { child.kill(); } catch (_) { /* 已退出 */ }
  }
  process.exit(0);
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);

// 单实例锁：两个守护同时跑会互相把注入器拉成两份，还会和 pause 标记打架。
// 用本地端口做锁（与注入器的 9224 不同）。
// 端口 0 = 让系统分配（测试用）；未设置时用固定的 9225
const LOCK_PORT_ENV = process.env.DSH_SUPERVISOR_LOCK_PORT;
const LOCK_PORT = LOCK_PORT_ENV === undefined || LOCK_PORT_ENV === '' ? 9225 : Number(LOCK_PORT_ENV);
const lock = net.createServer();
lock.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    log('another supervisor is already running, exiting');
    process.exit(0);
  }
  log('lock error:', error.message);
  process.exit(1);
});
lock.listen(LOCK_PORT, '127.0.0.1', () => {
  log('started, child =', CHILD);
  start();
});
