/**
 * LuoguChat Cloudflare Worker v3.0
 *
 * 功能：
 * - AI 使用次数管理（每人每天限量，默认 50 次）
 * - 白名单 / 黑名单模式控制
 * - Admin 管理后台（高颜值科技风）
 * - 用户级独立配额设置
 * - KV 存储（命名空间：chat_kv）
 *
 * API 接口：
 *   POST /api/sync    - 同步状态（获取剩余次数、是否允许使用）
 *   POST /api/report  - 上报使用进度
 *
 * Admin 接口（需 Authorization: Bearer <密码>）：
 *   POST /admin/login        - 登录验证
 *   GET  /admin/users        - 获取用户列表
 *   GET  /admin/settings     - 获取全局设置
 *   POST /admin/settings     - 保存全局设置
 *   GET  /admin/user/:uid    - 获取指定用户用量
 *   POST /admin/reset/:uid   - 重置指定用户今日用量
 *   POST /admin/user/:uid    - 修改用户配额 / 重置 / 手动调整用量
 */

const ADMIN_PASSWORD = "zhl_super_admin";
const DEFAULT_DAILY_LIMIT = 50;
const KV_PREFIX = "lc_";

const UNLIMITED_USERS = [1049425];

/* ---------- KV Helpers ---------- */
async function kvGet(key, kv) {
  try {
    const val = await kv.get(KV_PREFIX + key);
    return val ? JSON.parse(val) : null;
  } catch { return null; }
}
async function kvPut(key, value, kv) {
  try { await kv.put(KV_PREFIX + key, JSON.stringify(value)); } catch {}
}
async function kvDelete(key, kv) {
  try { await kv.delete(KV_PREFIX + key); } catch {}
}

/* ---------- 工具函数 ---------- */
function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400"
  };
}
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders() }
  });
}
function htmlResponse(html) {
  return new Response(html, {
    status: 200,
    headers: { "Content-Type": "text/html;charset=utf-8", ...corsHeaders() }
  });
}
function isUnlimited(uid) {
  return UNLIMITED_USERS.includes(parseInt(uid));
}

/* ========== API Handlers ========== */

async function handleAPISync(data, kv) {
  const { uid, device_id } = data || {};
  if (!uid) return jsonResponse({ error: "Missing uid" }, 400);

  const today = todayKey();
  const usageKey = `usage_${uid}_${today}`;
  const uidNum = parseInt(uid);

  if (isUnlimited(uidNum)) {
    return jsonResponse({
      remaining: 99999,
      total: 99999,
      allowed: true,
      in_whitelist: true,
      in_blacklist: false,
      whitelist_mode: false,
      blacklist_mode: false,
      is_unlimited: true
    });
  }

  let usage = await kvGet(usageKey, kv) || { used: 0, limit: DEFAULT_DAILY_LIMIT, devices: [] };
  let settings = await kvGet("settings", kv) || {
    default_limit: DEFAULT_DAILY_LIMIT,
    whitelist_mode: false,
    blacklist_mode: false,
    whitelist: [],
    blacklist: [],
    user_limits: {}
  };

  const userLimit = settings.user_limits?.[String(uid)] || settings.default_limit || DEFAULT_DAILY_LIMIT;
  usage.limit = userLimit;
  if (device_id && !usage.devices.includes(device_id)) usage.devices.push(device_id);

  let allowed = true;
  if (settings.whitelist_mode) allowed = (settings.whitelist || []).includes(uidNum);
  if (settings.blacklist_mode && allowed) allowed = !(settings.blacklist || []).includes(uidNum);

  if (usage.used >= usage.limit) allowed = false;

  await kvPut(usageKey, usage, kv);

  return jsonResponse({
    remaining: Math.max(0, usage.limit - usage.used),
    total: usage.limit,
    allowed,
    in_whitelist: (settings.whitelist || []).includes(uidNum),
    in_blacklist: (settings.blacklist || []).includes(uidNum),
    whitelist_mode: settings.whitelist_mode || false,
    blacklist_mode: settings.blacklist_mode || false,
    is_unlimited: false
  });
}

