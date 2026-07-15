'use strict';

// 로그 파싱 · 비용 계산 · 집계 (electron 비의존 — node 단독 테스트 가능)

const fs = require('fs');
const path = require('path');

// ─── 가격 모델 (USD per MTok) ────────────────────────────────────────────────
// cacheR = 캐시 읽기, cacheW5m/cacheW1h = 캐시 쓰기(5분/1시간 TTL)
// Claude: 읽기 0.1×in, 쓰기 1.25×in(5m) / 2×in(1h)
// OpenAI: prompt_tokens에 cached 포함 → 파싱 시 분리, 캐시 쓰기 과금 없음
const PRICING = {
  // Claude (2026-06 기준)
  'claude-fable-5':   { in: 10.0, out: 50.0, cacheR: 1.0,   cacheW5m: 12.5,  cacheW1h: 20.0 },
  'claude-mythos':    { in: 10.0, out: 50.0, cacheR: 1.0,   cacheW5m: 12.5,  cacheW1h: 20.0 },
  'claude-opus-4-8':  { in: 5.0,  out: 25.0, cacheR: 0.5,   cacheW5m: 6.25,  cacheW1h: 10.0 },
  'claude-opus-4-7':  { in: 5.0,  out: 25.0, cacheR: 0.5,   cacheW5m: 6.25,  cacheW1h: 10.0 },
  'claude-opus-4-6':  { in: 5.0,  out: 25.0, cacheR: 0.5,   cacheW5m: 6.25,  cacheW1h: 10.0 },
  'claude-opus-4-5':  { in: 5.0,  out: 25.0, cacheR: 0.5,   cacheW5m: 6.25,  cacheW1h: 10.0 },
  'claude-opus-4-1':  { in: 15.0, out: 75.0, cacheR: 1.5,   cacheW5m: 18.75, cacheW1h: 30.0 },
  'claude-opus-4':    { in: 15.0, out: 75.0, cacheR: 1.5,   cacheW5m: 18.75, cacheW1h: 30.0 },
  'claude-sonnet-5':  { in: 3.0,  out: 15.0, cacheR: 0.3,   cacheW5m: 3.75,  cacheW1h: 6.0 },
  'claude-sonnet-4':  { in: 3.0,  out: 15.0, cacheR: 0.3,   cacheW5m: 3.75,  cacheW1h: 6.0 },
  'claude-haiku-4-5': { in: 1.0,  out: 5.0,  cacheR: 0.1,   cacheW5m: 1.25,  cacheW1h: 2.0 },
  'claude-haiku-4':   { in: 1.0,  out: 5.0,  cacheR: 0.1,   cacheW5m: 1.25,  cacheW1h: 2.0 },
  'claude-haiku-3-5': { in: 0.8,  out: 4.0,  cacheR: 0.08,  cacheW5m: 1.0,   cacheW1h: 1.6 },
  // OpenAI / Codex (2026-06 기준)
  'gpt-5.5':          { in: 5.0,  out: 30.0, cacheR: 0.5,   cacheW5m: 0, cacheW1h: 0 },
  'gpt-5.4':          { in: 2.5,  out: 15.0, cacheR: 0.25,  cacheW5m: 0, cacheW1h: 0 },
  'gpt-5.1':          { in: 1.25, out: 10.0, cacheR: 0.125, cacheW5m: 0, cacheW1h: 0 },
  'gpt-5':            { in: 1.25, out: 10.0, cacheR: 0.125, cacheW5m: 0, cacheW1h: 0 },
  'codex-auto-review':{ in: 5.0,  out: 30.0, cacheR: 0.5,   cacheW5m: 0, cacheW1h: 0 },
  'gpt-4o-mini':      { in: 0.15, out: 0.6,  cacheR: 0.075, cacheW5m: 0, cacheW1h: 0 },
  'gpt-4o':           { in: 2.5,  out: 10.0, cacheR: 1.25,  cacheW5m: 0, cacheW1h: 0 },
  'o3':               { in: 2.0,  out: 8.0,  cacheR: 0.5,   cacheW5m: 0, cacheW1h: 0 },
  'o4-mini':          { in: 1.1,  out: 4.4,  cacheR: 0.275, cacheW5m: 0, cacheW1h: 0 },
  '_default_claude':  { in: 3.0,  out: 15.0, cacheR: 0.3,   cacheW5m: 3.75, cacheW1h: 6.0 },
  '_default_codex':   { in: 5.0,  out: 30.0, cacheR: 0.5,   cacheW5m: 0, cacheW1h: 0 },
};

