#!/usr/bin/env node
/**
 * 课表 · 本地账号服务
 * ------------------------------------------------------------------
 * 零依赖，只用 Node 内置模块。Node 18+ 即可运行（本机 v26）。
 *
 * 启动：node server.js
 * 地址：http://127.0.0.1:8787
 *
 * 数据落在同目录的 data/ 下：
 *   data/users.json     账号（邮箱、昵称、加盐密码哈希，不存明文）
 *   data/sessions.json  登录会话（退出或过期自动清掉）
 *
 * 只监听本机回环地址。要手机在同一 WiFi 下访问：
 *   HOST=0.0.0.0 node server.js
 * ------------------------------------------------------------------
 */
'use strict';

const http = require('node:http');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESS_FILE = path.join(DATA_DIR, 'sessions.json');

const HOST = pick('--host') || process.env.HOST || '127.0.0.1';
const PORT = Number(pick('--port') || process.env.PORT || 8787);

// Windows 的 PowerShell 里写不了 `PORT=8788 node server.js`，所以也支持命令行参数
function pick(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'tt_sid';
const MAX_BODY = 8 * 1024;

// 密码强度参数。N 越大越慢，16384 在普通笔记本上约 50–80ms，够用且不卡。
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

// 登录失败限流：同一 IP + 邮箱，10 分钟内失败 8 次就暂时拒绝。
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 8;
const failures = new Map();

const STATIC = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/README.md', { file: 'README.md', type: 'text/plain; charset=utf-8' }],
]);

/* ------------------------------- 存储 ------------------------------- */

let db = { version: 1, users: [] };
const sessions = new Map(); // sid -> { userId, exp }

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await fsp.rename(tmp, file); // 先写临时文件再改名，避免写到一半断电留下坏文件
}

// 串行化写操作：避免两个请求同时注册时互相覆盖
let chain = Promise.resolve();
function locked(fn) {
  const p = chain.then(fn, fn);
  chain = p.then(() => {}, () => {});
  return p;
}

function saveUsers() {
  return writeJson(USERS_FILE, db);
}

function saveSessions() {
  const flat = [...sessions.entries()].map(([sid, v]) => ({ sid, userId: v.userId, exp: v.exp }));
  return writeJson(SESS_FILE, { sessions: flat });
}

async function loadAll() {
  await fsp.mkdir(DATA_DIR, { recursive: true });

  const loaded = await readJson(USERS_FILE, null);
  if (loaded && Array.isArray(loaded.users)) {
    db = { version: loaded.version || 1, users: loaded.users };
  } else {
    db = { version: 1, users: [] };
    await saveUsers();
  }

  const s = await readJson(SESS_FILE, null);
  const now = Date.now();
  for (const item of (s && s.sessions) || []) {
    if (item && item.sid && item.exp > now) sessions.set(item.sid, { userId: item.userId, exp: item.exp });
  }
}

/* ------------------------------- 密码 ------------------------------- */

function hashPassword(password, saltHex) {
  return crypto
    .scryptSync(password, Buffer.from(saltHex, 'hex'), SCRYPT.keylen, {
      N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 64 * 1024 * 1024,
    })
    .toString('hex');
}

// 定长比较，防止按响应时间猜密码
function safeEqualHex(a, b) {
  const A = Buffer.from(String(a), 'hex');
  const B = Buffer.from(String(b), 'hex');
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

// 邮箱不存在时也跑一次哈希，避免「快=账号不存在」泄露
const DUMMY_SALT = '0'.repeat(32);
function dummyWork(password) {
  try { hashPassword(password, DUMMY_SALT); } catch (e) { /* ignore */ }
}

/* ------------------------------ 小工具 ------------------------------ */

function sendJson(res, code, obj, headers) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  }, headers || {}));
  res.end(body);
}

