/**
 * 轻量运行面板服务：提供状态与日志查询接口
 */

const http = require('http');
const { URL } = require('url');
const fs = require('fs');
const path = require('path');
const { CONFIG } = require('./config');
const { getLevelExpProgress } = require('./gameConfig');
const { getPlantingRecommendation } = require('../tools/calc-exp-yield');

const MAX_LOGS = Math.max(0, Number(process.env.DASHBOARD_MAX_LOGS || 120));
const DASHBOARD_TOKEN = process.env.DASHBOARD_TOKEN || '';
const RATE_MIN_WINDOW_SEC = 120;
const FARM_CALC_ROOT = path.join(process.cwd(), 'FarmCalc');

const MIME_TYPES = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
};

const state = {
    startedAt: Date.now(),
    status: {
        platform: 'qq',
        name: '',
        level: 0,
        gold: 0,
        exp: 0,
    },
    baseline: {
        gold: null,
        exp: null,
        ready: false,
        key: '',
    },
    strategy: {
        mode: 'normalFert',
        manualSeedId: 0,
        manualSeedName: '',
        source: 'auto',
        updatedAt: 0,
        lastDecision: null,
    },
    logs: [],
    nextLogId: 1,
};

let server = null;
let listenPort = 0;

function nowIso() {
    return new Date().toISOString();
}

function addLog(level, message) {
    if (MAX_LOGS <= 0) return;
    const item = {
        id: state.nextLogId++,
        ts: nowIso(),
        level,
        message: String(message || ''),
    };
    state.logs.push(item);
    if (state.logs.length > MAX_LOGS) {
        state.logs.shift();
    }
}

function updateStatus(partial) {
    if (!partial || typeof partial !== 'object') return;

    const prevName = state.status.name;
    const prevPlatform = state.status.platform;
    Object.assign(state.status, partial);

    const name = String(state.status.name || '');
    const platform = String(state.status.platform || '');
    const loginReady = !!name || Number(state.status.level || 0) > 0;
    const identityKey = loginReady ? (platform + ':' + name) : '';

    if (state.baseline.ready && identityKey && state.baseline.key && identityKey !== state.baseline.key) {
        state.baseline.ready = false;
        state.baseline.gold = null;
        state.baseline.exp = null;
        state.baseline.key = '';
    }

    const identityChanged = prevName !== state.status.name || prevPlatform !== state.status.platform;
    if (!state.baseline.ready && loginReady && (identityChanged || Number.isFinite(state.status.exp) || Number.isFinite(state.status.gold))) {
        state.baseline.gold = Number.isFinite(state.status.gold) ? Number(state.status.gold) : 0;
        state.baseline.exp = Number.isFinite(state.status.exp) ? Number(state.status.exp) : 0;
        state.baseline.ready = true;
        state.baseline.key = identityKey;
    }
}

function buildMetrics(uptimeSec) {
    const level = Number(state.status.level) || 0;
    const exp = Number(state.status.exp) || 0;
    const gold = Number(state.status.gold) || 0;
    const baseExp = state.baseline.ready && state.baseline.exp !== null ? state.baseline.exp : exp;
    const baseGold = state.baseline.ready && state.baseline.gold !== null ? state.baseline.gold : gold;

    const expGain = exp - baseExp;
    const goldGain = gold - baseGold;
    const progress = getLevelExpProgress(level, exp);
    const expNeeded = Number(progress.needed) || 1;
    const expCurrent = Number(progress.current) || 0;

    const rateReady = uptimeSec >= RATE_MIN_WINDOW_SEC;
    const expPerHour = rateReady ? Math.round(expGain / (uptimeSec / 3600)) : 0;
    const goldPerHour = rateReady ? Math.round(goldGain / (uptimeSec / 3600)) : 0;

    return {
        expGain,
        goldGain,
        expPerHour,
        goldPerHour,
        rateReady,
        rateWindowSec: RATE_MIN_WINDOW_SEC,
        expCurrent,
        expNeeded,
        expProgress: Math.max(0, Math.min(100, Math.round((expCurrent / expNeeded) * 100))),
        goldRateProgress: Math.max(0, Math.min(100, Math.round((Math.abs(goldPerHour) / 30000) * 100))),
    };
}

function getStrategyConfig() {
    return {
        mode: state.strategy.mode,
        manualSeedId: Number(state.strategy.manualSeedId) || 0,
        manualSeedName: state.strategy.manualSeedName || '',
        source: state.strategy.source || 'auto',
        updatedAt: state.strategy.updatedAt || 0,
        lastDecision: state.strategy.lastDecision || null,
    };
}