async function handleAPIReport(data, kv) {
  const { uid, count, used } = data || {};
  if (!uid) return jsonResponse({ error: "Missing uid" }, 400);

  const addCount = count || used || 0;
  const uidNum = parseInt(uid);

  if (isUnlimited(uidNum)) {
    return jsonResponse({ remaining: 99999, total: 99999, is_unlimited: true });
  }

  const today = todayKey();
  const usageKey = `usage_${uid}_${today}`;
  let usage = await kvGet(usageKey, kv) || { used: 0, limit: DEFAULT_DAILY_LIMIT, devices: [] };
  let settings = await kvGet("settings", kv) || { default_limit: DEFAULT_DAILY_LIMIT, user_limits: {} };

  usage.limit = settings.user_limits?.[String(uid)] || settings.default_limit || DEFAULT_DAILY_LIMIT;
  usage.used = Math.min((usage.used || 0) + addCount, usage.limit);

  await kvPut(usageKey, usage, kv);

  return jsonResponse({
    remaining: Math.max(0, usage.limit - usage.used),
    total: usage.limit
  });
}

/* ========== Admin Handlers ========== */

function isAdmin(authHeader) {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, '').trim();
  return token === ADMIN_PASSWORD;
}

async function handleAdminLogin(data) {
  if (!data || !data.password || data.password !== ADMIN_PASSWORD) {
    return jsonResponse({ success: false, error: "密码错误" }, 401);
  }
  return jsonResponse({ success: true, token: ADMIN_PASSWORD });
}

async function handleAdminGetUsers(kv) {
  const users = [];
  const seen = new Set();
  try {
    let cursor;
    do {
      const list = await kv.list({ prefix: KV_PREFIX + "usage_", cursor });
      for (const key of list.keys) {
        const parts = key.name.replace(KV_PREFIX + "usage_", "").split("_");
        const uid = parts[0];
        if (!seen.has(uid)) { seen.add(uid); users.push(uid); }
      }
      cursor = list.list_complete ? null : list.cursor;
    } while (cursor);
  } catch {}
  return jsonResponse({ success: true, users: users.sort((a, b) => parseInt(a) - parseInt(b)) });
}

async function handleAdminGetSettings(kv) {
  const settings = await kvGet("settings", kv) || {
    default_limit: DEFAULT_DAILY_LIMIT,
    whitelist_mode: false,
    blacklist_mode: false,
    whitelist: [],
    blacklist: [],
    user_limits: {}
  };
  return jsonResponse({ success: true, settings });
}

async function handleAdminSaveSettings(data, kv) {
  if (!data || !data.settings) return jsonResponse({ success: false, error: "Missing settings" }, 400);
  const s = data.settings;
  const cleaned = {
    default_limit: parseInt(s.default_limit) || DEFAULT_DAILY_LIMIT,
    whitelist_mode: !!s.whitelist_mode,
    blacklist_mode: !!s.blacklist_mode,
    whitelist: (s.whitelist || []).map(n => parseInt(n)).filter(n => !isNaN(n)),
    blacklist: (s.blacklist || []).map(n => parseInt(n)).filter(n => !isNaN(n)),
    user_limits: {}
  };
  if (s.user_limits && typeof s.user_limits === 'object') {
    for (const [k, v] of Object.entries(s.user_limits)) {
      const n = parseInt(v);
      if (!isNaN(n) && n > 0) cleaned.user_limits[k] = n;
    }
  }
  await kvPut("settings", cleaned, kv);
  return jsonResponse({ success: true, settings: cleaned });
}

async function handleAdminGetUserUsage(uid, kv) {
  const today = todayKey();
  const usage = await kvGet(`usage_${uid}_${today}`, kv) || { used: 0, limit: DEFAULT_DAILY_LIMIT, devices: [] };
  const settings = await kvGet("settings", kv) || { user_limits: {} };
  const userLimit = settings.user_limits?.[String(uid)];
  return jsonResponse({
    success: true,
    uid,
    usage,
    is_unlimited: isUnlimited(uid),
    user_specific_limit: userLimit || null
  });
}

async function handleAdminResetUser(uid, kv) {
  const today = todayKey();
  await kvDelete(`usage_${uid}_${today}`, kv);
  return jsonResponse({ success: true, message: "已重置今日用量" });
}