function sendText(res, code, text) {
  const body = Buffer.from(text, 'utf8');
  res.writeHead(code, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体过大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (e) { reject(Object.assign(new Error('请求格式不是合法 JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

function cookieOf(req, name) {
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, sid, maxAgeSec) {
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}`);
}

function clientIp(req) {
  return (req.socket && req.socket.remoteAddress) || 'ip';
}

function publicUser(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt || null,
  };
}

function destroySid(sid) {
  if (!sid || !sessions.has(sid)) return false;
  sessions.delete(sid);
  return true;
}

function issueSession(userId) {
  const sid = crypto.randomBytes(32).toString('hex');
  sessions.set(sid, { userId, exp: Date.now() + SESSION_TTL_MS });
  return sid;
}

/* ------------------------------ 校验 ------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function validateInput({ name, email, password }, needName) {
  if (needName) {
    if (!name) return '昵称不能为空';
    if (name.length > 24) return '昵称最多 24 个字';
    if (/[<>]/.test(name)) return '昵称里不能有尖括号';
  }
  if (!email) return '邮箱不能为空';
  if (email.length > 120) return '邮箱太长了';
  if (!EMAIL_RE.test(email)) return '邮箱格式不对，例如 you@example.com';
  if (!password) return '密码不能为空';
  if (password.length < 8) return '密码至少 8 位';
  if (password.length > 200) return '密码太长了';
  return null;
}

function failKey(req, email) {
  return `${clientIp(req)}|${email}`;
}

function tooManyFailures(req, email) {
  const rec = failures.get(failKey(req, email));
  if (!rec) return false;
  if (Date.now() - rec.first > FAIL_WINDOW_MS) {
    failures.delete(failKey(req, email));
    return false;
  }
  return rec.count >= FAIL_LIMIT;
}

function noteFailure(req, email) {
  const key = failKey(req, email);
  const rec = failures.get(key);
  if (!rec || Date.now() - rec.first > FAIL_WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else rec.count += 1;
}

function clearFailures(req, email) {
  failures.delete(failKey(req, email));
}

/* ------------------------------- 接口 ------------------------------- */

async function apiMe(req, res) {
  const sid = cookieOf(req, COOKIE_NAME);
  const s = sid ? sessions.get(sid) : null;

  if (!s || s.exp <= Date.now()) {
    if (s) {
      sessions.delete(sid);
      await saveSessions();
    }
    return sendJson(res, 401, { ok: false, loggedIn: false, error: '未登录' });
  }

  const user = db.users.find((u) => u.id === s.userId);
  if (!user) {
    sessions.delete(sid);
    await saveSessions();
    return sendJson(res, 401, { ok: false, loggedIn: false, error: '账号已不存在' });
  }

  return sendJson(res, 200, { ok: true, loggedIn: true, user: publicUser(user) });
}

async function apiRegister(req, res) {
  const body = await readBody(req);
  const name = String(body.name || '').trim().replace(/\s+/g, ' ');
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const bad = validateInput({ name, email, password }, true);
  if (bad) return sendJson(res, 400, { ok: false, error: bad });

  return locked(async () => {
    // 邮箱是账号主键；昵称同样要求唯一（"同名账户不能重复注册"）
    if (db.users.some((u) => u.email === email)) {
      return sendJson(res, 409, { ok: false, error: '这个邮箱已经注册过了，直接登录就行' });
    }
    if (db.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) {
      return sendJson(res, 409, { ok: false, error: '这个昵称已经被占了，换一个' });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const user = {
      id: 'u_' + crypto.randomBytes(6).toString('hex'),
      name,
      email,
      salt,
      hash: hashPassword(password, salt),
      algo: 'scrypt',
      createdAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
    };
    db.users.push(user);
    await saveUsers();

    // 注册完直接登录，少一次输入
    const sid = issueSession(user.id);
    await saveSessions();
    setSessionCookie(res, sid, Math.floor(SESSION_TTL_MS / 1000));
    console.log(`[注册] ${user.name} <${user.email}> → 共 ${db.users.length} 个账号`);
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  });
}

async function apiLogin(req, res) {
  const body = await readBody(req);
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  if (!email || !password) return sendJson(res, 400, { ok: false, error: '邮箱和密码都要填' });

  if (tooManyFailures(req, email)) {
    return sendJson(res, 429, { ok: false, error: '失败次数太多了，等 10 分钟再试' });
  }

  return locked(async () => {
    const user = db.users.find((u) => u.email === email);
    if (!user) {
      dummyWork(password);
      noteFailure(req, email);
      return sendJson(res, 401, { ok: false, error: '邮箱或密码不对' });
    }
    if (!safeEqualHex(user.hash, hashPassword(password, user.salt))) {
      noteFailure(req, email);
      return sendJson(res, 401, { ok: false, error: '邮箱或密码不对' });
    }

    clearFailures(req, email);
    user.lastLoginAt = new Date().toISOString();
    await saveUsers();

    const sid = issueSession(user.id);
    await saveSessions();
    setSessionCookie(res, sid, Math.floor(SESSION_TTL_MS / 1000));
    console.log(`[登录] ${user.name} <${user.email}>`);
    return sendJson(res, 200, { ok: true, user: publicUser(user) });
  });
}

async function apiLogout(req, res) {
  const sid = cookieOf(req, COOKIE_NAME);
  if (destroySid(sid)) await saveSessions();
  setSessionCookie(res, '', 0);
  return sendJson(res, 200, { ok: true, loggedIn: false });
}

async function handleApi(req, res, pathname) {
  if (pathname === '/api/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, service: 'timetable-auth', users: db.users.length });
  }
  if (pathname === '/api/me') {
    if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: '只支持 GET' });
    return apiMe(req, res);
  }
  if (pathname === '/api/register') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return apiRegister(req, res);
  }
  if (pathname === '/api/login') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return apiLogin(req, res);
  }
  if (pathname === '/api/logout') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: '只支持 POST' });
    return apiLogout(req, res);
  }
  return sendJson(res, 404, { ok: false, error: '没有这个接口' });
}

/* ------------------------------ 静态文件 ---------------------------- */

async function serveStatic(req, res, pathname) {
  const hit = STATIC.get(pathname);
  if (!hit) return sendText(res, 404, '404 · 这里只有 index.html 和 README.md');

  try {
    const buf = await fsp.readFile(path.join(ROOT, hit.file));
    res.writeHead(200, {
      'Content-Type': hit.type,
      'Content-Length': buf.length,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(req.method === 'HEAD' ? undefined : buf);
  } catch (e) {
    sendText(res, 404, '找不到 index.html');
  }
}

/* -------------------------------- 服务器 ---------------------------- */

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname.startsWith('/api/')) {
      await handleApi(req, res, pathname);
    } else if (req.method === 'GET' || req.method === 'HEAD') {
      await serveStatic(req, res, pathname);
    } else {
      sendText(res, 405, '方法不被允许');
    }
  } catch (err) {
    const status = err && err.status ? err.status : 500;
    if (status === 500) console.error('[错误]', err);
    if (!res.headersSent) sendJson(res, status, { ok: false, error: err.message || '服务器出错' });
    else res.end();
  } finally {
    if (req.url && !req.url.startsWith('/api/')) return;
    if (Date.now() - started > 200) console.log(`[慢] ${req.method} ${req.url} ${Date.now() - started}ms`);
  }
});

async function main() {
  await loadAll();
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`端口 ${PORT} 被占用了。换一个：node server.js --port 8788`);
      process.exit(1);
    }
    throw err;
  });
  server.listen(PORT, HOST, () => {
    const shown = HOST === '127.0.0.1' ? '127.0.0.1' : HOST;
    console.log('');
    console.log('  课表 · 本地账号服务已启动');
    console.log(`  打开：http://${shown}:${PORT}/`);
    console.log(`  账号：${USERS_FILE}`);
    console.log(`  会话：${SESS_FILE}`);
    console.log(`  现有账号：${db.users.length} 个`);
    console.log('  停止：Ctrl+C');
    console.log('');
  });
}

process.on('SIGINT', async () => {
  console.log('\n正在保存会话并退出…');
  try { await saveSessions(); } catch (e) { /* ignore */ }
  process.exit(0);
});

main().catch((err) => {
  console.error('启动失败：', err);
  process.exit(1);
});