function updateStrategyConfig(patch) {
    if (!patch || typeof patch !== 'object') return getStrategyConfig();

    if (patch.mode === 'normalFert' || patch.mode === 'noFert') {
        state.strategy.mode = patch.mode;
    }

    if (patch.clearManual) {
        state.strategy.manualSeedId = 0;
        state.strategy.manualSeedName = '';
        state.strategy.source = 'auto';
    }

    if (patch.manualSeedId !== undefined) {
        const sid = Number(patch.manualSeedId) || 0;
        state.strategy.manualSeedId = sid;
        if (sid > 0) {
            state.strategy.source = 'manual';
            state.strategy.manualSeedName = String(patch.manualSeedName || state.strategy.manualSeedName || '');
        }
    }

    state.strategy.updatedAt = Date.now();
    return getStrategyConfig();
}

function recordStrategyDecision(decision) {
    state.strategy.lastDecision = {
        at: Date.now(),
        ...(decision || {}),
    };
}

function getCalcPayload(level, lands, mode, top) {
    const rec = getPlantingRecommendation(level, lands, { top });
    const candidates = mode === 'noFert' ? rec.candidatesNoFert : rec.candidatesNormalFert;
    const best = mode === 'noFert' ? rec.bestNoFert : rec.bestNormalFert;
    return {
        level: rec.level,
        lands: rec.lands,
        mode,
        best,
        candidates: candidates.slice(0, top),
        generatedAt: Date.now(),
    };
}

function resolveFarmCalcFile(requestPath) {
    if (!requestPath.startsWith('/calc')) return null;
    const relRaw = requestPath === '/calc' || requestPath === '/calc/' ? '/index.html' : requestPath.slice('/calc'.length);
    const relSafe = relRaw.replace(/\\/g, '/');
    const abs = path.resolve(FARM_CALC_ROOT, `.${relSafe}`);
    if (!abs.startsWith(path.resolve(FARM_CALC_ROOT))) return null;
    return abs;
}

function serveFile(res, absPath) {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
        sendJson(res, { error: 'Not Found' }, 404);
        return;
    }
    const ext = path.extname(absPath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    const content = fs.readFileSync(absPath);
    res.writeHead(200, {
        'content-type': contentType,
        'cache-control': 'no-store',
    });
    res.end(content);
}

function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            if (chunks.length === 0) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (e) {
                reject(new Error('invalid_json'));
            }
        });
        req.on('error', reject);
    });
}

function getRuntimeSettings() {
    return {
        farmIntervalSec: Math.max(1, Math.round(Number(CONFIG.farmCheckInterval || 1000) / 1000)),
        friendIntervalSec: Math.max(1, Math.round(Number(CONFIG.friendCheckInterval || 1000) / 1000)),
    };
}

function updateRuntimeSettings(patch) {
    const current = getRuntimeSettings();
    const next = { ...current };

    if (patch && patch.farmIntervalSec !== undefined) {
        const farm = Number(patch.farmIntervalSec);
        if (!Number.isFinite(farm) || farm <= 0) {
            throw new Error('invalid_farm_interval');
        }
        next.farmIntervalSec = Math.max(1, Math.floor(farm));
    }

    if (patch && patch.friendIntervalSec !== undefined) {
        const friend = Number(patch.friendIntervalSec);
        if (!Number.isFinite(friend) || friend <= 0) {
            throw new Error('invalid_friend_interval');
        }
        next.friendIntervalSec = Math.max(1, Math.floor(friend));
    }

    CONFIG.farmCheckInterval = next.farmIntervalSec * 1000;
    CONFIG.friendCheckInterval = next.friendIntervalSec * 1000;
    return next;
}

function getLogsSince(sinceId) {
    if (!Number.isFinite(sinceId) || sinceId <= 0) {
        return state.logs;
    }
    return state.logs.filter(item => item.id > sinceId);
}

function sendJson(res, payload, statusCode = 200) {
    const body = JSON.stringify(payload);
    res.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(body);
}