async function handleAdminUpdateUser(uid, data, kv) {
  if (!data) return jsonResponse({ success: false, error: "Missing data" }, 400);
  const today = todayKey();
  const usageKey = `usage_${uid}_${today}`;

  if (data.action === 'set_used' && typeof data.used !== 'undefined') {
    let usage = await kvGet(usageKey, kv) || { used: 0, limit: DEFAULT_DAILY_LIMIT, devices: [] };
    const settings = await kvGet("settings", kv) || { default_limit: DEFAULT_DAILY_LIMIT, user_limits: {} };
    usage.limit = settings.user_limits?.[String(uid)] || settings.default_limit || DEFAULT_DAILY_LIMIT;
    usage.used = Math.max(0, Math.min(parseInt(data.used) || 0, usage.limit));
    await kvPut(usageKey, usage, kv);
    return jsonResponse({ success: true, usage });
  }

  if (data.action === 'set_limit' && typeof data.limit !== 'undefined') {
    const settings = await kvGet("settings", kv) || { default_limit: DEFAULT_DAILY_LIMIT, user_limits: {} };
    const newLimit = parseInt(data.limit);
    if (isNaN(newLimit) || newLimit < 0) return jsonResponse({ success: false, error: "Invalid limit" }, 400);
    if (!settings.user_limits) settings.user_limits = {};
    if (newLimit === settings.default_limit) {
      delete settings.user_limits[String(uid)];
    } else {
      settings.user_limits[String(uid)] = newLimit;
    }
    await kvPut("settings", settings, kv);
    let usage = await kvGet(usageKey, kv) || { used: 0, limit: DEFAULT_DAILY_LIMIT, devices: [] };
    usage.limit = newLimit;
    usage.used = Math.min(usage.used, usage.limit);
    await kvPut(usageKey, usage, kv);
    return jsonResponse({ success: true, settings, usage });
  }

  return jsonResponse({ success: false, error: "Unknown action" }, 400);
}

/* ========== Admin HTML (高颜值科技风) ========== */

