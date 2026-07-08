'use strict';

// ─── 상태 ─────────────────────────────────────────────────────────────────────
const state = {
  provider:     'all',
  chartRange:   7,
  chartMetric:  'tokens',
  heatYear:     new Date().getFullYear(),
  periodMode:   'week',
  periodOffset: 0,
  currency:     'usd',      // 'usd' | 'krw'
  compact:      false,
  fx:           { rate: 1520, source: 'fallback' },
  data:         null,
};

// 데이터 시작 연도 (히트맵 네비게이션 하한)
const MIN_HEAT_YEAR = 2026;

// SESSION / WEEK 한도 (Claude Code 기준, 직접 조정 가능)
const LIMITS = {
  sessionTokens: 500_000,   // 5h 세션 토큰 경고선
  weekCost:      50,        // 주간 비용 경고선 ($)
};

const DAY = 86400_000;

// ─── 포맷터 ───────────────────────────────────────────────────────────────────
function fmtTok(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const fmt = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  if (abs >= 1e12) return fmt(n / 1e12) + 'T';
  if (abs >= 1e9)  return fmt(n / 1e9)  + 'B';
  if (abs >= 1e6)  return fmt(n / 1e6)  + 'M';
  if (abs >= 1e3)  return fmt(n / 1e3)  + 'k';
  return String(Math.round(n));
}

function fmtMoney(usd) {
  if (usd == null || isNaN(usd)) return '—';
  const sign = usd < 0 ? '-' : '';
  const a = Math.abs(usd);
  if (state.currency === 'krw') {
    const w = a * state.fx.rate;
    if (w >= 1e6) return sign + '₩' + (w / 1e6).toFixed(2) + 'M';
    if (w >= 1e3) return sign + '₩' + (w / 1e3).toFixed(1) + 'k';
    return sign + '₩' + Math.round(w);
  }
  if (a >= 1000) return sign + '$' + (a / 1000).toFixed(2) + 'k';
  if (a >= 10)   return sign + '$' + a.toFixed(2);
  if (a >= 0.1)  return sign + '$' + a.toFixed(3);
  return sign + '$' + a.toFixed(4);
}