// 구체적인(긴) 키가 먼저 매칭되도록 정렬.
// 키 뒤에 버전 문자가 이어지면 다른 모델이므로 매칭 제외
// (예: 'gpt-5' 키가 'gpt-5.5'에 매칭되는 것 방지 — 날짜 접미사 '-20250101'은 허용)
const PRICING_MATCHERS = Object.keys(PRICING)
  .filter(k => !k.startsWith('_'))
  .sort((a, b) => b.length - a.length)
  .map(k => ({ key: k, re: new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?![\\d.])') }));

function getPrice(model, provider) {
  if (model) {
    const m = model.toLowerCase();
    const hit = PRICING_MATCHERS.find(x => x.re.test(m));
    if (hit) return PRICING[hit.key];
  }
  return provider === 'codex' ? PRICING['_default_codex'] : PRICING['_default_claude'];
}

function calcCost(e) {
  const p = getPrice(e.model, e.provider);
  const M = 1_000_000;
  const c1h = e.cacheCreate1h || 0;
  const c5m = Math.max(0, (e.cacheCreate || 0) - c1h);
  return (
    (e.input     / M) * p.in +
    (e.output    / M) * p.out +
    (e.cacheRead / M) * p.cacheR +
    (c5m / M) * p.cacheW5m +
    (c1h / M) * p.cacheW1h
  );
}

// 캐시가 없었다면 정가로 냈을 금액과의 차 (읽기 절감분만, 쓰기 프리미엄 차감)
function calcCacheSavings(e) {
  const p = getPrice(e.model, e.provider);
  const M = 1_000_000;
  const c1h = e.cacheCreate1h || 0;
  const c5m = Math.max(0, (e.cacheCreate || 0) - c1h);
  return (
    (e.cacheRead / M) * (p.in - p.cacheR) -
    (c5m / M) * Math.max(0, p.cacheW5m - p.in) -
    (c1h / M) * Math.max(0, p.cacheW1h - p.in)
  );
}

// ─── 로컬 타임존 날짜 키 ─────────────────────────────────────────────────────
function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ─── 파일 캐시 (mtime+size 기준 증분 파싱) ───────────────────────────────────
const fileCache = new Map(); // path -> { mtimeMs, size, entries }

function walkJsonlFiles(dir, out) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const item of items) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) { walkJsonlFiles(full, out); continue; }
    if (item.name.endsWith('.jsonl') || item.name.endsWith('.json')) out.push(full);
  }
}

function readFileCached(file, parseFn) {
  let stat;
  try { stat = fs.statSync(file); } catch { return []; }
  const cached = fileCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.entries;
  }
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const entries = parseFn(text);
  fileCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, entries });
  return entries;
}