function adminHTML() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>LuoguChat Server · Admin</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    --bg-0: #050816;
    --bg-1: #0a0f24;
    --bg-2: #0f1530;
    --glass: rgba(255,255,255,0.03);
    --glass-border: rgba(255,255,255,0.08);
    --text-primary: #e6e9f5;
    --text-secondary: #8892b0;
    --text-muted: #5a6482;
    --accent-1: #6366f1;
    --accent-2: #06b6d4;
    --accent-3: #8b5cf6;
    --success: #10b981;
    --warning: #f59e0b;
    --danger: #ef4444;
    --shadow-glow: 0 0 20px rgba(99,102,241,0.15);
  }
  html, body { height: 100%; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
    background:
      radial-gradient(ellipse at top left, rgba(99,102,241,0.08), transparent 50%),
      radial-gradient(ellipse at bottom right, rgba(6,182,212,0.06), transparent 50%),
      linear-gradient(180deg, var(--bg-0) 0%, var(--bg-1) 100%);
    color: var(--text-primary);
    min-height: 100vh;
    overflow-x: hidden;
  }
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background-image:
      linear-gradient(rgba(255,255,255,0.02) 1px, transparent 1px),
      linear-gradient(90deg, rgba(255,255,255,0.02) 1px, transparent 1px);
    background-size: 40px 40px;
    pointer-events: none;
    z-index: 0;
  }
  .app { position: relative; z-index: 1; }
  .container { max-width: 1200px; margin: 0 auto; padding: 20px; }

  /* Header */
  .header {
    text-align: center;
    padding: 48px 20px 36px;
    position: relative;
  }
  .header .logo-mark {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 56px; height: 56px;
    border-radius: 16px;
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
    box-shadow: 0 8px 32px rgba(99,102,241,0.3);
    margin-bottom: 16px;
    font-size: 24px;
  }
  .header h1 {
    font-size: 32px;
    font-weight: 700;
    background: linear-gradient(135deg, #a5b4fc 0%, #67e8f9 50%, #c4b5fd 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    letter-spacing: 0.5px;
  }
  .header p {
    color: var(--text-muted);
    margin-top: 8px;
    font-size: 14px;
    letter-spacing: 0.3px;
  }

  /* Cards */
  .card {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: 16px;
    padding: 24px;
    margin-bottom: 20px;
    backdrop-filter: blur(12px);
    -webkit-backdrop-filter: blur(12px);
    box-shadow: var(--shadow-glow);
    transition: border-color 0.3s, box-shadow 0.3s;
  }
  .card:hover {
    border-color: rgba(99,102,241,0.2);
    box-shadow: 0 0 24px rgba(99,102,241,0.2);
  }
  .card-title {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 18px;
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 8px;
    letter-spacing: 0.3px;
  }
  .card-title::before {
    content: '';
    width: 3px; height: 16px;
    background: linear-gradient(180deg, var(--accent-1), var(--accent-2));
    border-radius: 2px;
  }

  /* Login */
  #loginView {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 20px;
  }
  .login-box {
    width: 100%;
    max-width: 400px;
  }
  .login-card { text-align: center; }
  .login-card .card-title { justify-content: center; }

  /* Inputs */
  input, select, textarea {
    width: 100%;
    background: rgba(255,255,255,0.04);
    border: 1px solid var(--glass-border);
    border-radius: 10px;
    padding: 10px 14px;
    color: var(--text-primary);
    font-size: 13px;
    outline: none;
    transition: all 0.25s;
    font-family: inherit;
  }
  input:focus, select:focus, textarea:focus {
    border-color: var(--accent-1);
    background: rgba(99,102,241,0.05);
    box-shadow: 0 0 0 3px rgba(99,102,241,0.1);
  }
  textarea { resize: vertical; min-height: 80px; font-family: 'SF Mono', 'Fira Code', monospace; }

  .form-group { margin-bottom: 14px; }
  .form-label {
    display: block;
    color: var(--text-secondary);
    font-size: 12px;
    margin-bottom: 6px;
    font-weight: 500;
  }
  .form-row { display: flex; gap: 12px; }
  .form-row > .form-group { flex: 1; }

  /* Buttons */
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 10px 22px;
    border: none;
    border-radius: 10px;
    font-size: 13px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.25s;
    font-family: inherit;
    color: white;
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
    box-shadow: 0 4px 14px rgba(99,102,241,0.25);
  }
  .btn:hover { transform: translateY(-1px); box-shadow: 0 6px 20px rgba(99,102,241,0.35); }
  .btn:active { transform: translateY(0); }
  .btn.btn-block { width: 100%; }
  .btn.btn-sm { padding: 6px 14px; font-size: 12px; border-radius: 8px; }
  .btn.btn-danger {
    background: linear-gradient(135deg, #ef4444, #f97316);
    box-shadow: 0 4px 14px rgba(239,68,68,0.25);
  }
  .btn.btn-secondary {
    background: rgba(255,255,255,0.06);
    box-shadow: none;
    border: 1px solid var(--glass-border);
    color: var(--text-primary);
  }
  .btn.btn-secondary:hover { background: rgba(255,255,255,0.1); }

  /* Nav tabs */
  .tabs {
    display: flex;
    gap: 4px;
    margin-bottom: 20px;
    background: var(--glass);
    padding: 6px;
    border-radius: 12px;
    border: 1px solid var(--glass-border);
  }
  .tab {
    flex: 1;
    padding: 10px 16px;
    text-align: center;
    border-radius: 8px;
    font-size: 13px;
    font-weight: 500;
    color: var(--text-secondary);
    cursor: pointer;
    transition: all 0.25s;
    user-select: none;
  }
  .tab:hover { color: var(--text-primary); background: rgba(255,255,255,0.03); }
  .tab.active {
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
    color: white;
    box-shadow: 0 4px 12px rgba(99,102,241,0.25);
  }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* Tables */
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  thead th {
    text-align: left;
    padding: 10px 12px;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--glass-border);
  }
  tbody td {
    padding: 12px;
    border-bottom: 1px solid rgba(255,255,255,0.03);
  }
  tbody tr:hover { background: rgba(255,255,255,0.02); }
  tbody tr:last-child td { border-bottom: none; }

  /* Badges */
  .badge {
    display: inline-flex;
    align-items: center;
    padding: 3px 10px;
    border-radius: 6px;
    font-size: 11px;
    font-weight: 600;
    gap: 4px;
  }
  .badge::before {
    content: '';
    width: 6px; height: 6px;
    border-radius: 50%;
    background: currentColor;
  }
  .badge-ok { background: rgba(16,185,129,0.12); color: #34d399; }
  .badge-warn { background: rgba(245,158,11,0.12); color: #fbbf24; }
  .badge-err { background: rgba(239,68,68,0.12); color: #f87171; }
  .badge-info { background: rgba(99,102,241,0.12); color: #818cf8; }
  .badge-purple { background: rgba(139,92,246,0.12); color: #a78bfa; }

  /* Tags */
  .tag {
    display: inline-flex;
    align-items: center;
    padding: 4px 12px;
    border-radius: 20px;
    font-size: 11px;
    background: rgba(99,102,241,0.08);
    border: 1px solid rgba(99,102,241,0.15);
    color: #a5b4fc;
    margin: 3px;
  }
  .tag.purple { background: rgba(139,92,246,0.08); border-color: rgba(139,92,246,0.15); color: #c4b5fd; }
  .tag.cyan { background: rgba(6,182,212,0.08); border-color: rgba(6,182,212,0.15); color: #67e8f9; }
  .tag.green { background: rgba(16,185,129,0.08); border-color: rgba(16,185,129,0.15); color: #6ee7b7; }

  /* Stats row */
  .stats-row { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .stat-card {
    background: var(--glass);
    border: 1px solid var(--glass-border);
    border-radius: 12px;
    padding: 18px;
    backdrop-filter: blur(10px);
  }
  .stat-label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; }
  .stat-value { font-size: 24px; font-weight: 700; background: linear-gradient(135deg, #a5b4fc, #67e8f9); -webkit-background-clip: text; -webkit-text-fill-color: transparent; background-clip: text; }

  .hidden { display: none !important; }

  /* Toggle switch */
  .toggle { position: relative; display: inline-block; width: 44px; height: 24px; }
  .toggle input { opacity: 0; width: 0; height: 0; }
  .toggle-slider {
    position: absolute; cursor: pointer;
    inset: 0;
    background: rgba(255,255,255,0.08);
    border-radius: 24px;
    transition: 0.3s;
    border: 1px solid var(--glass-border);
  }
  .toggle-slider::before {
    position: absolute;
    content: "";
    height: 18px; width: 18px;
    left: 2px; top: 2px;
    background: white;
    border-radius: 50%;
    transition: 0.3s;
    box-shadow: 0 2px 6px rgba(0,0,0,0.2);
  }
  .toggle input:checked + .toggle-slider {
    background: linear-gradient(135deg, var(--accent-1), var(--accent-2));
    border-color: transparent;
  }
  .toggle input:checked + .toggle-slider::before { transform: translateX(20px); }

  /* Alert */
  .alert {
    padding: 12px 16px;
    border-radius: 10px;
    font-size: 13px;
    margin-bottom: 14px;
    border: 1px solid transparent;
  }
  .alert-error { background: rgba(239,68,68,0.08); border-color: rgba(239,68,68,0.2); color: #fca5a5; }
  .alert-success { background: rgba(16,185,129,0.08); border-color: rgba(16,185,129,0.2); color: #6ee7b7; }

  /* Modal */
  .modal-mask {
    position: fixed; inset: 0;
    background: rgba(0,0,0,0.6);
    backdrop-filter: blur(4px);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 100;
    padding: 20px;
  }
  .modal-mask.active { display: flex; }
  .modal {
    background: var(--bg-2);
    border: 1px solid var(--glass-border);
    border-radius: 16px;
    width: 100%;
    max-width: 520px;
    padding: 24px;
    box-shadow: 0 24px 64px rgba(0,0,0,0.5);
  }
  .modal h3 { font-size: 18px; margin-bottom: 16px; }
  .modal-footer { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }

  .mono { font-family: 'SF Mono', 'Fira Code', Consolas, monospace; font-size: 11px; }
  .text-right { text-align: right; }
  .empty-state { text-align: center; padding: 30px; color: var(--text-muted); font-size: 13px; }
  .action-btns { display: flex; gap: 6px; }

  /* Scrollbar */
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.08); border-radius: 4px; }
  ::-webkit-scrollbar-thumb:hover { background: rgba(255,255,255,0.15); }
</style>
</head>
<body>
<div class="app">

  <!-- Login View -->
  <div id="loginView">
    <div class="login-box">
      <div class="header">
        <div class="logo-mark">⚡</div>
        <h1>LuoguChat Server</h1>
        <p>AI 配额管理 · 用户监控</p>
      </div>
      <div class="card login-card">
        <h2 class="card-title">管理员登录</h2>
        <div id="loginError" class="alert alert-error hidden"></div>
        <div class="form-group">
          <label class="form-label">管理员密码</label>
          <input type="password" id="adminPwd" placeholder="请输入管理员密码" />
        </div>
        <button class="btn btn-block" onclick="login()">登录</button>
      </div>
    </div>
  </div>

  <!-- Dashboard View -->
  <div id="dashboardView" class="hidden">
    <button class="btn btn-sm btn-secondary" onclick="logout()" style="position:fixed;top:16px;right:16px;z-index:50">退出登录</button>
    <div class="container">
      <div class="header">
        <div class="logo-mark">⚡</div>
        <h1>LuoguChat Server</h1>
        <p>AI 配额管理 · 用户监控</p>
      </div>

      <div class="stats-row">
        <div class="stat-card"><div class="stat-label">今日活跃用户</div><div class="stat-value" id="statUsers">-</div></div>
        <div class="stat-card"><div class="stat-label">默认每日限额</div><div class="stat-value" id="statLimit">-</div></div>
      </div>

      <div class="tabs">
        <div class="tab active" data-tab="users">用户管理</div>
        <div class="tab" data-tab="settings">全局设置</div>
      </div>

      <!-- Users Tab -->
      <div class="tab-content active" id="tab-users">
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
            <h2 class="card-title" style="margin-bottom:0">用户用量</h2>
            <button class="btn btn-sm btn-secondary" onclick="loadUsers()">↻ 刷新</button>
          </div>
          <table>
            <thead>
              <tr>
                <th>UID</th>
                <th>今日用量</th>
                <th>限额</th>
                <th>剩余</th>
                <th>状态</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody id="usageTable"></tbody>
          </table>
          <div id="noUsers" class="empty-state hidden">暂无用户数据</div>
        </div>
      </div>

      <!-- Settings Tab -->
      <div class="tab-content" id="tab-settings">
        <div class="card">
          <h2 class="card-title">全局设置</h2>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label">每日默认限额</label>
              <input type="number" id="defaultLimit" value="50" min="1" />
            </div>
            <div class="form-group">
              <label class="form-label">白名单模式</label>
              <label class="toggle" style="margin-top:10px">
                <input type="checkbox" id="wlMode" />
                <span class="toggle-slider"></span>
              </label>
            </div>
            <div class="form-group">
              <label class="form-label">黑名单模式</label>
              <label class="toggle" style="margin-top:10px">
                <input type="checkbox" id="blMode" />
                <span class="toggle-slider"></span>
              </label>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">白名单 (UID，逗号或换行分隔)</label>
            <textarea id="whitelist" placeholder="123&#10;456"></textarea>
          </div>
          <div class="form-group">
            <label class="form-label">黑名单 (UID，逗号或换行分隔)</label>
            <textarea id="blacklist" placeholder="789&#10;101"></textarea>
          </div>
          <div id="settingsMsg"></div>
          <button class="btn" onclick="saveSettings()">💾 保存设置</button>
        </div>
      </div>

    </div>
  </div>

</div>

<!-- User Modal -->
<div class="modal-mask" id="userModal">
  <div class="modal">
    <h3>用户设置 — <span id="modalUid"></span></h3>
    <div class="form-group">
      <label class="form-label">今日已用次数</label>
      <input type="number" id="modalUsed" value="0" min="0" />
    </div>
    <div class="form-group">
      <label class="form-label">个人每日限额（设为默认值则移除个人配置）</label>
      <input type="number" id="modalLimit" value="50" min="1" />
    </div>
    <div id="modalMsg"></div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeModal()">取消</button>
      <button class="btn" onclick="saveUserModal()">保存</button>
    </div>
  </div>
</div>

<script>
let adminToken = '';
// 页面刷新 / 重新打开后自动恢复已保存的登录态（存于浏览器 localStorage）
(function restoreAdmin(){
  try {
    const saved = localStorage.getItem('lc_admin_token');
    if (saved) {
      adminToken = saved;
      const lv = document.getElementById('loginView');
      const dv = document.getElementById('dashboardView');
      if (lv) lv.classList.add('hidden');
      if (dv) dv.classList.remove('hidden');
      initDashboard();
    }
  } catch(e){}
})();
let currentModalUid = '';
let userCache = {};

/* ------ 基础 API ------ */
async function api(path, data, method) {
  const headers = { 'Content-Type': 'application/json' };
  if (adminToken) headers['Authorization'] = 'Bearer ' + adminToken;
  const res = await fetch(path, {
    method: method || (data ? 'POST' : 'GET'),
    headers,
    body: data ? JSON.stringify(data) : undefined
  });
  return res.json();
}

/* ------ 登录 ------ */
async function login() {
  const pwd = document.getElementById('adminPwd').value;
  const res = await api('/admin/login', { password: pwd });
  if (res.success) {
    adminToken = res.token;
    try { localStorage.setItem('lc_admin_token', adminToken); } catch(e){}
    document.getElementById('loginView').classList.add('hidden');
    document.getElementById('dashboardView').classList.remove('hidden');
    initDashboard();
  } else {
    const el = document.getElementById('loginError');
    el.textContent = res.error || '登录失败';
    el.classList.remove('hidden');
  }
}

document.getElementById('adminPwd').addEventListener?.('keydown', e => {
  if (e.key === 'Enter') login();
});

/* ------ 退出登录（清除本地保存的 token） ------ */
function logout() {
  try { localStorage.removeItem('lc_admin_token'); } catch(e){}
  adminToken = '';
  location.reload();
}

/* ------ Tabs ------ */
document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    document.getElementById('tab-' + t.dataset.tab).classList.add('active');
  });
});

/* ------ Dashboard Init ------ */
async function initDashboard() {
  await loadSettings();
  await loadUsers();
}

/* ------ 设置 ------ */
async function loadSettings() {
  const res = await api('/admin/settings');
  if (res.success && res.settings) {
    document.getElementById('defaultLimit').value = res.settings.default_limit || 50;
    document.getElementById('wlMode').checked = !!res.settings.whitelist_mode;
    document.getElementById('blMode').checked = !!res.settings.blacklist_mode;
    document.getElementById('whitelist').value = (res.settings.whitelist || []).join('\\n');
    document.getElementById('blacklist').value = (res.settings.blacklist || []).join('\\n');
    document.getElementById('statLimit').textContent = res.settings.default_limit || 50;
  }
}

async function saveSettings() {
  const s = {
    default_limit: parseInt(document.getElementById('defaultLimit').value) || 50,
    whitelist_mode: document.getElementById('wlMode').checked,
    blacklist_mode: document.getElementById('blMode').checked,
    whitelist: document.getElementById('whitelist').value.split(/[,\\n]/).map(x => parseInt(x.trim())).filter(n => !isNaN(n)),
    blacklist: document.getElementById('blacklist').value.split(/[,\\n]/).map(x => parseInt(x.trim())).filter(n => !isNaN(n)),
    user_limits: {}
  };
  const res = await api('/admin/settings', { settings: s });
  const el = document.getElementById('settingsMsg');
  if (res.success) {
    el.innerHTML = '<div class="alert alert-success">保存成功</div>';
    document.getElementById('statLimit').textContent = s.default_limit;
    setTimeout(() => el.innerHTML = '', 2000);
  } else {
    el.innerHTML = '<div class="alert alert-error">' + (res.error || '保存失败') + '</div>';
  }
}

/* ------ 用户 ------ */
async function loadUsers() {
  const res = await api('/admin/users');
  const tb = document.getElementById('usageTable');
  tb.innerHTML = '';
  userCache = {};
  if (res.success && res.users && res.users.length > 0) {
    document.getElementById('noUsers').classList.add('hidden');
    document.getElementById('statUsers').textContent = res.users.length;
    for (const uid of res.users) {
      const u = await api('/admin/user/' + uid);
      if (u.success) {
        userCache[uid] = u;
        const rem = u.usage.limit - u.usage.used;
        const badge = u.is_unlimited
          ? '<span class="badge badge-purple">无限制</span>'
          : (rem > 0 ? (rem > 10 ? '<span class="badge badge-ok">正常</span>' : '<span class="badge badge-warn">即将耗尽</span>') : '<span class="badge badge-err">已用完</span>');
        const tr = document.createElement('tr');
        tr.innerHTML =
          '<td><strong>' + uid + '</strong>' +
          (u.is_unlimited ? ' <span class="tag purple" style="font-size:9px;padding:1px 6px">无限</span>' : '') +
          '</td>' +
          '<td>' + u.usage.used + '</td>' +
          '<td>' + (u.is_unlimited ? '∞' : u.usage.limit) + '</td>' +
          '<td>' + (u.is_unlimited ? '∞' : rem) + '</td>' +
          '<td>' + badge + '</td>' +
          '<td><div class="action-btns">' +
          '<button class="btn btn-sm btn-secondary" onclick="openUserModal(\\'' + uid + '\\')">设置</button>' +
          '<button class="btn btn-sm btn-danger" onclick="resetUser(\\'' + uid + '\\')">重置</button>' +
          '</div></td>';
        tb.appendChild(tr);
      }
    }
  } else {
    document.getElementById('noUsers').classList.remove('hidden');
    document.getElementById('statUsers').textContent = '0';
  }
}

async function resetUser(uid) {
  if (!confirm('确定重置 ' + uid + ' 的今日用量？')) return;
  await api('/admin/reset/' + uid, {});
  loadUsers();
}

function openUserModal(uid) {
  currentModalUid = uid;
  const u = userCache[uid];
  document.getElementById('modalUid').textContent = uid;
  document.getElementById('modalUsed').value = u?.usage?.used || 0;
  document.getElementById('modalLimit').value = u?.usage?.limit || 50;
  document.getElementById('modalMsg').innerHTML = '';
  document.getElementById('userModal').classList.add('active');
}
function closeModal() {
  document.getElementById('userModal').classList.remove('active');
}
document.getElementById('userModal').addEventListener('click', e => {
  if (e.target.id === 'userModal') closeModal();
});

async function saveUserModal() {
  const uid = currentModalUid;
  const used = parseInt(document.getElementById('modalUsed').value) || 0;
  const limit = parseInt(document.getElementById('modalLimit').value) || 50;
  const r1 = await api('/admin/user/' + uid, { action: 'set_used', used });
  const r2 = await api('/admin/user/' + uid, { action: 'set_limit', limit });
  const el = document.getElementById('modalMsg');
  if (r1.success && r2.success) {
    el.innerHTML = '<div class="alert alert-success">保存成功</div>';
    setTimeout(() => { closeModal(); loadUsers(); }, 800);
  } else {
    el.innerHTML = '<div class="alert alert-error">保存失败</div>';
  }
}

/* ------ 回车登录 ------ */
window.addEventListener('load', () => {
  const input = document.getElementById('adminPwd');
  if (input) input.addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
});
</script>
</body>
</html>`;
}

/* ========== 主路由 ========== */

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const kv = env.chat_kv;

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (path === "/" || path === "/admin") {
      return htmlResponse(adminHTML());
    }

    try {
      let data = {};
      if (request.method === "POST" || request.method === "PUT" || request.method === "PATCH") {
        const ct = request.headers.get("Content-Type") || "";
        if (ct.includes("application/json")) {
          try { data = await request.json(); } catch { data = {}; }
        }
      }

      if (path.startsWith("/admin/") && path !== "/admin/login") {
        const auth = request.headers.get("Authorization") || "";
        if (!isAdmin(auth)) {
          return jsonResponse({ success: false, error: "未授权" }, 401);
        }
      }

      switch (path) {
        case "/api/sync":
          return await handleAPISync(data, kv);
        case "/api/report":
          return await handleAPIReport(data, kv);
        case "/admin/login":
          return await handleAdminLogin(data, kv);
        case "/admin/users":
          return await handleAdminGetUsers(kv);
        case "/admin/settings":
          if (request.method === "POST") return await handleAdminSaveSettings(data, kv);
          return await handleAdminGetSettings(kv);
        default: {
          const userMatch = path.match(/^\/admin\/user\/(\d+)$/);
          if (userMatch) {
            if (request.method === "POST") return await handleAdminUpdateUser(userMatch[1], data, kv);
            return await handleAdminGetUserUsage(userMatch[1], kv);
          }
          const resetMatch = path.match(/^\/admin\/reset\/(\d+)$/);
          if (resetMatch) return await handleAdminResetUser(resetMatch[1], kv);

          return htmlResponse(adminHTML());
        }
      }
    } catch (e) {
      return jsonResponse({ error: e.message || "Server error", stack: e.stack }, 500);
    }
  }
};