function fmtDate(isoKey) {
  const [, m, d] = isoKey.split('-');
  return `${m}/${d}`;
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function setupCanvas(canvas, cssW, cssH) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = cssW + 'px';
  canvas.style.height = cssH + 'px';
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

// ─── 데이터 로드 ──────────────────────────────────────────────────────────────
async function loadData() {
  try {
    const data = await window.api.getData(state.provider);
    state.data = data;
    render();
  } catch (err) {
    console.error('loadData failed:', err); // 이전 데이터 유지
  }
}

async function loadFx() {
  try {
    state.fx = await window.api.getFx();
  } catch { /* 기본값 유지 */ }
  renderFxInfo();
}

async function loadPaths() {
  const paths = await window.api.getLogPaths();
  const el = document.getElementById('logPaths');
  el.innerHTML = `
    <div class="log-path-item">
      <span class="log-path-badge ${paths.claudeExists ? 'found' : 'missing'}">${paths.claudeExists ? 'OK' : 'N/A'}</span>
      <span class="log-path-text">CLAUDE ${esc(paths.claude)}</span>
    </div>
    <div class="log-path-item">
      <span class="log-path-badge ${paths.codexExists ? 'found' : 'missing'}">${paths.codexExists ? 'OK' : 'N/A'}</span>
      <span class="log-path-text">CODEX ${esc(paths.codex)}</span>
    </div>
  `;
}

function renderFxInfo() {
  const el = document.getElementById('fxInfo');
  const { rate, source } = state.fx;
  el.innerHTML = source === 'live'
    ? `FX <span class="fx-live">1 USD = ₩${Math.round(rate).toLocaleString()}</span> (live)`
    : `FX 1 USD = ₩${Math.round(rate).toLocaleString()} (고정)`;
}

// ─── 전체 렌더 ────────────────────────────────────────────────────────────────
function render() {
  const d = state.data;
  if (!d) return;

  renderToday(d);
  renderSessionBars(d);
  renderDailyChart(d);
  renderHeatmap();
  renderModels(d);
  renderDonut(d);
  renderPeriod(d);

  document.getElementById('statusDot').classList.toggle('live', d.sessionTokens > 0);
}

// ─── 오늘 요약 (일반 + 컴팩트 바 동시 갱신) ──────────────────────────────────
function renderToday(d) {
  const row = d.daily[d.todayKey];
  const tokens = row ? row.input + row.output + row.cacheRead + row.cacheCreate : 0;
  const tok = fmtTok(tokens);
  const cost = fmtMoney(row ? row.cost : 0);
  const reqs = row ? String(row.requests) : '0';
  document.getElementById('todayTok').textContent  = tok;
  document.getElementById('todayCost').textContent = cost;
  document.getElementById('todayReqs').textContent = reqs;
  document.getElementById('compactTok').textContent  = tok;
  document.getElementById('compactCost').textContent = cost;
  document.getElementById('compactReqs').textContent = reqs;
}

// ─── 세션 바 ─────────────────────────────────────────────────────────────────
function renderSessionBars(d) {
  const sPct = Math.min(100, (d.sessionTokens / LIMITS.sessionTokens) * 100);
  const wPct = Math.min(100, (d.weekCost / LIMITS.weekCost) * 100);

  const sBar = document.getElementById('sessionBar');
  const wBar = document.getElementById('weekBar');
  sBar.style.width = sPct + '%';
  wBar.style.width = wPct + '%';
  sBar.classList.toggle('danger', sPct > 80);
  wBar.classList.toggle('danger', wPct > 80);

  document.getElementById('sessionPct').textContent = sPct.toFixed(0) + '%';
  document.getElementById('weekPct').textContent    = wPct.toFixed(0) + '%';
  document.getElementById('sessionTok').textContent  = fmtTok(d.sessionTokens);
  document.getElementById('sessionCost').textContent = fmtMoney(d.sessionCost);
  document.getElementById('weekCost').textContent    = fmtMoney(d.weekCost);
}

// ─── 일별 스택 바 차트 (claude / codex) ──────────────────────────────────────
function renderDailyChart(d) {
  const wrap = document.getElementById('dailyChart');
  const n = state.chartRange;
  const now = Date.now();

  // 최근 n일 키를 직접 생성 (빠진 날짜 없이 연속)
  const slice = [];
  for (let i = n - 1; i >= 0; i--) slice.push(dateKey(new Date(now - i * DAY)));

  const isCost = state.chartMetric === 'cost';
  const valOf = (row, prov) => {
    if (!row) return 0;
    if (prov) return isCost ? row.prov[prov].cost : row.prov[prov].tokens;
    return isCost ? row.cost : row.input + row.output + row.cacheRead + row.cacheCreate;
  };

  const totals = slice.map(k => valOf(d.daily[k]));
  const maxVal = Math.max(...totals, isCost ? 0.0001 : 1);
  const fmt = isCost ? fmtMoney : fmtTok;
  const showDates = n <= 10;
  wrap.classList.toggle('has-dates', showDates);

  let html = `<div class="chart-y-labels">
    <span class="chart-y-label">${fmt(maxVal)}</span>
    <span class="chart-y-label">${fmt(maxVal / 2)}</span>
    <span class="chart-y-label">0</span>
  </div>
  <div class="chart-cols">`;

  slice.forEach((k, i) => {
    const row = d.daily[k];
    const total = totals[i];
    const cVal = valOf(row, 'claude');
    const xVal = valOf(row, 'codex');
    const cPct = (cVal / maxVal) * 100;
    const xPct = (xVal / maxVal) * 100;
    const hasData = total > 0;

    let tip = `${fmtDate(k)} · ${fmt(total)}`;
    if (hasData && state.provider === 'all') {
      const parts = [];
      if (cVal > 0) parts.push(`claude ${fmt(cVal)}`);
      if (xVal > 0) parts.push(`codex ${fmt(xVal)}`);
      tip += `<br><span class="tip-muted">${parts.join(' · ')}</span>`;
    }
    if (row && row.requests > 0) tip += `<br><span class="tip-muted">${row.requests} reqs</span>`;

    // 창 밖 오버플로 방지: 좌/중/우 1/3 지점에 따라 앵커 방향 결정
    const tipPos = i < slice.length / 3 ? 'tip-left' : i >= (slice.length * 2) / 3 ? 'tip-right' : '';

    html += `
      <div class="bar-container">
        <div class="bar-tooltip ${tipPos}">${tip}</div>
        <div class="bar-area">
          <div class="bar-stack" style="height:${hasData ? Math.max(cPct + xPct, 2) : 2}%">
            ${hasData
              ? `<div class="bar-seg bar-seg-claude" style="flex:${cVal}"></div>
                 <div class="bar-seg bar-seg-codex" style="flex:${xVal}"></div>`
              : '<div class="bar-seg bar-seg-empty" style="flex:1"></div>'}
          </div>
        </div>
        ${showDates ? `<span class="bar-date">${fmtDate(k)}</span>` : ''}
      </div>`;
  });
  html += '</div>';
  wrap.innerHTML = html;

  document.getElementById('chartLegend').style.display = state.provider === 'all' ? 'flex' : 'none';
}

// ─── 히트맵 ───────────────────────────────────────────────────────────────────
const HEAT_COLORS = ['#1e1e1e', '#1a3d26', '#22563b', '#2d7a54', '#4ade80'];

function getHeatLevel(val, maxVal) {
  if (!val || val <= 0) return 0;
  const ratio = val / maxVal;
  if (ratio < 0.15) return 1;
  if (ratio < 0.40) return 2;
  if (ratio < 0.70) return 3;
  return 4;
}

function buildYearGrid(year, heatmap) {
  const grid = {}; // week -> day -> tokens
  const end = new Date(year, 11, 31);
  const firstDay = new Date(year, 0, 1);
  firstDay.setDate(firstDay.getDate() - firstDay.getDay()); // 일요일 정렬

  const cur = new Date(firstDay);
  let week = 0;
  while (cur <= end) {
    const day = cur.getDay();
    if (!grid[week]) grid[week] = {};
    grid[week][day] = heatmap[dateKey(cur)] || 0;
    cur.setDate(cur.getDate() + 1);
    if (cur.getDay() === 0) week++;
  }
  return grid;
}

function renderHeatmap() {
  if (!state.data) return;
  const { heatmap } = state.data;
  const year = state.heatYear;
  document.getElementById('heatYear').textContent = year;

  const grid = buildYearGrid(year, heatmap);
  const weeks = Object.keys(grid).map(Number).sort((a, b) => a - b);

  // 표시 연도 내 최대값 기준으로 명암 대비
  let maxVal = 0;
  for (const w of weeks) {
    for (let day = 0; day < 7; day++) maxVal = Math.max(maxVal, grid[w][day] || 0);
  }
  maxVal = Math.max(maxVal, 1);

  renderHeatmap2D(grid, weeks, maxVal);
}

function heatCanvasWidth() {
  const wrap = document.getElementById('heatmapWrap');
  return Math.max(280, wrap.clientWidth || 380);
}

function renderHeatmap2D(grid, weeks, maxVal) {
  const cssW = heatCanvasWidth();
  const gap = 1;
  const cell = Math.max(4, Math.floor((cssW - weeks.length * gap) / weeks.length));
  const cssH = 7 * (cell + gap);
  const ctx = setupCanvas(document.getElementById('heatmap2d'), cssW, cssH);
  ctx.clearRect(0, 0, cssW, cssH);

  for (const w of weeks) {
    const days = grid[w] || {};
    for (let day = 0; day < 7; day++) {
      ctx.fillStyle = HEAT_COLORS[getHeatLevel(days[day] || 0, maxVal)];
      ctx.fillRect(w * (cell + gap), day * (cell + gap), cell, cell);
    }
  }
}

// ─── 모델 분석 ────────────────────────────────────────────────────────────────
function renderModels(d) {
  const el = document.getElementById('modelList');
  const entries = Object.entries(d.modelStats);
  if (!entries.length) { el.innerHTML = '<div class="empty">no data</div>'; return; }

  entries.sort((a, b) => b[1].cost - a[1].cost);

  let html = '';
  for (const [key, v] of entries.slice(0, 5)) {
    const [prov, ...modelParts] = key.split('/');
    const modelName = modelParts.join('/');
    const total = v.input + v.output + v.cacheRead + v.cacheCreate || 1;
    const inPct    = (v.input / total) * 100;
    const outPct   = (v.output / total) * 100;
    const cachePct = ((v.cacheRead + v.cacheCreate) / total) * 100;
    const provColor = prov === 'claude' ? 'var(--claude)' : 'var(--codex)';

    html += `
      <div class="model-row">
        <div class="model-name">
          <span class="model-name-label"><span class="model-prov" style="color:${provColor}">${esc(prov.toUpperCase())}</span>${esc(modelName)}</span>
          <span class="model-cost">${fmtMoney(v.cost)}</span>
        </div>
        <div class="token-bars">
          <div class="token-bar-input"  style="width:${inPct}%"></div>
          <div class="token-bar-output" style="width:${outPct}%"></div>
          <div class="token-bar-cache"  style="width:${cachePct}%"></div>
        </div>
        <div class="model-detail">
          <span class="model-detail-item">in <span>${fmtTok(v.input)}</span></span>
          <span class="model-detail-item">out <span>${fmtTok(v.output)}</span></span>
          <span class="model-detail-item">cache <span>${fmtTok(v.cacheRead + v.cacheCreate)}</span></span>
          <span class="model-detail-item">reqs <span>${v.requests}</span></span>
        </div>
      </div>`;
  }
  el.innerHTML = html;
}

// ─── 캐시 도넛 차트 ───────────────────────────────────────────────────────────
function renderDonut(d) {
  const size = 72;
  const ctx = setupCanvas(document.getElementById('donutChart'), size, size);
  ctx.clearRect(0, 0, size, size);

  const hit = Math.max(0, Math.min(100, d.cacheHitRate));
  const cx = size / 2, cy = size / 2, r = 29, inner = 19;

  function arc(start, end, color) {
    ctx.beginPath();
    ctx.moveTo(cx + inner * Math.cos(start), cy + inner * Math.sin(start));
    ctx.arc(cx, cy, r, start, end);
    ctx.arc(cx, cy, inner, end, start, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  const startAngle = -Math.PI / 2;
  const hitAngle = startAngle + (hit / 100) * 2 * Math.PI;
  arc(startAngle, hitAngle, '#4ade80');
  arc(hitAngle, startAngle + 2 * Math.PI, '#1e1e1e');

  ctx.fillStyle = '#e6e6e6';
  ctx.font = '600 13px ui-monospace, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(hit.toFixed(0) + '%', cx, cy);

  document.getElementById('cacheStats').innerHTML = `
    <div class="cache-stat-item">
      <span class="cache-stat-label">hit rate</span>
      <span class="cache-stat-val" style="color:var(--accent)">${hit.toFixed(1)}%</span>
    </div>
    <div class="cache-stat-item">
      <span class="cache-stat-label">miss rate</span>
      <span class="cache-stat-val">${(100 - hit).toFixed(1)}%</span>
    </div>
    <div class="cache-stat-item">
      <span class="cache-stat-label">${(d.cacheSavings || 0) >= 0 ? '캐시 절감액' : '캐시 순비용'}</span>
      <span class="cache-stat-val" style="color:${(d.cacheSavings || 0) >= 0 ? 'var(--accent)' : 'var(--warn)'}">${fmtMoney(d.cacheSavings || 0)}</span>
    </div>
  `;
}

// ─── 기간 네비게이션 ──────────────────────────────────────────────────────────
function renderPeriod(d) {
  const mode = state.periodMode;
  const isAll = mode === 'all';
  const span = (mode === 'week' ? 7 : 30) * DAY;
  const offset = state.periodOffset;

  // 로컬 자정 기준 경계 (오늘 포함) — all 모드는 전체 범위
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = isAll ? Infinity : today.getTime() + DAY - offset * span;   // exclusive
  const start = isAll ? -Infinity : end - span;

  let totInput = 0, totOutput = 0, totCache = 0, totCost = 0, totReqs = 0;
  for (const k of Object.keys(d.daily)) {
    const [y, m, dd] = k.split('-').map(Number);
    const t = new Date(y, m - 1, dd).getTime();
    if (t >= start && t < end) {
      const row = d.daily[k];
      totInput  += row.input;
      totOutput += row.output;
      totCache  += row.cacheRead + row.cacheCreate;
      totCost   += row.cost;
      totReqs   += row.requests;
    }
  }

  const fmtD = (t) => new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  document.getElementById('periodLabel').textContent =
    isAll        ? 'ALL TIME'
    : offset === 0 ? (mode === 'week' ? 'THIS WEEK' : 'THIS MONTH')
                   : `${fmtD(start)} – ${fmtD(end - DAY)}`;

  document.getElementById('periodPrev').disabled = isAll;
  document.getElementById('periodNext').disabled = isAll;

  document.getElementById('periodStats').innerHTML = `
    <div class="period-stat">
      <div class="period-stat-label">TOKENS</div>
      <div class="period-stat-val">${fmtTok(totInput + totOutput + totCache)}</div>
      <div class="period-stat-sub">${totReqs.toLocaleString()} requests</div>
    </div>
    <div class="period-stat">
      <div class="period-stat-label">COST</div>
      <div class="period-stat-val">${fmtMoney(totCost)}</div>
      <div class="period-stat-sub">~${totReqs ? fmtMoney(totCost / totReqs) : fmtMoney(0)}/req</div>
    </div>
    <div class="period-stat">
      <div class="period-stat-label">INPUT</div>
      <div class="period-stat-val">${fmtTok(totInput)}</div>
      <div class="period-stat-sub">tokens</div>
    </div>
    <div class="period-stat">
      <div class="period-stat-label">OUTPUT</div>
      <div class="period-stat-val">${fmtTok(totOutput)}</div>
      <div class="period-stat-sub">tokens</div>
    </div>
  `;
}

// ─── 이벤트 바인딩 ────────────────────────────────────────────────────────────
document.getElementById('btnCompact').onclick = () => {
  state.compact = !state.compact;
  document.getElementById('app').classList.toggle('compact', state.compact);
  const btn = document.getElementById('btnCompact');
  btn.textContent = state.compact ? '▴' : '─';
  btn.title = state.compact ? '펼치기' : '접기';
  window.api.setCompact(state.compact);
};
document.getElementById('btnClose').onclick = () => window.api.close();

document.getElementById('btnCurrency').onclick = () => {
  state.currency = state.currency === 'usd' ? 'krw' : 'usd';
  const btn = document.getElementById('btnCurrency');
  btn.textContent = state.currency.toUpperCase();
  btn.classList.toggle('krw', state.currency === 'krw');
  if (state.currency === 'krw') loadFx();
  render();
};

document.querySelectorAll('.tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    state.provider = tab.dataset.provider;
    loadData();
  };
});

document.querySelectorAll('[data-range]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('[data-range]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.chartRange = Number(btn.dataset.range);
    if (state.data) renderDailyChart(state.data);
  };
});