// ─── Claude Code JSONL ───────────────────────────────────────────────────────
// 어시스턴트 메시지 1건이 콘텐츠 블록 수만큼 여러 줄로 중복 기록되므로
// message.id + requestId 로 반드시 dedup (중복 제거는 aggregate 단계에서 전역 수행)
function parseClaudeFile(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    const usage = obj.message?.usage || obj.usage || obj.response?.usage;
    if (!usage) continue;

    const model = obj.message?.model || obj.model || 'claude-unknown';
    if (model === '<synthetic>') continue;

    const ts = obj.timestamp || obj.created_at || obj.time;
    const breakdown = usage.cache_creation;
    const cacheCreate = usage.cache_creation_input_tokens != null
      ? Number(usage.cache_creation_input_tokens)
      : Number(breakdown?.ephemeral_5m_input_tokens || 0) + Number(breakdown?.ephemeral_1h_input_tokens || 0);
    entries.push({
      provider: 'claude',
      model,
      ts: ts ? new Date(ts).getTime() : 0,
      input:        Number(usage.input_tokens || 0),
      output:       Number(usage.output_tokens || 0),
      cacheRead:    Number(usage.cache_read_input_tokens || 0),
      cacheCreate,
      cacheCreate1h: Number(usage.cache_creation?.ephemeral_1h_input_tokens || 0),
      dedupKey: obj.message?.id ? `${obj.message.id}:${obj.requestId || ''}` : null,
    });
  }
  return entries;
}

// ─── Codex CLI JSONL ─────────────────────────────────────────────────────────
// event_msg/token_count 이벤트의 total_token_usage(세션 누적치) 델타로 집계.
// 같은 요청의 이벤트가 여러 번 재기록돼도 누적치 기준이라 이중 계산이 없다.
// 모델명은 직전 turn_context.payload.model 에서 추출.
function parseCodexFile(text) {
  const entries = [];
  let model = 'gpt-unknown';
  let prev = { input: 0, cached: 0, output: 0 };

  for (const line of text.split('\n')) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (obj.type === 'turn_context' && obj.payload?.model) {
      model = obj.payload.model;
      continue;
    }
    if (obj.type === 'session_meta' && obj.payload?.model) {
      model = obj.payload.model;
      continue;
    }

    // 구버전 스키마 (top-level usage)
    if (obj.usage && (obj.usage.prompt_tokens != null || obj.usage.completion_tokens != null)) {
      const cached = Number(obj.usage.prompt_tokens_details?.cached_tokens || 0);
      entries.push({
        provider: 'codex',
        model: obj.model || model,
        ts: obj.created ? obj.created * 1000 : (obj.timestamp ? new Date(obj.timestamp).getTime() : 0),
        input:  Math.max(0, Number(obj.usage.prompt_tokens || 0) - cached),
        output: Number(obj.usage.completion_tokens || 0),
        cacheRead: cached,
        cacheCreate: 0,
        cacheCreate1h: 0,
        dedupKey: null,
      });
      continue;
    }

    // 신버전 스키마 (event_msg → token_count)
    const info = obj.payload?.type === 'token_count' ? obj.payload.info : null;
    const tot = info?.total_token_usage;
    if (!tot) continue;

    const cur = {
      input:  Number(tot.input_tokens || 0),
      cached: Number(tot.cached_input_tokens || 0),
      output: Number(tot.output_tokens || 0),
    };
    const dInput  = Math.max(0, cur.input - prev.input);
    const dCached = Math.max(0, cur.cached - prev.cached);
    const dOutput = Math.max(0, cur.output - prev.output);
    prev = cur;
    if (dInput === 0 && dOutput === 0) continue;

    entries.push({
      provider: 'codex',
      model,
      ts: obj.timestamp ? new Date(obj.timestamp).getTime() : 0,
      input:  Math.max(0, dInput - dCached), // OpenAI input_tokens는 cached 포함
      output: dOutput,
      cacheRead: dCached,
      cacheCreate: 0,
      cacheCreate1h: 0,
      dedupKey: null,
    });
  }
  return entries;
}

function parseClaudeLogs(dir) {
  const files = [];
  walkJsonlFiles(dir, files);
  const all = [];
  for (const f of files) {
    if (!f.endsWith('.jsonl')) continue;
    all.push(...readFileCached(f, parseClaudeFile));
  }
  return all;
}

function parseCodexLogs(dir) {
  const files = [];
  walkJsonlFiles(dir, files);
  const all = [];
  for (const f of files) all.push(...readFileCached(f, parseCodexFile));
  return all;
}

