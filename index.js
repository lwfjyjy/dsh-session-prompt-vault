// 宿主侧插件入口：WebDAV 读写代理。
//
// 为什么需要宿主逻辑：
//   浏览器（含桌面端页面）直接 fetch WebDAV 通常会因跨域被 CORS 拦截；
//   所以把网络请求放到宿主（Node）进程，页面只调用同源的 /dsh-session-prompt-vault/webdav。
//   客户端负责提示词合并与本地存储；宿主只做「带 Basic 认证的 GET / PUT / MKCOL」，不做业务合并。
//
// 分层：常量 → HTTP 工具 → 配置校验 → WebDAV 客户端 → 路由处理器 → 插件装配。

// ---------- 常量 ----------
const ROUTE_PATH = '/dsh-session-prompt-vault/webdav';
const DIR_NAME = 'dsh-session-prompt-vault'; // WebDAV 根目录下自建文件夹（参考 magpie）
const LEGACY_DIR_NAME = 'dsh-session-quick-prompt'; // 旧插件名的目录，读取时做一次兼容
const FILE_NAME = 'prompts.json';
const MAX_BODY_BYTES = 4 * 1024 * 1024;      // 请求体上限 4MB（提示词文本足够）
const TIMEOUT_MS = 20000;                    // 单次 WebDAV 请求超时 20s
const JSON_HEAD = Object.freeze({
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
});

/**
 * @typedef {Object} DavConfig WebDAV 连接配置
 * @property {string} url
 * @property {string} username
 * @property {string} secret
 *
 * @typedef {{ method: string, username?: string, secret?: string, body?: string, contentType?: string }} DavRequestOptions
 */

// ---------- HTTP 工具 ----------
// 带 HTTP 状态码的错误，便于路由统一返回
function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// 统一返回 JSON（已发送响应则跳过，避免重复写入）
function sendJson(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, JSON_HEAD);
  res.end(JSON.stringify(body));
}

// 读取并解析请求体：按字节数限流，收集完再统一转字符串
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };

    // 先看声明的长度，能提前拒绝就不必把整包读进内存
    const declared = Number(req.headers && req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      if (typeof req.resume === 'function') req.resume();
      fail(httpError(413, '请求体过大'));
      return;
    }

    req.on('data', (chunk) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        // 不 destroy：保留连接才能把 413 响应真正发回客户端，剩余数据丢弃即可
        fail(httpError(413, '请求体过大'));
        if (typeof req.resume === 'function') req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(httpError(400, '请求体不是合法 JSON')); }
    });
    req.on('error', fail);
  });
}

// 从请求体提取连接信息（每次请求由客户端带上，宿主不持久化明文密码）
function pickConfig(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  return {
    url: String(b.url || '').trim(),
    username: String(b.username || ''),
    secret: String(b.secret || ''),
  };
}

// 校验 WebDAV 地址：非空且为 http/https
function assertDavUrl(url) {
  if (!url) throw httpError(400, '缺少 WebDAV 地址');
  let parsed;
  try { parsed = new URL(url); } catch { throw httpError(400, 'WebDAV 地址格式不正确'); }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw httpError(400, 'WebDAV 地址必须以 http:// 或 https:// 开头');
  }
}

// ---------- WebDAV 客户端 ----------
// Basic 认证头：无账号密码时不下发，避免部分服务端拒收空的 Basic 头
function authHeader(username, secret) {
  if (!username && !secret) return null;
  return 'Basic ' + Buffer.from(`${username || ''}:${secret || ''}`, 'utf8').toString('base64');
}

// 去掉末尾多余斜杠，拼出目录与文件地址
function targetPaths(url, dirName = DIR_NAME) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  return { dir: `${base}/${dirName}/`, file: `${base}/${dirName}/${FILE_NAME}` };
}

// 发一次 WebDAV 请求（带超时与认证）
async function davFetch(url, { method, username, secret, body, contentType } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {};
    const auth = authHeader(username, secret);
    if (auth) headers.authorization = auth;
    if (body !== undefined) headers['content-type'] = contentType || JSON_HEAD['content-type'];
    return await fetch(url, { method, headers, body, signal: controller.signal });
  } catch (e) {
    // 网络不可达 / 被中断统一映射为 502，便于前端提示“连接失败 / 超时”
    throw httpError(502, e && e.name === 'AbortError' ? '连接 WebDAV 超时' : '无法连接 WebDAV：' + ((e && e.message) || e));
  } finally {
    clearTimeout(timer);
  }
}

// 读取响应文本片段（用于把服务端错误信息带回前端）
async function responseText(res) {
  try { return (await res.text()).slice(0, 200); } catch { return ''; }
}

// 读取远端文件：404 视为“远端还没有数据”
async function readRemote(cfg) {
  const primary = targetPaths(cfg.url);
  let res = await davFetch(primary.file, { ...cfg, method: 'GET' });
  // 兼容旧插件名目录：新目录没有数据时再看旧目录
  if (res.status === 404) {
    const legacy = targetPaths(cfg.url, LEGACY_DIR_NAME);
    res = await davFetch(legacy.file, { ...cfg, method: 'GET' });
  }
  if (res.status === 404) return { exists: false, data: null };
  if (!res.ok) throw httpError(502, `读取失败：HTTP ${res.status} ${await responseText(res)}`);
  const text = await res.text();
  if (!text) return { exists: true, data: null };
  try { return { exists: true, data: JSON.parse(text) }; }
  catch { throw httpError(502, '远端文件不是合法 JSON'); }
}

// 写入远端文件：先确保目录存在（MKCOL，已存在会返回 405/301 等，忽略），再 PUT
async function writeRemote(cfg, data) {
  const { dir, file } = targetPaths(cfg.url);
  try { await davFetch(dir, { ...cfg, method: 'MKCOL' }); } catch { /* 目录已存在或不允许建目录，忽略 */ }
  const res = await davFetch(file, { ...cfg, method: 'PUT', body: JSON.stringify(data ?? {}) });
  if (!res.ok) throw httpError(502, `写入失败：HTTP ${res.status} ${await responseText(res)}`);
  return { ok: true };
}

// ---------- 路由处理器 ----------
function createHandler() {
  return async function webdavHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.setHeader('allow', 'POST');
        return sendJson(res, 405, { error: 'method not allowed' });
      }
      const body = await readBody(req);
      const cfg = pickConfig(body);
      assertDavUrl(cfg.url);

      const action = String(body.action || '');
      if (action === 'read') return sendJson(res, 200, await readRemote(cfg));
      if (action === 'write') {
        const data = body.data;
        if (!data || typeof data !== 'object' || Array.isArray(data)) throw httpError(400, '写入数据格式不正确');
        return sendJson(res, 200, await writeRemote(cfg, data));
      }
      throw httpError(400, '未知操作');
    } catch (e) {
      const status = e && Number.isInteger(e.status) ? e.status : 500;
      sendJson(res, status, { error: (e && e.message) || String(e) });
    }
  };
}

// ---------- 插件装配 ----------
export function apply(ctx) {
  ctx.inject(['webServer'], (c) => c.effect(
    () => c.webServer.register({ kind: 'exact', path: ROUTE_PATH, handler: createHandler() }),
    'dsh-session-prompt-vault: webdav route',
  ));
}