document.querySelectorAll('[data-metric]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('[data-metric]').forEach(b => b.classList.remove('active2'));
    btn.classList.add('active2');
    state.chartMetric = btn.dataset.metric;
    if (state.data) renderDailyChart(state.data);
  };
});

document.getElementById('heatPrev').onclick = () => {
  if (state.heatYear > MIN_HEAT_YEAR) { state.heatYear--; renderHeatmap(); }
};
document.getElementById('heatNext').onclick = () => {
  if (state.heatYear < new Date().getFullYear()) { state.heatYear++; renderHeatmap(); }
};

document.getElementById('periodPrev').onclick = () => { state.periodOffset++; if (state.data) renderPeriod(state.data); };
document.getElementById('periodNext').onclick = () => {
  if (state.periodOffset > 0) { state.periodOffset--; if (state.data) renderPeriod(state.data); }
};
document.querySelectorAll('[data-period]').forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll('[data-period]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.periodMode   = btn.dataset.period;
    state.periodOffset = 0;
    if (state.data) renderPeriod(state.data);
  };
});

// 파일 변경 감지 → 자동 리로드 (main 프로세스에서 디바운스됨)
window.api.onDataChanged(() => {
  loadData();
});

// ─── 휠 스크롤: 1틱 = 1페이지 ────────────────────────────────────────────────
(() => {
  const sb = document.getElementById('scrollBody');
  let animating = false;
  sb.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (animating || e.deltaY === 0) return;
    const pageH = sb.clientHeight;
    const pages = sb.querySelectorAll('.page').length;
    const cur = Math.round(sb.scrollTop / pageH);
    const next = Math.max(0, Math.min(pages - 1, cur + Math.sign(e.deltaY)));
    if (next === cur) return;
    animating = true;
    sb.scrollTo({ top: next * pageH, behavior: 'smooth' });
    setTimeout(() => { animating = false; }, 280);
  }, { passive: false });
})();

// ─── 초기 로드 ────────────────────────────────────────────────────────────────
(async () => {
  await loadData();
  await loadPaths();
  await loadFx();
  // 폴백 폴링: 사용량 60초 (실시간 갱신은 파일 감시가 담당), 환율 24시간
  setInterval(loadData, 60 * 1000);
  setInterval(loadFx, 24 * 60 * 60 * 1000);
})();