function dashboardHtml() {
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>QQ农场监控面板</title>
  <style>
    :root {
      --bg0: #130a2f;
      --bg1: #1d0f47;
      --bg2: #2f1062;
      --card: rgba(42, 26, 86, 0.64);
      --card2: rgba(47, 30, 92, 0.72);
      --line: rgba(255,255,255,0.16);
      --text: #f5eefe;
      --muted: #c5b6ea;
      --ok: #29d678;
      --warn: #ffd166;
      --pink: #f95cb8;
      --cyan: #56d7ff;
      --gold: #f2d35c;
      --shadow: 0 14px 26px rgba(4, 2, 22, 0.34);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      color: var(--text);
      font-family: "PingFang SC", "Microsoft YaHei", "Segoe UI", sans-serif;
      background:
        radial-gradient(circle at 10% 12%, rgba(249,92,184,.16), transparent 30%),
        radial-gradient(circle at 88% 18%, rgba(86,215,255,.12), transparent 28%),
        linear-gradient(140deg, var(--bg0), var(--bg1) 52%, var(--bg2));
      min-height: 100vh;
      padding: 22px;
    }
    .wrap {
      max-width: 1280px;
      margin: 0 auto;
      animation: up .55s cubic-bezier(.2,.7,.2,1);
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 16px;
      margin-bottom: 14px;
    }
    .titlebox { display: flex; align-items: center; gap: 12px; }
    .appicon {
      width: 42px; height: 42px; border-radius: 10px;
      display: grid; place-items: center;
      background: linear-gradient(130deg, #25145c, #4a1f90);
      border: 1px solid var(--line);
      box-shadow: var(--shadow);
      font-size: 20px;
    }
    h1 { margin: 0; font-size: 34px; letter-spacing: .5px; }
    .small { margin-top: 6px; color: var(--muted); font-size: 14px; }
    .statuspill {
      border: 1px solid var(--line);
      background: rgba(37, 77, 84, 0.45);
      color: #7ef0b0;
      border-radius: 999px;
      padding: 10px 16px;
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      gap: 8px;
    }
    .dot {
      width: 9px; height: 9px; border-radius: 50%;
      background: var(--ok);
      box-shadow: 0 0 0 0 rgba(41,214,120,.7);
      animation: pulse 2s infinite;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .card {
      border-radius: 16px;
      border: 1px solid var(--line);
      background: var(--card);
      box-shadow: var(--shadow);
      padding: 16px 18px;
      backdrop-filter: blur(6px);
      -webkit-backdrop-filter: blur(6px);
      min-height: 176px;
      position: relative;
      overflow: hidden;
    }
    .card::after {
      content: "";
      position: absolute;
      right: -40px;
      top: -35px;
      width: 120px;
      height: 120px;
      border-radius: 50%;
      background: radial-gradient(circle, rgba(255,255,255,.17), transparent 65%);
      pointer-events: none;
    }
    .card.alt { background: var(--card2); }
    .card.core {
      min-height: 150px;
      border-color: rgba(255,255,255,.2);
      background: linear-gradient(140deg, rgba(71,36,129,.62), rgba(39,21,83,.58));
    }
    .heading { font-size: 30px; font-weight: 800; margin: 3px 0 10px; letter-spacing: .2px; }
    .heading.kpi { font-size: 26px; }
    .meta { color: var(--muted); font-size: 14px; margin-bottom: 10px; }
    .line {
      display: flex;
      justify-content: space-between;
      align-items: center;
      color: #efe7ff;
      margin: 8px 0;
      font-size: 16px;
    }
    .k { color: #c9bbea; }
    .v { font-weight: 700; }
    .progress {
      margin-top: 8px;
      width: 100%;
      height: 10px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,.14);
      background: rgba(13,6,35,.4);
      overflow: hidden;
    }
    .bar {
      width: 0%;
      height: 100%;
      transition: width .45s ease;
      background: linear-gradient(90deg, var(--pink), #ff9ed9);
    }
    .bar.exp { background: linear-gradient(90deg, #f4c433, #ffdd74); }
    .tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      border-radius: 999px;
      border: 1px solid rgba(255,255,255,.14);
      padding: 6px 11px;
      font-size: 13px;
      color: #d6cbf3;
      background: rgba(14,7,34,.35);
    }
    .online { color: #7ef0b0; }
    .offline { color: #ff8e8e; }
    .gold { color: var(--gold); }
    .footer {
      margin-top: 14px;
      color: var(--muted);
      display: flex;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 6px;
      font-size: 13px;
    }
    .calc-panel {
      grid-column: span 3;
      min-height: 0;
      padding: 18px 18px 16px;
    }
    .calc-title {
      font-size: 24px;
      font-weight: 800;
      margin: 0 0 12px;
    }
    .calc-controls {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 10px;
    }
    .field {
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px;
      background: rgba(20, 10, 43, 0.35);
      padding: 8px 10px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      min-height: 68px;
    }
    .field-label {
      font-size: 12px;
      color: #cabcec;
      letter-spacing: .2px;
    }
    .field input,
    .field select {
      width: 100%;
      border-radius: 8px;
      border: 1px solid rgba(255,255,255,.16);
      background: rgba(255,255,255,.08);
      color: var(--text);
      padding: 6px 8px;
      font-size: 14px;
      outline: none;
    }
    .btn-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-bottom: 10px;
    }
    .btn {
      border: 1px solid rgba(255,255,255,.2);
      color: #fff;
      border-radius: 10px;
      padding: 8px 12px;
      cursor: pointer;
      font-weight: 700;
      font-size: 13px;
      transition: transform .15s ease, opacity .15s ease;
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .btn:hover { transform: translateY(-1px); opacity: .94; }
    .btn.primary { background: linear-gradient(135deg, #6a43df, #824bff); }
    .btn.success { background: linear-gradient(135deg, #2d9e6f, #3dbf83); }
    .btn.ghost { background: linear-gradient(135deg, #74406f, #8f4d86); }
    .calc-summary {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 10px;
      margin-bottom: 8px;
    }
    .calc-chip {
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px;
      background: rgba(19, 9, 40, .35);
      padding: 8px 10px;
      font-size: 13px;
      color: #d6cbf3;
    }
    .calc-list {
      margin-top: 6px;
      color: #d6cbf3;
      font-size: 14px;
      line-height: 1.5;
      border: 1px solid rgba(255,255,255,.14);
      border-radius: 10px;
      background: rgba(19, 9, 40, .28);
      padding: 9px 10px;
      min-height: 86px;
    }
    @media (max-width: 1040px) {
      .grid { grid-template-columns: 1fr 1fr; }
      .calc-panel { grid-column: span 2; }
    }
    @media (max-width: 720px) {
      body { padding: 14px; }
      .grid { grid-template-columns: 1fr; }
      h1 { font-size: 28px; }
      .header { align-items: flex-start; flex-direction: column; }
      .calc-panel { grid-column: span 1; }
      .calc-controls { grid-template-columns: 1fr; }
      .calc-summary { grid-template-columns: 1fr; }
    }
    @keyframes up {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(41,214,120,.7); }
      70% { box-shadow: 0 0 0 10px rgba(41,214,120,0); }
      100% { box-shadow: 0 0 0 0 rgba(41,214,120,0); }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="titlebox">
          <div class="appicon">🌾</div>
          <div>
            <h1>QQ农场监控面板</h1>
            <div class="small">上次更新：<span id="lastUpdate">--</span></div>
          </div>
        </div>
      </div>
      <div class="statuspill"><span class="dot"></span><span id="healthTop">连接中...</span></div>
    </div>

    <div class="grid">
      <section class="card core">
        <div class="meta">账号概览</div>
        <div class="heading kpi" id="name">未登录</div>
        <div class="line"><span class="k">平台</span><span class="v" id="platform">-</span></div>
        <div class="line"><span class="k">等级</span><span class="v">Lv.<span id="level">0</span></span></div>
      </section>

      <section class="card core alt">
        <div class="meta">经验核心指标</div>
        <div class="heading kpi"><span id="expPerHour">计算中</span></div>
        <div class="line"><span class="k">经验/小时</span><span class="v">样本 <span id="sampleWindow">0</span>s</span></div>
        <div class="line"><span class="k">本次增量</span><span class="v">+<span id="expGain">0</span></span></div>
      </section>

      <section class="card core alt">
        <div class="meta">金币核心指标</div>
        <div class="heading kpi gold">💰 <span id="gold">0</span></div>
        <div class="line"><span class="k">金币/小时</span><span class="v gold"><span id="goldPerHour">计算中</span></span></div>
        <div class="line"><span class="k">本次增量</span><span class="v gold">+<span id="goldGain">0</span></span></div>
      </section>

      <section class="card core">
        <div class="meta">运行核心指标</div>
        <div class="heading kpi" id="uptime">0秒</div>
        <div class="line"><span class="k">启动时间</span><span class="v" id="startedAt">--</span></div>
        <div class="line"><span class="k">最近同步</span><span class="v" id="lastSync">--</span></div>
      </section>

      <section class="card">
        <div class="heading">等级进度</div>
        <div class="line"><span class="k">总经验</span><span class="v"><span id="exp">0</span></span></div>
        <div class="line"><span class="k">当前等级进度</span><span class="v"><span id="expCurrent">0</span> / <span id="expNeeded">0</span></span></div>
        <div class="progress"><div class="bar" id="levelBar"></div></div>
        <div class="line"><span class="k">升级预估</span><span class="v" id="etaLevel">--</span></div>
      </section>

      <section class="card alt">
        <div class="heading" id="connState">连接状态</div>
        <div class="line"><span class="k">监控健康分</span><span class="v" id="healthScore">100%</span></div>
        <div class="line"><span class="k">请求延迟</span><span class="v" id="latency">0 ms</span></div>
        <div class="line"><span class="k">连续失败次数</span><span class="v" id="failCount">0</span></div>
        <div class="line"><span class="k">最近错误</span><span class="v" id="lastError">无</span></div>
      </section>

      <section class="card alt">
        <div class="heading">速率可信度</div>
        <div class="line"><span class="k">速率状态</span><span class="v" id="rateStatus">计算中</span></div>
        <div class="line"><span class="k">最小采样窗口</span><span class="v"><span id="rateWindow">120</span>s</span></div>
        <div class="line"><span class="k">服务时间</span><span class="v" id="serverTime">--</span></div>
        <div class="progress"><div class="bar exp" id="goldBar"></div></div>
      </section>

      <section class="card calc-panel">
        <div class="calc-title">FarmCalc 整合计算器</div>
        <div class="calc-controls">
          <label class="field">
            <span class="field-label">等级</span>
            <input id="calcLevel" type="number" min="1" max="200" value="27"/>
          </label>
          <label class="field">
            <span class="field-label">地块数</span>
            <input id="calcLands" type="number" min="1" max="200" value="18"/>
          </label>
          <label class="field">
            <span class="field-label">策略模式</span>
            <select id="calcMode"><option value="normalFert">普通肥</option><option value="noFert">不施肥</option></select>
          </label>
        </div>
        <div class="btn-row">
          <button id="btnCalc" class="btn primary">计算推荐</button>
          <button id="btnApplyTop" class="btn success">应用Top1到机器人</button>
          <button id="btnClearManual" class="btn ghost">切回自动</button>
          <a id="calcFullLink" href="/calc" target="_blank" class="btn">打开完整 FarmCalc 页面</a>
        </div>
        <div class="calc-controls" style="margin-top:2px;">
          <label class="field">
            <span class="field-label">自己农场巡查间隔(秒)</span>
            <input id="farmIntervalSec" type="number" min="1" value="1"/>
          </label>
          <label class="field">
            <span class="field-label">好友农场巡查间隔(秒)</span>
            <input id="friendIntervalSec" type="number" min="1" value="10"/>
          </label>
          <label class="field">
            <span class="field-label">操作</span>
            <button id="btnApplyIntervals" class="btn success" style="width:100%;">实时应用巡查间隔</button>
          </label>
        </div>
        <div class="calc-summary">
          <div class="calc-chip">当前机器人策略：<b id="strategyNow">自动</b></div>
          <div class="calc-chip">推荐Top1：<b id="calcTop1">-</b></div>
          <div class="calc-chip">当前巡查：<b id="currentIntervals">农场1s / 好友10s</b></div>
        </div>
        <div id="calcList" class="calc-list"></div>
      </section>
    </div>

    <div class="footer">
      <span>数据源：进程内状态 + 计算指标</span>
      <span id="clock">--:--:--</span>
    </div>
  </div>

  <script>
    const token = new URLSearchParams(location.search).get('token') || '';
    let loading = false;
    let failedCount = 0;
    let lastErrorAt = '';
    let lastCalcResult = null;

    function withToken(path) {
      if (!token) return path;
      return path + (path.indexOf('?') >= 0 ? '&' : '?') + 'token=' + encodeURIComponent(token);
    }

    async function postJson(path, payload) {
      const res = await fetch(withToken(path), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      if (!res.ok) throw new Error('http_' + res.status);
      return res.json();
    }

    function fmtNum(n) {
      return Number(n || 0).toLocaleString('zh-CN');
    }

    function fmtClock(d) {
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      return h + ':' + m + ':' + s;
    }

    function fmtUptime(sec) {
      const days = Math.floor(sec / 86400);
      const hours = Math.floor((sec % 86400) / 3600);
      const mins = Math.floor((sec % 3600) / 60);
      const s = sec % 60;
      if (days > 0) return days + '天 ' + hours + '时 ' + mins + '分';
      if (hours > 0) return hours + '时 ' + mins + '分 ' + s + '秒';
      return mins + '分 ' + s + '秒';
    }

    function fmtEta(hours) {
      if (!Number.isFinite(hours) || hours <= 0) return '--';
      if (hours < 1) return Math.max(1, Math.round(hours * 60)) + ' 分钟';
      if (hours < 24) return hours.toFixed(1) + ' 小时';
      return (hours / 24).toFixed(1) + ' 天';
    }

    function setOnlineState(ok) {
      const top = document.getElementById('healthTop');
      const state = document.getElementById('connState');
      const health = document.getElementById('healthScore');
      const score = ok ? Math.max(60, 100 - failedCount * 8) : 0;
      top.textContent = ok ? '已连接' : '连接异常';
      state.textContent = ok ? '在线' : '离线';
      state.className = ok ? 'heading online' : 'heading offline';
      health.textContent = score + '%';
      document.getElementById('failCount').textContent = String(failedCount);
      document.getElementById('lastError').textContent = ok ? '无' : (lastErrorAt || '刚刚');
    }

    function render(data, latency) {
      const s = data.status || {};
      const m = data.metrics || {};
      const strategy = data.strategy || {};
      const settings = data.settings || {};
      const now = new Date();
      const up = Number(data.uptimeSec || 0);
      const start = new Date(now.getTime() - up * 1000);
      const rateReady = !!m.rateReady;
      const sampleWindow = Math.min(up, Number(m.rateWindowSec || 120));
      const remainExp = Math.max(0, Number(m.expNeeded || 0) - Number(m.expCurrent || 0));
      const etaHours = rateReady && Number(m.expPerHour || 0) > 0 ? (remainExp / Number(m.expPerHour)) : NaN;

      document.getElementById('lastUpdate').textContent = now.toLocaleString('zh-CN', { hour12: false });
      document.getElementById('platform').textContent = s.platform || '-';
      document.getElementById('name').textContent = s.name || '未登录';
      document.getElementById('level').textContent = String(s.level || 0);
      document.getElementById('exp').textContent = fmtNum(s.exp || 0);
      document.getElementById('gold').textContent = fmtNum(s.gold || 0);

      document.getElementById('expGain').textContent = fmtNum(m.expGain || 0);
      document.getElementById('goldGain').textContent = fmtNum(m.goldGain || 0);
      document.getElementById('expPerHour').textContent = rateReady ? fmtNum(m.expPerHour || 0) : '计算中';
      document.getElementById('goldPerHour').textContent = rateReady ? fmtNum(m.goldPerHour || 0) : '计算中';
      document.getElementById('expCurrent').textContent = fmtNum(m.expCurrent || 0);
      document.getElementById('expNeeded').textContent = fmtNum(m.expNeeded || 0);
      document.getElementById('etaLevel').textContent = rateReady ? fmtEta(etaHours) : '样本不足';
      document.getElementById('sampleWindow').textContent = String(sampleWindow);
      document.getElementById('rateWindow').textContent = String(Number(m.rateWindowSec || 120));
      document.getElementById('rateStatus').textContent = rateReady ? '稳定' : '计算中';
      const modeText = strategy.mode === 'noFert' ? '不施肥' : '普通肥';
      const sourceText = strategy.source === 'manual' ? '手动' : '自动';
      const lastSeedText = strategy.lastDecision && strategy.lastDecision.seedId
        ? ('种子#' + strategy.lastDecision.seedId + (strategy.lastDecision.seedName ? ' ' + strategy.lastDecision.seedName : ''))
        : '无';
      const seedText = strategy.manualSeedId
        ? ('种子#' + strategy.manualSeedId + (strategy.manualSeedName ? ' ' + strategy.manualSeedName : ''))
        : lastSeedText;
      document.getElementById('strategyNow').textContent = sourceText + ' / ' + modeText + ' / ' + seedText;
      const farmSec = Number(settings.farmIntervalSec || 1);
      const friendSec = Number(settings.friendIntervalSec || 10);
      document.getElementById('currentIntervals').textContent = '农场' + farmSec + 's / 好友' + friendSec + 's';
      document.getElementById('farmIntervalSec').value = String(farmSec);
      document.getElementById('friendIntervalSec').value = String(friendSec);

      document.getElementById('uptime').textContent = fmtUptime(up);
      document.getElementById('startedAt').textContent = start.toLocaleString('zh-CN', { hour12: false });
      document.getElementById('lastSync').textContent = now.toLocaleString('zh-CN', { hour12: false });
      document.getElementById('serverTime').textContent = data.serverTime ? fmtClock(new Date(data.serverTime)) : '--';
      document.getElementById('latency').textContent = Math.max(0, latency) + ' ms';
      document.getElementById('clock').textContent = fmtClock(now);
      const levelBar = Math.max(5, Math.min(100, Number(m.expProgress || 0)));
      const goldBar = Math.max(5, Math.min(100, Number(m.goldRateProgress || 0)));

      document.getElementById('levelBar').style.width = levelBar + '%';
      document.getElementById('goldBar').style.width = goldBar + '%';
    }

    function renderCalcResult(payload) {
      lastCalcResult = payload;
      const best = payload.best || null;
      const modeText = payload.mode === 'noFert' ? '不施肥' : '普通肥';
      document.getElementById('calcTop1').textContent = best ? (best.name + ' (#' + best.seedId + ')') : '无';
      const list = (payload.candidates || []).slice(0, 5).map((x, i) => {
        return (i + 1) + '. ' + x.name + ' (#' + x.seedId + ')  ' + Number(x.expPerHour || 0).toFixed(2) + ' exp/h';
      }).join('<br>');
      document.getElementById('calcList').innerHTML = '<div style="margin-bottom:6px;font-weight:700;color:#f5eefe;">模式：' + modeText + '</div>' + (list || '无候选');
    }

    async function calculateStrategy() {
      const level = Number(document.getElementById('calcLevel').value) || 1;
      const lands = Number(document.getElementById('calcLands').value) || 18;
      const mode = document.getElementById('calcMode').value || 'normalFert';
      const res = await fetch(withToken('/api/calc?level=' + encodeURIComponent(level) + '&lands=' + encodeURIComponent(lands) + '&mode=' + encodeURIComponent(mode) + '&top=10'), { cache: 'no-store' });
      if (!res.ok) throw new Error('calc_failed');
      const payload = await res.json();
      renderCalcResult(payload);
      return payload;
    }

    async function applyTop1() {
      if (!lastCalcResult || !lastCalcResult.best) {
        await calculateStrategy();
      }
      const best = lastCalcResult && lastCalcResult.best;
      if (!best) return;
      const mode = document.getElementById('calcMode').value || 'normalFert';
      await postJson('/api/strategy', {
        mode,
        manualSeedId: best.seedId,
        manualSeedName: best.name,
      });
      await tick();
    }

    async function clearManualStrategy() {
      const mode = document.getElementById('calcMode').value || 'normalFert';
      await postJson('/api/strategy', {
        mode,
        clearManual: true,
      });
      await tick();
    }

    async function applyIntervals() {
      const farmIntervalSec = Number(document.getElementById('farmIntervalSec').value) || 1;
      const friendIntervalSec = Number(document.getElementById('friendIntervalSec').value) || 1;
      await postJson('/api/settings', {
        farmIntervalSec,
        friendIntervalSec,
      });
      await tick();
    }

    async function tick() {
      if (loading) return;
      loading = true;
      const t0 = Date.now();
      try {
        const res = await fetch(withToken('/api/state'), { cache: 'no-store' });
        if (!res.ok) throw new Error('fetch failed');
        const data = await res.json();
        failedCount = Math.max(0, failedCount - 1);
        render(data, Date.now() - t0);
        setOnlineState(true);
      } catch (e) {
        failedCount += 1;
        lastErrorAt = new Date().toLocaleString('zh-CN', { hour12: false });
        setOnlineState(false);
      } finally {
        loading = false;
      }
    }

    document.getElementById('btnCalc').addEventListener('click', () => {
      calculateStrategy().catch(() => {});
    });
    document.getElementById('btnApplyTop').addEventListener('click', () => {
      applyTop1().catch(() => {});
    });
    document.getElementById('btnClearManual').addEventListener('click', () => {
      clearManualStrategy().catch(() => {});
    });
    document.getElementById('btnApplyIntervals').addEventListener('click', () => {
      applyIntervals().catch(() => {});
    });
    document.getElementById('calcFullLink').href = withToken('/calc/');

    tick();
    calculateStrategy().catch(() => {});
    setInterval(tick, 2000);
  </script>
</body>
</html>`;
}

function getRequestToken(req, parsed) {
    const fromQuery = parsed.searchParams.get('token') || '';
    if (fromQuery) return fromQuery;

    const auth = req.headers.authorization || '';
    if (auth.startsWith('Bearer ')) {
        return auth.slice(7).trim();
    }
    return '';
}

function ensureAuthorized(req, res, parsed) {
    if (!DASHBOARD_TOKEN) return true;

    const token = getRequestToken(req, parsed);
    if (token === DASHBOARD_TOKEN) return true;

    if (parsed.pathname === '/') {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Dashboard token required. Use ?token=YOUR_TOKEN');
        return false;
    }

    sendJson(res, { error: 'Unauthorized' }, 401);
    return false;
}

function handleRequest(req, res) {
    const parsed = new URL(req.url || '/', 'http://127.0.0.1');
    if (!ensureAuthorized(req, res, parsed)) return;

    if (parsed.pathname.startsWith('/calc')) {
        const target = resolveFarmCalcFile(parsed.pathname);
        if (!target) {
            sendJson(res, { error: 'Not Found' }, 404);
            return;
        }
        serveFile(res, target);
        return;
    }

    if (parsed.pathname === '/') {
        res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
        });
        res.end(dashboardHtml());
        return;
    }

    if (parsed.pathname === '/api/state') {
        const uptimeSec = Math.floor((Date.now() - state.startedAt) / 1000);
        sendJson(res, {
            status: state.status,
            uptimeSec,
            metrics: buildMetrics(uptimeSec),
            strategy: getStrategyConfig(),
            settings: getRuntimeSettings(),
            lastLogId: state.logs.length ? state.logs[state.logs.length - 1].id : 0,
            serverTime: Date.now(),
        });
        return;
    }

    if (parsed.pathname === '/api/settings' && req.method === 'GET') {
        sendJson(res, getRuntimeSettings());
        return;
    }

    if (parsed.pathname === '/api/settings' && req.method === 'POST') {
        readJsonBody(req)
            .then(body => {
                const settings = updateRuntimeSettings(body || {});
                sendJson(res, settings);
            })
            .catch(err => {
                const msg = err && err.message ? err.message : 'invalid_json';
                sendJson(res, { error: msg }, 400);
            });
        return;
    }

    if (parsed.pathname === '/api/calc') {
        const level = Number(parsed.searchParams.get('level') || state.status.level || 1);
        const lands = Number(parsed.searchParams.get('lands') || 18);
        const mode = parsed.searchParams.get('mode') === 'noFert' ? 'noFert' : 'normalFert';
        const top = Math.max(1, Math.min(50, Number(parsed.searchParams.get('top') || 10)));
        try {
            sendJson(res, getCalcPayload(level, lands, mode, top));
        } catch (e) {
            sendJson(res, { error: e.message || 'calc_failed' }, 500);
        }
        return;
    }

    if (parsed.pathname === '/api/strategy' && req.method === 'GET') {
        sendJson(res, getStrategyConfig());
        return;
    }

    if (parsed.pathname === '/api/strategy' && req.method === 'POST') {
        readJsonBody(req)
            .then(body => {
                const snapshot = updateStrategyConfig(body || {});
                sendJson(res, snapshot);
            })
            .catch(() => {
                sendJson(res, { error: 'invalid_json' }, 400);
            });
        return;
    }

    if (parsed.pathname === '/api/logs') {
        const since = Number(parsed.searchParams.get('since') || 0);
        const logs = getLogsSince(since);
        sendJson(res, {
            logs,
            lastLogId: state.logs.length ? state.logs[state.logs.length - 1].id : 0,
        });
        return;
    }

    sendJson(res, { error: 'Not Found' }, 404);
}

function startDashboardServer(options = {}) {
    if (server) {
        return { enabled: true, port: listenPort };
    }

    const desiredPort = Number(options.port) || 0;
    server = http.createServer(handleRequest);
    server.listen(desiredPort, '0.0.0.0', () => {
        const addr = server.address();
        listenPort = addr && addr.port ? addr.port : desiredPort;
        console.log(`[面板] 已启动 http://0.0.0.0:${listenPort}`);
    });

    server.on('error', err => {
        console.error('[面板] 启动失败:', err.message);
    });

    return { enabled: true, port: desiredPort };
}

function stopDashboardServer() {
    if (!server) return;
    server.close();
    server = null;
    listenPort = 0;
}

module.exports = {
    addLog,
    updateStatus,
    getStrategyConfig,
    updateStrategyConfig,
    recordStrategyDecision,
    startDashboardServer,
    stopDashboardServer,
};