// ─── 집계 ─────────────────────────────────────────────────────────────────────
function aggregate(entries) {
  const now = Date.now();
  const DAY = 86400_000;
  const sessionCutoff = now - 5 * 3600_000;
  const weekCutoff = now - 7 * DAY;

  // 모델 통계용 기간 경계 — PERIOD 섹션과 동일하게 로컬 자정 기준 (오늘 포함 7일/30일)
  const todayStart = new Date(now);
  todayStart.setHours(0, 0, 0, 0);
  const modelWkStart = todayStart.getTime() - 6 * DAY;
  const modelMoStart = todayStart.getTime() - 29 * DAY;

  // 최근 30일은 0으로 미리 채움 (차트 연속성)
  const daily = {};
  for (let i = 29; i >= 0; i--) {
    daily[dateKey(new Date(now - i * DAY))] = mkDay();
  }

  const heatmap = {};
  const modelStats = { week: {}, month: {}, all: {} };
  const seen = new Set();

  function addModel(bucket, mKey, e, cost) {
    if (!bucket[mKey]) bucket[mKey] = { input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0, requests: 0 };
    const ms = bucket[mKey];
    ms.input += e.input;
    ms.output += e.output;
    ms.cacheRead += e.cacheRead;
    ms.cacheCreate += e.cacheCreate;
    ms.cost += cost;
    ms.requests += 1;
  }

  let sessionTokens = 0, sessionCost = 0;
  let weekTokens = 0, weekCost = 0;
  let totalInput = 0, totalCacheRead = 0, totalCacheCreate = 0;
  let cacheSavings = 0;

  for (const e of entries) {
    if (e.dedupKey) {
      if (seen.has(e.dedupKey)) continue;
      seen.add(e.dedupKey);
    }

    const cost = calcCost(e);
    const tokens = e.input + e.output + e.cacheRead + e.cacheCreate;
    const key = dateKey(new Date(e.ts));

    if (!daily[key]) daily[key] = mkDay();
    const d = daily[key];
    d.input += e.input;
    d.output += e.output;
    d.cacheRead += e.cacheRead;
    d.cacheCreate += e.cacheCreate;
    d.cost += cost;
    d.requests += 1;
    d.prov[e.provider].tokens += tokens;
    d.prov[e.provider].cost += cost;

    heatmap[key] = (heatmap[key] || 0) + tokens;

    const mKey = `${e.provider}/${e.model}`;
    addModel(modelStats.all, mKey, e, cost);
    if (e.ts >= modelMoStart) addModel(modelStats.month, mKey, e, cost);
    if (e.ts >= modelWkStart) addModel(modelStats.week, mKey, e, cost);

    totalInput += e.input;
    totalCacheRead += e.cacheRead;
    totalCacheCreate += e.cacheCreate;
    cacheSavings += calcCacheSavings(e);

    if (e.ts >= sessionCutoff) { sessionTokens += tokens; sessionCost += cost; }
    if (e.ts >= weekCutoff)    { weekTokens += tokens;    weekCost += cost; }
  }

  const denom = totalInput + totalCacheRead + totalCacheCreate;
  const cacheHitRate = denom > 0 ? (totalCacheRead / denom) * 100 : 0;

  return {
    daily, heatmap, modelStats,
    sessionTokens, sessionCost, weekTokens, weekCost,
    cacheHitRate, cacheSavings,
    todayKey: dateKey(new Date(now)),
  };
}

function mkDay() {
  return {
    input: 0, output: 0, cacheRead: 0, cacheCreate: 0, cost: 0, requests: 0,
    prov: { claude: { tokens: 0, cost: 0 }, codex: { tokens: 0, cost: 0 } },
  };
}

module.exports = { PRICING, getPrice, calcCost, parseClaudeLogs, parseCodexLogs, aggregate, dateKey };
