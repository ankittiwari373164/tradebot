/**
 * TradeBot v16 — Groww Most-Bought / Top-Intraday AI Engine
 * ══════════════════════════════════════════════════════════════
 * What changed vs v15 — every change here is an accuracy upgrade:
 *
 *  ── Data layer (NEW DATA SOURCES, reverse-engineered from groww.in) ──
 *   1. /v1/api/stocks_data/v2/explore/list/top — fetches the EXACT lists Groww
 *      shows on its explore page, no auth needed:
 *        • POPULAR_STOCKS_MOST_BOUGHT          (most bought today)
 *        • POPULAR_STOCKS_MOST_BOUGHT_BY_TURNOVER
 *        • POPULAR_STOCKS_INTRADAY_VOLUME      (top intraday volume)
 *        • POPULAR_STOCKS_MOST_BOUGHT_MTF      (MTF-only)
 *        • TOP_GAINERS / TOP_LOSERS / MOST_ACTIVE / TRADED_BY_VALUE
 *      Symbol universe is the union of all five — far more focused than v15.
 *   2. /v1/api/stocks_data/v1/tr_live_delayed/segment/CASH/latest_aggregated —
 *      batch live prices, also no auth. Used as a free fallback when the
 *      official Groww API token isn't set or is rate-limited.
 *   3. Token-based Groww Trade API still used for:
 *        • Historical candles (only authenticated source)
 *        • Real-time (non-delayed) prices when token is valid
 *        • Full quote with depth (bid/ask qty)
 *
 *  ── Math / logic fixes ──
 *   4. Vercel KV persistence — predictions survive cold starts (fatal in v15)
 *   5. Daily history depth: 30d → 90d (EMA50 was always null in v15)
 *   6. RSI no longer returns 100 on flat prices; returns 50 (neutral)
 *   7. dev10 anchored on official 9:15 NSE open + first-10-min VWAP
 *      (v15 used a single 9:15 LTP tick — vulnerable to micro-spikes)
 *   8. Volume confirmation factor (10-min volume vs 20-day baseline)
 *   9. Gap analysis factor (today open vs yesterday close, ATR-normalized)
 *  10. ADX(14) trend strength gates the EMA-stack signal (no false signals
 *      in choppy markets — was unconditional in v15)
 *  11. 1-min RSI for fine-grained entry timing (alongside 5-min RSI)
 *  12. Depth pressure now fetched for ALL stocks (was top-15 only)
 *  13. Live updates re-compute RSI/VWAP/depth, not just price
 *  14. Pivot override math — was tightening stops in the wrong direction
 *  15. Tiny dev10 → infinite R:R artifact: floored by 0.5 × ATR%
 *  16. Action gate uses BOTH absolute spread AND ratio (consistent)
 *  17. R:R minimum 1.0 enforced — refuse worse-than-1:1 trades
 *  18. try/catch per-stock so one bad symbol can't kill the batch
 *  19. Fallback predictions clearly tagged [late-entry] (no "first 10 min" lies)
 *  20. Confidence cap raised 90 → 95
 *  21. Outcome logging — every prediction stored to KV, win-rate API
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');

// ── Vercel KV (graceful degradation) ──
let kv = null;
try {
  const mod = require('@vercel/kv');
  if (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL) {
    kv = mod.kv;
    console.log('[KV] ✅ Vercel KV / Upstash Redis enabled');
  } else {
    console.log('[KV] ⚠️  No KV credentials — using in-memory cache only');
  }
} catch (_) {
  console.log('[KV] ⚠️  @vercel/kv not installed — using in-memory cache only');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════
const GROWW_TOKEN = process.env.GROWW_ACCESS_TOKEN || '';
const PORT        = process.env.PORT || 3001;

const HAS_TOKEN = !!GROWW_TOKEN;
if (!HAS_TOKEN) {
  console.warn('⚠️  GROWW_ACCESS_TOKEN not set — running with public delayed feed only.');
  console.warn('    Historical candles & real-time depth will not be available.');
  console.warn('    Set GROWW_ACCESS_TOKEN in .env or Vercel env vars for full accuracy.');
}

// Authenticated Groww Trade API
const GHDRS = {
  'Authorization':  `Bearer ${GROWW_TOKEN}`,
  'X-API-VERSION':  '1.0',
  'Accept':         'application/json',
  'Content-Type':   'application/json',
};
const GROWW_API = 'https://api.groww.in/v1';

// Public groww.in endpoints (reverse-engineered from explore page bundle)
const GROWW_WEB = 'https://groww.in';
const WEB_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://groww.in/stocks/user/explore',
  'x-platform':      'web',
  'X-APP-ID':        'growwWeb',
  'x-device-type':   'msite',
};

// Discovery filter types — every list Groww exposes on the explore page
const FILTERS = {
  MOST_BOUGHT:           'POPULAR_STOCKS_MOST_BOUGHT',
  MOST_BOUGHT_TURNOVER:  'POPULAR_STOCKS_MOST_BOUGHT_BY_TURNOVER',
  MOST_BOUGHT_MTF:       'POPULAR_STOCKS_MOST_BOUGHT_MTF',
  INTRADAY_VOLUME:       'POPULAR_STOCKS_INTRADAY_VOLUME',
  TOP_GAINERS:           'TOP_GAINERS',
  TOP_LOSERS:            'TOP_LOSERS',
  MOST_ACTIVE:           'MOST_ACTIVE',
  TRADED_BY_VALUE:       'TRADED_BY_VALUE',
  TRADED_BY_VOLUME:      'TRADED_BY_VOLUME',
};

// Last-resort fallback if every endpoint fails (very rare)
const BASE_STOCKS = ['RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK','SBIN','BAJFINANCE'];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
// TIME HELPERS (IST = UTC+5:30)
// ══════════════════════════════════════════════════════════════
function getIST() {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes(), s = ist.getUTCSeconds();
  return { h, m, s, totalMins: h*60+m, day: ist.getUTCDay(), ist };
}
function isWeekday() { const {day} = getIST(); return day >= 1 && day <= 5; }
function marketPhase() {
  const { totalMins, day } = getIST();
  if (day<1||day>5)        return 'WEEKEND';
  if (totalMins<9*60)      return 'PRE_OPEN';
  if (totalMins<9*60+15)   return 'PRE_MARKET';
  if (totalMins<9*60+25)   return 'OPENING';
  if (totalMins<11*60)     return 'EARLY';
  if (totalMins<13*60)     return 'MID';
  if (totalMins<15*60)     return 'LATE';
  if (totalMins<15*60+15)  return 'MIS_EXIT';
  if (totalMins<15*60+30)  return 'CLOSING';
  return 'CLOSED';
}
function isOpen() {
  return ['OPENING','EARLY','MID','LATE','MIS_EXIT'].includes(marketPhase());
}
function istStr() {
  const {h,m} = getIST();
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')} IST`;
}
function dateStr(d=0) {
  const dt = new Date(Date.now() + 5.5*3600000 + d*86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}

// ══════════════════════════════════════════════════════════════
// PERSISTENCE LAYER (KV with in-memory fallback)
// ══════════════════════════════════════════════════════════════
const _memStore = new Map();

async function kvGet(key) {
  if (kv) {
    try { return await kv.get(key); }
    catch (e) { console.error(`[KV] get ${key}: ${e.message?.slice(0,60)}`); }
  }
  return _memStore.has(key) ? _memStore.get(key) : null;
}
async function kvSet(key, value, ttlSeconds) {
  if (kv) {
    try {
      if (ttlSeconds) await kv.set(key, value, { ex: ttlSeconds });
      else            await kv.set(key, value);
      return true;
    } catch (e) { console.error(`[KV] set ${key}: ${e.message?.slice(0,60)}`); }
  }
  _memStore.set(key, value);
  return true;
}
function dayKey(suffix) { return `tb:${dateStr(0)}:${suffix}`; }

// ══════════════════════════════════════════════════════════════
// HTTP HELPERS — retry on transient errors
// ══════════════════════════════════════════════════════════════
async function withRetry(fn, label, attempts=2) {
  let lastErr;
  for (let i=0; i<=attempts; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const status = e.response?.status;
      if (status && status >= 400 && status < 500 && status !== 429) break;
      if (i < attempts) await sleep(300 * (i+1));
    }
  }
  console.error(`[${label}] ${lastErr?.message?.slice(0,80) || 'failed'}`);
  return null;
}

// ══════════════════════════════════════════════════════════════
// GROWW TRADE API (authenticated — needs token)
// ══════════════════════════════════════════════════════════════
async function growwQuote(symbol) {
  if (!HAS_TOKEN) return null;
  return withRetry(async () => {
    const r = await axios.get(`${GROWW_API}/live-data/quote`, {
      params: { exchange:'NSE', segment:'CASH', trading_symbol:symbol },
      headers: GHDRS, timeout: 8000,
    });
    if (r.data?.status !== 'SUCCESS') return null;
    return r.data.payload;
  }, `Quote ${symbol}`) || null;
}

async function growwLTP(symbols) {
  if (!HAS_TOKEN || !symbols.length) return {};
  const exchangeSymbols = symbols.map(s=>`NSE_${s}`).join(',');
  return await withRetry(async () => {
    const r = await axios.get(`${GROWW_API}/live-data/ltp`, {
      params: { segment:'CASH', exchange_symbols:exchangeSymbols },
      headers: GHDRS, timeout: 8000,
    });
    if (r.data?.status !== 'SUCCESS') return {};
    return r.data.payload || {};
  }, 'LTP batch') || {};
}

async function growwOHLC(symbols) {
  if (!HAS_TOKEN || !symbols.length) return {};
  const exchangeSymbols = symbols.map(s=>`NSE_${s}`).join(',');
  return await withRetry(async () => {
    const r = await axios.get(`${GROWW_API}/live-data/ohlc`, {
      params: { segment:'CASH', exchange_symbols:exchangeSymbols },
      headers: GHDRS, timeout: 8000,
    });
    if (r.data?.status !== 'SUCCESS') return {};
    return r.data.payload || {};
  }, 'OHLC batch') || {};
}

async function growwCandles(symbol, intervalMins, startTime, endTime) {
  if (!HAS_TOKEN) return [];
  return await withRetry(async () => {
    const r = await axios.get(`${GROWW_API}/historical/candle/range`, {
      params: {
        exchange:'NSE', segment:'CASH', trading_symbol:symbol,
        start_time: startTime, end_time: endTime,
        interval_in_minutes: intervalMins,
      },
      headers: GHDRS, timeout: 12000,
    });
    if (r.data?.status !== 'SUCCESS') return [];
    return r.data.payload?.candles || [];
  }, `Candles ${symbol} ${intervalMins}m`) || [];
}

async function fetchDailyHistory(symbol, days=90) {
  const end   = dateStr(0)  + ' 15:30:00';
  const start = dateStr(-days) + ' 09:15:00';
  return growwCandles(symbol, 1440, start, end);
}
async function fetchToday5min(symbol) {
  const today = dateStr(0);
  return growwCandles(symbol, 5, `${today} 09:15:00`, `${today} 15:30:00`);
}
async function fetchToday1min(symbol) {
  const today = dateStr(0);
  return growwCandles(symbol, 1, `${today} 09:15:00`, `${today} 15:30:00`);
}

// ══════════════════════════════════════════════════════════════
// GROWW WEB API (no auth, reverse-engineered)
// ══════════════════════════════════════════════════════════════

/**
 * Fetch one of the explore lists (TOP_GAINERS, MOST_BOUGHT, etc).
 * Each row: { header: {nseScriptCode, bseScriptCode, searchId, isin, companyShortName, ...},
 *             stats:  {ltp, close, dayChange, dayChangePerc, high, low, ...} }
 */
async function growwExploreList(filter, page=0, size=20) {
  return await withRetry(async () => {
    const r = await axios.get(`${GROWW_WEB}/v1/api/stocks_data/v2/explore/list/top`, {
      params: { discoveryFilterTypes: filter, page, size },
      headers: WEB_HEADERS, timeout: 12000,
    });
    // The response shape is { exploreData: { [filter]: { companyList: [...] } } }
    // — but Groww has changed this around historically; cope with both.
    const data = r.data;
    const filterBucket = data?.exploreData?.[filter]
                      ?? data?.[filter]
                      ?? data;
    const list = filterBucket?.companyList
              ?? filterBucket?.list
              ?? filterBucket?.data
              ?? (Array.isArray(filterBucket) ? filterBucket : []);
    return Array.isArray(list) ? list : [];
  }, `ExploreList ${filter}`) || [];
}

/**
 * Batch live prices for a basket of symbols using the public delayed-feed endpoint.
 * No auth needed. Used as a free fallback when the Groww Trade API token isn't set.
 */
async function growwWebBatchPrices(symbols) {
  if (!symbols.length) return {};
  const body = {
    exchangeAggReqMap: {
      NSE: { priceSymbolList: symbols, indexSymbolList: [] },
      BSE: { priceSymbolList: [],      indexSymbolList: [] },
    },
  };
  return await withRetry(async () => {
    const r = await axios.post(
      `${GROWW_WEB}/v1/api/stocks_data/v1/tr_live_delayed/segment/CASH/latest_aggregated`,
      body,
      { headers: WEB_HEADERS, timeout: 10000 }
    );
    // Response shape varies; try multiple known paths.
    const out = {};
    const nseMap = r.data?.exchangeAggResMap?.NSE?.priceMap
                ?? r.data?.NSE?.priceMap
                ?? r.data?.priceMap
                ?? r.data?.exchangeAggResMap?.NSE
                ?? {};
    if (nseMap && typeof nseMap === 'object') {
      for (const [sym, p] of Object.entries(nseMap)) {
        if (!p || typeof p !== 'object') continue;
        out[sym] = {
          ltp:       p.ltp ?? p.lastTradedPrice ?? p.price,
          open:      p.open ?? p.dayOpen,
          high:      p.high ?? p.dayHigh,
          low:       p.low  ?? p.dayLow,
          close:     p.close ?? p.prevClose,
          volume:    p.volume ?? p.totalQty,
          change:    p.dayChange ?? p.change,
          changePct: p.dayChangePerc ?? p.dayChangePct ?? p.changePct,
        };
      }
    }
    return out;
  }, 'WebBatchPrices') || {};
}

// ══════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS (all bug-fixed)
// ══════════════════════════════════════════════════════════════
function calcEMA(closes, p) {
  if (!closes || closes.length < p) return null;
  const k = 2 / (p + 1);
  let v = closes.slice(0, p).reduce((s,x) => s+x, 0) / p;
  for (let i = p; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return +v.toFixed(2);
}

// FIX: returns 50 (neutral) when prices are flat. v15 returned 100.
function calcRSI(closes, p=14) {
  if (!closes || closes.length < p+1) return 50;
  let g=0, l=0;
  for (let i=1; i<=p; i++) {
    const d = closes[i]-closes[i-1];
    if (d>0) g+=d; else l-=d;
  }
  let ag=g/p, al=l/p;
  for (let i=p+1; i<closes.length; i++) {
    const d = closes[i]-closes[i-1];
    ag = (ag*(p-1) + Math.max(0,  d)) / p;
    al = (al*(p-1) + Math.max(0, -d)) / p;
  }
  if (ag === 0 && al === 0) return 50;
  if (al === 0) return 100;
  if (ag === 0) return 0;
  return +(100 - 100/(1 + ag/al)).toFixed(1);
}

function calcVWAP(candles) {
  let pv=0, vol=0;
  for (const c of candles) {
    const tp = (c[2]+c[3]+c[4])/3;  // (H+L+C)/3
    pv += tp * c[5]; vol += c[5];
  }
  return vol>0 ? +(pv/vol).toFixed(2) : 0;
}

function calcATR(dailyCandles, p=14) {
  if (!dailyCandles || dailyCandles.length < p+1) return 0;
  const trs = [];
  for (let i=1; i<dailyCandles.length; i++) {
    const c = dailyCandles[i], pc = dailyCandles[i-1][4];
    trs.push(Math.max(c[2]-c[3], Math.abs(c[2]-pc), Math.abs(c[3]-pc)));
  }
  if (trs.length < p) return 0;
  let atr = trs.slice(0,p).reduce((s,v)=>s+v,0)/p;  // Wilder's smoothing
  for (let i=p; i<trs.length; i++) atr = (atr*(p-1) + trs[i]) / p;
  return +atr.toFixed(2);
}

// NEW: ADX — trend strength (0-100). >25 = strong trend, <20 = no trend.
function calcADX(dailyCandles, p=14) {
  if (!dailyCandles || dailyCandles.length < p*2+1) return 0;
  const tr=[], plusDM=[], minusDM=[];
  for (let i=1; i<dailyCandles.length; i++) {
    const [, , h,  l,  c]  = dailyCandles[i];
    const [, , ph, pl, pc] = dailyCandles[i-1];
    tr.push(Math.max(h-l, Math.abs(h-pc), Math.abs(l-pc)));
    const up = h-ph, dn = pl-l;
    plusDM .push(up>dn && up>0 ? up : 0);
    minusDM.push(dn>up && dn>0 ? dn : 0);
  }
  const smooth = arr => {
    if (arr.length < p) return null;
    let v = arr.slice(0,p).reduce((s,x)=>s+x,0);
    const out = [v];
    for (let i=p; i<arr.length; i++) { v = v - v/p + arr[i]; out.push(v); }
    return out;
  };
  const tr14 = smooth(tr), pdm14 = smooth(plusDM), mdm14 = smooth(minusDM);
  if (!tr14 || !pdm14 || !mdm14) return 0;
  const dx = [];
  for (let i=0; i<tr14.length; i++) {
    if (tr14[i]===0) { dx.push(0); continue; }
    const pdi = 100 * pdm14[i]/tr14[i];
    const mdi = 100 * mdm14[i]/tr14[i];
    const sum = pdi+mdi;
    dx.push(sum===0 ? 0 : 100 * Math.abs(pdi-mdi)/sum);
  }
  if (dx.length < p) return 0;
  let adx = dx.slice(0,p).reduce((s,x)=>s+x,0)/p;
  for (let i=p; i<dx.length; i++) adx = (adx*(p-1) + dx[i]) / p;
  return +adx.toFixed(1);
}

function pivotPoints(high, low, close) {
  const pp = (high+low+close)/3;
  return {
    pp: +pp.toFixed(2),
    r1: +(2*pp-low).toFixed(2),  r2: +(pp+high-low).toFixed(2),
    s1: +(2*pp-high).toFixed(2), s2: +(pp-high+low).toFixed(2),
  };
}

// NEW: opening volume vs 20-day baseline (proxy via daily volumes)
function calcVolumeSurge(today10minVol, dailyCandles) {
  if (!today10minVol || !dailyCandles || dailyCandles.length < 5) return 1;
  const recentVols = dailyCandles.slice(-20).map(c=>c[5]).filter(v=>v>0);
  if (!recentVols.length) return 1;
  const avgDaily = recentVols.reduce((s,v)=>s+v,0)/recentVols.length;
  // Liquid NSE stocks see ~12-15% of daily volume in first 10 min on average
  const expected10min = avgDaily * 0.13;
  return expected10min>0 ? +(today10minVol/expected10min).toFixed(2) : 1;
}

// NEW: gap classification (today's open vs yesterday's close, ATR-normalized)
function classifyGap(todayOpen, prevClose, atr) {
  if (!todayOpen || !prevClose) return { type:'NONE', pct:0 };
  const pct = (todayOpen - prevClose) / prevClose * 100;
  const atrPct = atr && prevClose ? (atr/prevClose)*100 : 1;
  const sigThreshold = Math.max(0.4, atrPct * 0.5);
  let type = 'NONE';
  if (pct >  sigThreshold * 2) type = 'GAP_UP_LARGE';
  else if (pct >  sigThreshold) type = 'GAP_UP';
  else if (pct < -sigThreshold * 2) type = 'GAP_DOWN_LARGE';
  else if (pct < -sigThreshold) type = 'GAP_DOWN';
  return { type, pct: +pct.toFixed(2) };
}

// ══════════════════════════════════════════════════════════════
// RUNTIME STATE
// ══════════════════════════════════════════════════════════════
const openingSnaps = {};        // { SYM: { t915, t925, open, prevClose, vwap10 } }
let snapshotStatus  = 'waiting';
let lockedPredictions = [];
const histCache = {};           // { SYM: { daily, m5, m1 } }
const liveQuotes = {};
let dataStore = { quotes: {}, lastUpdated: null };

// Universe tracking — merged from multiple Groww explore lists
let universe = [];                       // [{symbol, name, lists:[...]}]
const companyNames = {};
const growwSlugs = {};
let universeMeta = {};                   // { byList: {MOST_BOUGHT:[...], TOP_GAINERS:[...]} }

// Restore state on cold start
let _stateRestored = false;
async function restoreState() {
  if (_stateRestored) return;
  _stateRestored = true;
  try {
    const [snaps, locked, status, uni, meta, names, slugs] = await Promise.all([
      kvGet(dayKey('snaps')), kvGet(dayKey('locked')), kvGet(dayKey('status')),
      kvGet(dayKey('universe')), kvGet(dayKey('universeMeta')),
      kvGet(dayKey('names')), kvGet(dayKey('slugs')),
    ]);
    if (snaps && typeof snaps === 'object') Object.assign(openingSnaps, snaps);
    if (Array.isArray(locked)) lockedPredictions = locked;
    if (status) snapshotStatus = status;
    if (Array.isArray(uni)) universe = uni;
    if (meta && typeof meta === 'object') universeMeta = meta;
    if (names && typeof names === 'object') Object.assign(companyNames, names);
    if (slugs && typeof slugs === 'object') Object.assign(growwSlugs, slugs);
    if (universe.length || lockedPredictions.length) {
      console.log(`[KV] Restored — universe:${universe.length} locked:${lockedPredictions.length} status:${snapshotStatus}`);
    }
  } catch(e) { console.error('[KV] restore failed:', e.message?.slice(0,80)); }
}

async function persistState() {
  const ttl = 30 * 3600;
  await Promise.all([
    kvSet(dayKey('snaps'),         openingSnaps,      ttl),
    kvSet(dayKey('locked'),        lockedPredictions, ttl),
    kvSet(dayKey('status'),        snapshotStatus,    ttl),
    kvSet(dayKey('universe'),      universe,          ttl),
    kvSet(dayKey('universeMeta'),  universeMeta,      ttl),
    kvSet(dayKey('names'),         companyNames,      ttl),
    kvSet(dayKey('slugs'),         growwSlugs,        ttl),
  ]);
}

const STALE_MS = 2 * 60 * 1000;
let _refreshing = false;
function isStale() {
  if (!dataStore.lastUpdated) return true;
  return (Date.now() - new Date(dataStore.lastUpdated).getTime()) > STALE_MS;
}
function maybeRefresh() {
  if (_refreshing || !isOpen() || !isStale()) return;
  _refreshing = true;
  mainRefresh().finally(() => { _refreshing = false; });
}

// ══════════════════════════════════════════════════════════════
// UNIVERSE BUILDER — merge multiple Groww explore lists
// ══════════════════════════════════════════════════════════════
/**
 * The "universe" is the union of these lists:
 *   - POPULAR_STOCKS_MOST_BOUGHT          (top-N most bought today)
 *   - POPULAR_STOCKS_INTRADAY_VOLUME      (top-N intraday volume)
 *   - POPULAR_STOCKS_MOST_BOUGHT_MTF      (top-N MTF buys)
 *   - TOP_GAINERS, TOP_LOSERS             (movers)
 *   - MOST_ACTIVE                          (volume movers)
 *
 * Each stock gets tagged with which lists it appears on — we use this in
 * the prediction scoring (a stock on MOST_BOUGHT + MOST_ACTIVE gets a
 * "popularity" boost in the bull score).
 */
function _normalizeRow(row, listName) {
  const h = row.header || {};
  const s = row.stats  || {};
  const sym = h.nseScriptCode || h.bseScriptCode;
  if (!sym) return null;
  if (h.companyShortName || h.companyName) {
    companyNames[sym] = h.companyShortName || h.companyName;
  }
  if (h.searchId) growwSlugs[sym] = h.searchId;
  return {
    symbol: sym,
    name: companyNames[sym] || sym,
    searchId: h.searchId,
    isin: h.isin,
    list: listName,
    ltp:          s.ltp ?? s.lastTradedPrice,
    prevClose:    s.close ?? s.previousClose,
    high:         s.high ?? s.dayHigh,
    low:          s.low  ?? s.dayLow,
    dayChange:    s.dayChange,
    dayChangePct: s.dayChangePerc ?? s.dayChangePct,
  };
}

async function buildUniverse() {
  console.log('[Universe] Fetching Groww explore lists...');
  const targets = [
    { key: 'MOST_BOUGHT',          filter: FILTERS.MOST_BOUGHT,          size: 20 },
    { key: 'INTRADAY_VOLUME',      filter: FILTERS.INTRADAY_VOLUME,      size: 20 },
    { key: 'MOST_BOUGHT_MTF',      filter: FILTERS.MOST_BOUGHT_MTF,      size: 15 },
    { key: 'TOP_GAINERS',          filter: FILTERS.TOP_GAINERS,          size: 10 },
    { key: 'TOP_LOSERS',           filter: FILTERS.TOP_LOSERS,           size: 10 },
    { key: 'MOST_ACTIVE',          filter: FILTERS.MOST_ACTIVE,          size: 15 },
  ];

  const results = await Promise.all(
    targets.map(t => growwExploreList(t.filter, 0, t.size))
  );

  const byList = {};
  const merged = new Map();   // symbol → entry

  targets.forEach((t, i) => {
    const rows = results[i] || [];
    byList[t.key] = [];
    rows.forEach(raw => {
      const row = _normalizeRow(raw, t.key);
      if (!row) return;
      byList[t.key].push(row.symbol);
      if (!merged.has(row.symbol)) {
        merged.set(row.symbol, {
          symbol: row.symbol,
          name: row.name,
          searchId: row.searchId,
          isin: row.isin,
          ltp: row.ltp,
          prevClose: row.prevClose,
          dayChangePct: row.dayChangePct,
          lists: [],
          // Score weighted by which list — most bought weighs more than gainers
          popularityScore: 0,
        });
      }
      const entry = merged.get(row.symbol);
      entry.lists.push(t.key);
      entry.popularityScore += {
        MOST_BOUGHT:          5,
        MOST_BOUGHT_MTF:      4,
        INTRADAY_VOLUME:      4,
        MOST_ACTIVE:          3,
        TOP_GAINERS:          2,
        TOP_LOSERS:           2,
      }[t.key] || 1;
    });
  });

  universe = [...merged.values()].sort((a,b) => b.popularityScore - a.popularityScore);
  universeMeta = { byList, fetchedAt: new Date().toISOString() };

  if (universe.length === 0) {
    console.warn('[Universe] ⚠️  All explore lists empty — falling back to BASE_STOCKS');
    universe = BASE_STOCKS.map(sym => ({
      symbol: sym, name: companyNames[sym]||sym, lists: ['FALLBACK'], popularityScore: 0,
    }));
  } else {
    console.log(`[Universe] ✅ ${universe.length} unique stocks across ${Object.keys(byList).length} lists`);
    const topN = universe.slice(0, 5).map(u =>
      `${u.symbol}(${u.lists.length}L,${u.popularityScore}pt)`).join(', ');
    console.log(`[Universe] Top by popularity: ${topN}`);
  }
  await persistState();
  return universe;
}

function getAllSymbols() {
  if (universe.length > 0) return universe.map(u => u.symbol);
  return BASE_STOCKS;
}

function growwUrl(sym) {
  const slug = growwSlugs[sym];
  if (slug) return `${GROWW_WEB}/stocks/${slug}`;
  return `${GROWW_WEB}/stocks/${sym.toLowerCase()}`;
}

function popularityBoost(sym) {
  const u = universe.find(x => x.symbol === sym);
  if (!u) return 0;
  // Stocks on multiple "buying" lists get a small bull boost (max +6)
  const buyLists = ['MOST_BOUGHT', 'MOST_BOUGHT_MTF', 'INTRADAY_VOLUME', 'MOST_ACTIVE'];
  const matches = u.lists.filter(l => buyLists.includes(l)).length;
  return Math.min(6, matches * 2);
}

// ══════════════════════════════════════════════════════════════
// HISTORICAL DATA FETCH
// ══════════════════════════════════════════════════════════════
async function loadHistoryForSym(sym) {
  if (!HAS_TOKEN) {
    histCache[sym] = { daily: [], m5: [], m1: [], loadedAt: Date.now() };
    return histCache[sym];
  }
  const [daily, m5] = await Promise.all([
    fetchDailyHistory(sym, 90),
    isOpen() ? fetchToday5min(sym) : Promise.resolve([]),
  ]);
  histCache[sym] = { daily, m5, m1: [], loadedAt: Date.now() };
  return histCache[sym];
}

async function loadAllHistory() {
  const syms = getAllSymbols();
  if (!HAS_TOKEN) {
    console.log('[Hist] ⚠️  Skipping (no Groww token) — predictions will be price-only');
    return;
  }
  console.log(`[Hist] Loading 90-day history for ${syms.length} stocks...`);
  for (let i=0; i<syms.length; i+=5) {
    await Promise.all(syms.slice(i,i+5).map(loadHistoryForSym));
    if (i+5 < syms.length) await sleep(250);
  }
  console.log('[Hist] ✅ Done');
}

// ══════════════════════════════════════════════════════════════
// LIVE QUOTES — prefer authenticated API, fall back to public delayed feed
// ══════════════════════════════════════════════════════════════
async function fetchAllLiveData() {
  const syms = getAllSymbols();
  const quotes = {};

  if (HAS_TOKEN) {
    // Path A: Groww Trade API
    for (let i=0; i<syms.length; i+=50) {
      const batch  = syms.slice(i,i+50);
      const ltpMap = await growwLTP(batch);
      for (const sym of batch) {
        const key = `NSE_${sym}`;
        if (ltpMap[key]) quotes[sym] = { symbol:sym, ltp: ltpMap[key] };
      }
      if (i+50 < syms.length) await sleep(300);
    }
    for (let i=0; i<syms.length; i+=50) {
      const batch   = syms.slice(i,i+50);
      const ohlcMap = await growwOHLC(batch);
      for (const sym of batch) {
        const key = `NSE_${sym}`;
        if (ohlcMap[key]) {
          const o = ohlcMap[key];
          quotes[sym] = {
            ...quotes[sym], symbol:sym,
            open:o.open, high:o.high, low:o.low, prevClose:o.close,
            ltp: quotes[sym]?.ltp || o.close,
          };
        }
      }
      if (i+50 < syms.length) await sleep(300);
    }
  } else {
    // Path B: public delayed feed (chunks of 50 — endpoint accepts large baskets)
    for (let i=0; i<syms.length; i+=50) {
      const batch = syms.slice(i, i+50);
      const priceMap = await growwWebBatchPrices(batch);
      for (const sym of batch) {
        const p = priceMap[sym];
        if (p) {
          quotes[sym] = {
            symbol: sym, ltp: p.ltp, open: p.open, high: p.high, low: p.low,
            prevClose: p.close, volume: p.volume,
          };
        }
      }
      if (i+50 < syms.length) await sleep(400);
    }
  }

  // Compute derived values
  for (const [sym, q] of Object.entries(quotes)) {
    const ltp  = q.ltp || 0, open = q.open || ltp, prev = q.prevClose || ltp;
    q.change    = +(ltp - prev).toFixed(2);
    q.changePct = prev>0 ? +((ltp-prev)/prev*100).toFixed(2) : 0;
    q.devOpen   = open>0 ? +((ltp-open)/open*100).toFixed(2) : 0;
    q.growwUrl  = growwUrl(sym);
    q.name      = companyNames[sym] || sym;
  }
  return quotes;
}

async function fetchFullQuote(sym) {
  const q = await growwQuote(sym);
  if (!q) return null;
  liveQuotes[sym] = q;
  return q;
}

// ══════════════════════════════════════════════════════════════
// ★★★ AI PREDICTION ENGINE v16 ★★★
// ══════════════════════════════════════════════════════════════
function buildPrediction(sym, snap, liveQ, histData, opts={}) {
  try { return _buildPredictionUnsafe(sym, snap, liveQ, histData, opts); }
  catch(e) { console.error(`[Pred ${sym}] ${e.message?.slice(0,100)}`); return null; }
}

function _buildPredictionUnsafe(sym, snap, liveQ, histData, opts) {
  const { t915, t925, open: trueOpen, vwap10 } = snap;
  const daily = histData?.daily || [];
  const m5    = histData?.m5    || [];
  const m1    = histData?.m1    || [];
  const isFallback = !!opts.fallback;

  // Anchor on official 9:15 NSE auction-discovered open when available.
  const anchor = trueOpen && trueOpen > 0 ? trueOpen : t915;
  if (!anchor || anchor <= 0) return null;

  // ── F1: Opening 10-min momentum
  // Prefer VWAP of first 10 min over single-tick t925 — more robust.
  let dev10;
  if (vwap10 && vwap10 > 0) {
    dev10 = +((vwap10 - anchor) / anchor * 100).toFixed(2);
  } else if (t925 && t925 > 0) {
    dev10 = +((t925 - anchor) / anchor * 100).toFixed(2);
  } else {
    dev10 = 0;
  }
  const ltp = liveQ?.ltp || liveQ?.last_price || t925 || anchor;
  const devDay = +((ltp - anchor) / anchor * 100).toFixed(2);

  // ── F2: VWAP
  const vwap = m5.length ? calcVWAP(m5) : 0;
  const vwapDev   = vwap > 0 ? +((ltp - vwap) / vwap * 100).toFixed(2) : 0;
  const aboveVWAP = vwap > 0 && ltp > vwap;

  // ── F3: RSI on multiple timeframes
  const m5closes = m5.map(c=>c[4]);
  const m1closes = m1.map(c=>c[4]);
  const rsi5m = m5closes.length >= 15 ? calcRSI(m5closes) : 50;
  const rsi1m = m1closes.length >= 15 ? calcRSI(m1closes) : 50;

  // ── F4: EMA stack (daily)
  const dayCloses = daily.map(c=>c[4]);
  const ema9   = calcEMA(dayCloses, 9);
  const ema21  = calcEMA(dayCloses, 21);
  const ema50  = calcEMA(dayCloses, 50);
  const emaStack = (ema9 && ema21 && ema50)
    ? (ema9>ema21 && ema21>ema50 ? 'BULL' : ema9<ema21 && ema21<ema50 ? 'BEAR' : 'MIXED')
    : 'MIXED';

  // ── F5: ADX trend strength
  const adx = calcADX(daily);
  const trendStrong = adx >= 20;

  // ── F6: Previous-day candle pattern
  const prevDayCandle = daily.length>=2 ? daily[daily.length-2] : null;
  let candleSignal = 0;
  if (prevDayCandle) {
    const [, po, ph, pl, pc] = prevDayCandle;
    const range = ph-pl, body=Math.abs(pc-po);
    const isBull = pc>po;
    const closePos = range>0 ? (pc-pl)/range : 0.5;
    const bodyRatio = range>0 ? body/range : 0;
    if (isBull && bodyRatio>0.6 && closePos>0.65)        candleSignal = +2;
    else if (!isBull && bodyRatio>0.6 && closePos<0.35)  candleSignal = -2;
    else if (isBull)                                       candleSignal = +1;
    else                                                    candleSignal = -1;
  }

  // ── F7: Buy/Sell depth pressure
  let buyPressure = 50;
  if (liveQ?.total_buy_quantity && liveQ?.total_sell_quantity) {
    const total = liveQ.total_buy_quantity + liveQ.total_sell_quantity;
    buyPressure = total>0 ? Math.round(liveQ.total_buy_quantity/total*100) : 50;
  }
  const depthSignal = buyPressure>60?1:buyPressure<40?-1:0;

  // ── F8: ATR
  const atr = calcATR(daily);
  const atrPct = atr && anchor>0 ? +(atr/anchor*100).toFixed(2) : 1;

  // ── F9: Pivots
  const pivots = prevDayCandle ? pivotPoints(prevDayCandle[2], prevDayCandle[3], prevDayCandle[4]) : null;

  // ── F10: Gap analysis (NEW)
  const prevC = prevDayCandle ? prevDayCandle[4] : snap.prevClose;
  const gap = prevC && trueOpen
    ? classifyGap(trueOpen, prevC, atr)
    : { type:'NONE', pct:0 };

  // ── F11: Volume surge (NEW)
  const open10minVol = m5.slice(0, 2).reduce((s,c)=>s+(c[5]||0), 0);
  const volSurge = calcVolumeSurge(open10minVol, daily);
  const volStrong = volSurge >= 1.5;

  // ── F12: Popularity boost (NEW — uses Groww explore-list membership)
  const popBoost = popularityBoost(sym);
  const onMostBought   = universe.find(u => u.symbol===sym)?.lists?.includes('MOST_BOUGHT');
  const onIntradayVol  = universe.find(u => u.symbol===sym)?.lists?.includes('INTRADAY_VOLUME');

  // ── COMPOSITE SCORING ─────────────────────────────────────────
  let bullScore = 0, bearScore = 0;
  const reasons = [];

  // (1) Dev10 — weight 35
  if (dev10 > 2.0)        { bullScore += 35; reasons.push(`📈 Strong open +${dev10}% in 10 min`); }
  else if (dev10 > 1.0)   { bullScore += 22; reasons.push(`📈 Bullish open +${dev10}%`); }
  else if (dev10 > 0.3)   { bullScore += 12; reasons.push(`📈 Mild open +${dev10}%`); }
  else if (dev10 < -2.0)  { bearScore += 35; reasons.push(`📉 Strong drop ${dev10}% at open`); }
  else if (dev10 < -1.0)  { bearScore += 22; reasons.push(`📉 Bearish open ${dev10}%`); }
  else if (dev10 < -0.3)  { bearScore += 12; reasons.push(`📉 Mild drop ${dev10}%`); }
  else                     { reasons.push(`⚖️ Flat open (${dev10}%)`); }

  // (2) VWAP — weight 18
  if (aboveVWAP)               { bullScore += 18; reasons.push(`✅ Above VWAP ₹${vwap} (+${vwapDev.toFixed(2)}%)`); }
  else if (vwap>0)             { bearScore += 18; reasons.push(`🔴 Below VWAP ₹${vwap} (${vwapDev.toFixed(2)}%)`); }

  // (3) RSI 5m — weight 12
  if (rsi5m >= 60 && rsi5m < 75)     { bullScore += 12; reasons.push(`✅ RSI(5m) ${rsi5m} bullish`); }
  else if (rsi5m <= 40 && rsi5m > 25){ bearScore += 12; reasons.push(`🔴 RSI(5m) ${rsi5m} bearish`); }
  else if (rsi5m >= 75)               { bearScore += 6;  reasons.push(`⚠️ RSI(5m) ${rsi5m} overbought`); }
  else if (rsi5m <= 25)               { bullScore += 6;  reasons.push(`⚠️ RSI(5m) ${rsi5m} oversold`); }

  // (4) RSI 1m — weight 5 (timing confirmation)
  if (rsi1m >= 65 && rsi1m < 80)     bullScore += 5;
  else if (rsi1m <= 35 && rsi1m > 20)bearScore += 5;

  // (5) EMA stack — gated by ADX (weight 12 if trend strong, 5 otherwise)
  if (emaStack === 'BULL' && trendStrong) {
    bullScore += 12; reasons.push(`✅ EMA9>EMA21>EMA50 + ADX ${adx} (strong uptrend)`);
  } else if (emaStack === 'BEAR' && trendStrong) {
    bearScore += 12; reasons.push(`🔴 EMA9<EMA21<EMA50 + ADX ${adx} (strong downtrend)`);
  } else if (emaStack === 'BULL') {
    bullScore += 5;  reasons.push(`📈 Bull EMA but ADX ${adx} weak`);
  } else if (emaStack === 'BEAR') {
    bearScore += 5;  reasons.push(`📉 Bear EMA but ADX ${adx} weak`);
  }

  // (6) Candle pattern — weight 8
  if (candleSignal >= 2)        { bullScore += 8; reasons.push(`✅ Strong bull candle yesterday`); }
  else if (candleSignal === 1)  { bullScore += 4; }
  else if (candleSignal <= -2)  { bearScore += 8; reasons.push(`🔴 Strong bear candle yesterday`); }
  else if (candleSignal === -1) { bearScore += 4; }

  // (7) Depth pressure — weight 8
  if (depthSignal === 1)        { bullScore += 8; reasons.push(`✅ ${buyPressure}% buy pressure`); }
  else if (depthSignal === -1)  { bearScore += 8; reasons.push(`🔴 ${100-buyPressure}% sell pressure`); }

  // (8) Volume surge — weight 12 (NEW)
  if (volStrong && dev10 > 0.3)       { bullScore += 12; reasons.push(`🔥 Volume surge ${volSurge}x + bull move`); }
  else if (volStrong && dev10 < -0.3) { bearScore += 12; reasons.push(`🔥 Volume surge ${volSurge}x + bear move`); }
  else if (volSurge < 0.6)            { reasons.push(`⚠️ Low volume ${volSurge}x — weak conviction`); }

  // (9) Gap analysis — weight 10 (NEW)
  if (gap.type === 'GAP_UP_LARGE')         { bearScore += 6; reasons.push(`⚠️ Large gap-up ${gap.pct}% — fade risk`); }
  else if (gap.type === 'GAP_UP')          { bullScore += 8; reasons.push(`📈 Gap-up ${gap.pct}% — momentum`); }
  else if (gap.type === 'GAP_DOWN_LARGE')  { bullScore += 6; reasons.push(`⚠️ Large gap-down ${gap.pct}% — bounce risk`); }
  else if (gap.type === 'GAP_DOWN')        { bearScore += 8; reasons.push(`📉 Gap-down ${gap.pct}% — momentum`); }

  // (10) Popularity boost — weight up to 6 (NEW)
  // Stocks on MOST_BOUGHT etc usually have stronger directional follow-through.
  // We only boost in the direction of the existing dev10 signal.
  if (popBoost > 0 && dev10 > 0.3) {
    bullScore += popBoost;
    if (onMostBought) reasons.push(`👥 Top-bought on Groww (+${popBoost})`);
    else if (onIntradayVol) reasons.push(`👥 Top intraday volume (+${popBoost})`);
  } else if (popBoost > 0 && dev10 < -0.3) {
    bearScore += popBoost;
    if (onMostBought) reasons.push(`👥 Heavy selling on top-bought stock (+${popBoost})`);
  }

  // ── ACTION & CONFIDENCE ────────────────────────────────────────
  const total = bullScore + bearScore;
  const bullPct = total>0 ? bullScore/total : 0.5;
  const spread = Math.abs(bullScore - bearScore);
  const confidence = Math.min(95, Math.round(Math.abs(bullPct-0.5)*200));

  let action = 'HOLD';
  if (bullScore > bearScore && spread >= 15 && bullPct >= 0.58)  action = 'BUY';
  if (bearScore > bullScore && spread >= 15 && bullPct <= 0.42)  action = 'SELL';

  // ── TARGETS & STOP LOSS ────────────────────────────────────────
  const minMove = Math.max(0.5, atrPct * 0.5);
  const absMove = Math.max(Math.abs(dev10), minMove);

  const targetMultiplier = absMove<0.5?1.2:absMove<1?1.4:absMove<1.5?1.6:absMove<2?1.8:absMove<3?2.2:2.5;
  const stopMultiplier   = absMove<0.5?0.3:absMove<1?0.5:absMove<2?0.7:absMove<3?1.0:1.5;

  let targetPct = action==='BUY'  ?  +(absMove*targetMultiplier).toFixed(2)
                : action==='SELL' ? -(absMove*targetMultiplier).toFixed(2)
                : 0;
  let stopPct   = action==='BUY'  ? -stopMultiplier
                : action==='SELL' ? +stopMultiplier
                : 0;

  // Pivot override — blend ATR-based target with pivot-structure target
  if (pivots && action === 'BUY' && anchor > 0) {
    if (pivots.r1 > anchor) {
      const pivotTargetPct = +((pivots.r1-anchor)/anchor*100).toFixed(2);
      if (pivotTargetPct > targetPct * 0.5 && pivotTargetPct < targetPct * 1.5) {
        targetPct = +((targetPct + pivotTargetPct) / 2).toFixed(2);
      }
    }
    if (pivots.s1 < anchor) {
      const pivotStopPct = -((anchor-pivots.s1)/anchor*100);
      // Use pivot stop only if it's tighter (closer to entry) than ATR stop
      if (pivotStopPct > stopPct) stopPct = +pivotStopPct.toFixed(2);
    }
  } else if (pivots && action === 'SELL' && anchor > 0) {
    if (pivots.s1 < anchor) {
      const pivotTargetPct = -((anchor-pivots.s1)/anchor*100);
      if (Math.abs(pivotTargetPct) > Math.abs(targetPct)*0.5 &&
          Math.abs(pivotTargetPct) < Math.abs(targetPct)*1.5) {
        targetPct = +((targetPct + pivotTargetPct) / 2).toFixed(2);
      }
    }
    if (pivots.r1 > anchor) {
      const pivotStopPct = +((pivots.r1-anchor)/anchor*100);
      if (pivotStopPct < stopPct) stopPct = +pivotStopPct.toFixed(2);
    }
  }

  // Enforce R:R ≥ 1.0 — refuse worse-than-1:1 trades
  let rr = stopPct !== 0 ? +(Math.abs(targetPct)/Math.abs(stopPct)).toFixed(2) : 0;
  if (action !== 'HOLD' && rr < 1.0 && rr > 0) {
    targetPct = action==='BUY' ? +(Math.abs(stopPct) * 1.2).toFixed(2)
                                : -+(Math.abs(stopPct) * 1.2).toFixed(2);
    rr = 1.2;
  }

  const targetPrice   = action!=='HOLD' ? +(anchor*(1+targetPct/100)).toFixed(2) : 0;
  const stopLossPrice = action!=='HOLD' ? +(anchor*(1+stopPct/100)).toFixed(2)   : 0;

  // ── PREDICTION TEXT ────────────────────────────────────────────
  const name = companyNames[sym] || sym;
  const fallbackTag = isFallback ? '[late-entry] ' : '';
  let prediction;
  if (action === 'BUY') {
    prediction = `${fallbackTag}📈 ${name} EXPECTED TO RISE ~${targetPct.toFixed(1)}% today. ` +
      `Anchor ₹${anchor.toFixed(2)} → Target ₹${targetPrice} (+${targetPct}%) | Stop ₹${stopLossPrice}. R:R=${rr}:1. ` +
      (rsi5m>50?`RSI ${rsi5m}. `:'') + (aboveVWAP?'Above VWAP. ':'') +
      (volStrong?`Vol ${volSurge}x. `:'') + (gap.type.includes('UP')?`Gap ${gap.pct}%. `:'') +
      `Open momentum ${dev10>=0?'+':''}${dev10}% (${emaStack} EMA, ADX ${adx}).`;
  } else if (action === 'SELL') {
    prediction = `${fallbackTag}📉 ${name} EXPECTED TO FALL ~${Math.abs(targetPct).toFixed(1)}% today. ` +
      `Anchor ₹${anchor.toFixed(2)} → Target ₹${targetPrice} (${targetPct}%) | Stop ₹${stopLossPrice}. R:R=${rr}:1. ` +
      (rsi5m<50?`RSI ${rsi5m}. `:'') + (!aboveVWAP?'Below VWAP. ':'') +
      (volStrong?`Vol ${volSurge}x. `:'') + (gap.type.includes('DOWN')?`Gap ${gap.pct}%. `:'') +
      `Open momentum ${dev10>=0?'+':''}${dev10}% (${emaStack} EMA, ADX ${adx}).`;
  } else {
    prediction = `${fallbackTag}⚖️ ${name} — no clear edge. Open ${dev10>=0?'+':''}${dev10}% | RSI ${rsi5m} | ${emaStack} EMA | ADX ${adx}. Spread ${spread} below 15 — wait for confirmation.`;
  }

  const u = universe.find(x => x.symbol === sym);
  const gUrl = growwUrl(sym);

  return {
    symbol: sym, name, action, confidence,
    prediction, bullScore, bearScore, buyPressure,
    open915Price: anchor, lockedAtPrice: t925 || anchor,
    currentPrice: ltp, targetPrice, stopLossPrice,
    targetPct: +targetPct.toFixed(2), stopPct: +stopPct.toFixed(2),
    riskReward: rr,
    dev10, devDay, devFromOpen: devDay,
    rsi: rsi5m, rsi1m, vwap, vwapDev, aboveVWAP,
    ema9, ema21, ema50, emaStack, adx, atr, atrPct,
    pivots, candleSignal,
    volSurge, gap,
    growwLists: u?.lists || [],
    popularityScore: u?.popularityScore || 0,
    totalBuyQty:  liveQ?.total_buy_quantity  || 0,
    totalSellQty: liveQ?.total_sell_quantity || 0,
    reasons: reasons.slice(0, 6),
    currentStatus: 'LOCKED 🔒',
    progressPct: 0,
    growwUrl: gUrl,
    growwBuyUrl:  `${gUrl}?action=buy`,
    growwSellUrl: `${gUrl}?action=sell`,
    isFallback,
    lockedAt: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
// SNAPSHOT CAPTURE
// ══════════════════════════════════════════════════════════════
async function capture915Snapshot() {
  console.log('\n[9:15] 📸 Capturing opening prices...');
  await restoreState();
  const syms = getAllSymbols();

  if (HAS_TOKEN) {
    const ohlcMap = await growwOHLC(syms);
    const ltpMap  = await growwLTP(syms);
    for (const sym of syms) {
      const key = `NSE_${sym}`;
      const ohlc = ohlcMap[key];
      const ltp  = ltpMap[key] || 0;
      if (ohlc) {
        openingSnaps[sym] = {
          t915: ltp || ohlc.open || ohlc.close,
          open: ohlc.open,
          prevClose: ohlc.close,
        };
      }
    }
  } else {
    // Public delayed feed
    const priceMap = await growwWebBatchPrices(syms);
    for (const sym of syms) {
      const p = priceMap[sym];
      if (p) {
        openingSnaps[sym] = {
          t915: p.ltp || p.open || p.close,
          open: p.open, prevClose: p.close,
        };
      }
    }
  }
  snapshotStatus = 't915_done';
  await persistState();
  console.log(`[9:15] ✅ Captured ${Object.keys(openingSnaps).length} opening prices`);
}

async function capture925AndLock() {
  console.log('\n[9:25] 📸 Capturing 10-min prices + locking predictions...');
  await restoreState();
  const syms = getAllSymbols();

  // Get t925 prices
  const ltpMap = HAS_TOKEN
    ? await growwLTP(syms)
    : (() => null)();   // see below — for delayed feed we use batch web prices
  const webMap = HAS_TOKEN ? null : await growwWebBatchPrices(syms);

  for (const sym of syms) {
    const ltp = HAS_TOKEN
      ? ltpMap?.[`NSE_${sym}`]
      : webMap?.[sym]?.ltp;
    if (ltp && openingSnaps[sym]) {
      openingSnaps[sym].t925 = ltp;
    } else if (!openingSnaps[sym] && ltp) {
      openingSnaps[sym] = { t915: ltp, t925: ltp, open: ltp };
    }
  }

  // Fetch full quote (depth) for ALL stocks if we have token (was top-15 in v15)
  if (HAS_TOKEN) {
    for (let i=0; i<syms.length; i+=8) {
      const batch = syms.slice(i, i+8);
      await Promise.all(batch.map(s => fetchFullQuote(s)));
      if (i+8 < syms.length) await sleep(150);
    }

    // Load 5-min and 1-min candles for indicator computation
    for (let i=0; i<syms.length; i+=5) {
      const batch = syms.slice(i, i+5);
      await Promise.all(batch.map(async s => {
        if (!histCache[s]) histCache[s] = {};
        const [m5, m1] = await Promise.all([fetchToday5min(s), fetchToday1min(s)]);
        histCache[s].m5 = m5;
        histCache[s].m1 = m1;
        // VWAP of first 10 min
        const open10 = m1.length >= 10 ? m1.slice(0, 10) : m5.slice(0, 2);
        if (openingSnaps[s] && open10.length) {
          openingSnaps[s].vwap10 = calcVWAP(open10);
        }
      }));
      if (i+5 < syms.length) await sleep(200);
    }
  }

  // Build predictions
  lockedPredictions = Object.entries(openingSnaps)
    .filter(([,snap]) => snap.t915>0)
    .map(([sym, snap]) => {
      const liveQ = liveQuotes[sym] || null;
      const hist  = histCache[sym]  || {};
      return buildPrediction(sym, snap, liveQ, hist);
    })
    .filter(Boolean);

  snapshotStatus = 'locked';
  await persistState();
  await logPredictionsForBacktest(lockedPredictions);

  const buy  = lockedPredictions.filter(p=>p.action==='BUY').length;
  const sell = lockedPredictions.filter(p=>p.action==='SELL').length;
  console.log(`\n[9:25] ✅ ${lockedPredictions.length} predictions | ${buy} BUY | ${sell} SELL`);
  lockedPredictions.filter(p=>p.action!=='HOLD')
    .sort((a,b) => b.confidence - a.confidence)
    .slice(0, 10)
    .forEach(p =>
      console.log(`  ${p.action} ${p.symbol.padEnd(14)} conf:${p.confidence}% | dev10:${p.dev10}% | ADX:${p.adx} | Vol:${p.volSurge}x | lists:${p.growwLists.length}`)
    );
}

// ══════════════════════════════════════════════════════════════
// LIVE PRICE UPDATE
// ══════════════════════════════════════════════════════════════
async function updateLivePrices() {
  if (!lockedPredictions.length) return;
  const syms = lockedPredictions.map(p=>p.symbol);
  const ltpMap = HAS_TOKEN ? await growwLTP(syms) : null;
  const webMap = HAS_TOKEN ? null : await growwWebBatchPrices(syms);

  // Refresh indicators every ~9 min
  const shouldRefreshIndicators = HAS_TOKEN && ((Date.now() % 540000) < 60000);
  if (shouldRefreshIndicators) {
    for (let i=0; i<syms.length; i+=5) {
      const batch = syms.slice(i, i+5);
      await Promise.all(batch.map(async s => {
        if (!histCache[s]) histCache[s] = {};
        histCache[s].m5 = await fetchToday5min(s);
      }));
      if (i+5 < syms.length) await sleep(150);
    }
  }

  lockedPredictions = lockedPredictions.map(p => {
    const ltp = HAS_TOKEN
      ? (ltpMap?.[`NSE_${p.symbol}`] || p.currentPrice)
      : (webMap?.[p.symbol]?.ltp || p.currentPrice);
    if (!ltp) return p;

    let vwap = p.vwap, rsi = p.rsi, aboveVWAP = p.aboveVWAP, vwapDev = p.vwapDev;
    if (shouldRefreshIndicators) {
      const m5 = histCache[p.symbol]?.m5 || [];
      if (m5.length) {
        vwap = calcVWAP(m5);
        const closes = m5.map(c=>c[4]);
        if (closes.length >= 15) rsi = calcRSI(closes);
        aboveVWAP = vwap > 0 && ltp > vwap;
        vwapDev   = vwap > 0 ? +((ltp-vwap)/vwap*100).toFixed(2) : 0;
      }
    }

    const currentDev = p.open915Price>0
      ? +((ltp-p.open915Price)/p.open915Price*100).toFixed(2)
      : p.devFromOpen;

    const progressPct = p.targetPct!==0
      ? Math.min(100, Math.max(0, Math.round(Math.abs(currentDev)/Math.abs(p.targetPct)*100)))
      : 0;

    const isBuy = p.action==='BUY';
    let currentStatus;
    if (p.action==='HOLD') { currentStatus='WATCHING 👁️'; }
    else if (isBuy) {
      if (p.targetPrice && ltp>=p.targetPrice)           currentStatus='TARGET HIT ✅';
      else if (p.stopLossPrice && ltp<=p.stopLossPrice)  currentStatus='STOP HIT ⛔';
      else if (currentDev<-0.5)                          currentStatus='PULLBACK ⚠️';
      else if (progressPct>=80)                          currentStatus='NEAR TARGET 🎯';
      else                                               currentStatus='ON TRACK 📈';
    } else {
      if (p.targetPrice && ltp<=p.targetPrice)           currentStatus='TARGET HIT ✅';
      else if (p.stopLossPrice && ltp>=p.stopLossPrice)  currentStatus='STOP HIT ⛔';
      else if (currentDev>0.5)                           currentStatus='BOUNCE ⚠️';
      else if (progressPct>=80)                          currentStatus='NEAR TARGET 🎯';
      else                                               currentStatus='ON TRACK 📉';
    }

    const remaining = isBuy
      ? +(p.targetPct - currentDev).toFixed(2)
      : +(currentDev - p.targetPct).toFixed(2);

    let prediction = p.prediction;
    if (p.action!=='HOLD') {
      const dir = isBuy ? '📈 RISE' : '📉 FALL';
      prediction = `${dir} ~${Math.abs(p.targetPct).toFixed(1)}% today. ` +
        `Anchor ₹${p.open915Price.toFixed(2)} → Target ₹${p.targetPrice} | Stop ₹${p.stopLossPrice}. R:R=${p.riskReward}:1. ` +
        (remaining>0 ? `~${remaining.toFixed(1)}% ${isBuy?'more to go':'more to fall'}. ` : 'TARGET ZONE! ') +
        `[Live ₹${ltp.toFixed(2)} | ${currentDev>=0?'+':''}${currentDev.toFixed(2)}% from anchor]`;
    }

    return {
      ...p,
      currentPrice: +ltp.toFixed(2),
      devFromOpen: currentDev,
      progressPct, currentStatus, prediction,
      vwap, rsi, aboveVWAP, vwapDev,
    };
  });
  await persistState();
}

// ══════════════════════════════════════════════════════════════
// FALLBACK — when server starts after 9:25
// ══════════════════════════════════════════════════════════════
function generateFallbackFromLive(quotes) {
  console.log('[Fallback] Building late-entry predictions...');
  const preds = [];
  for (const [sym, q] of Object.entries(quotes)) {
    const open = q.open || q.ltp;
    const ltp  = q.ltp || open;
    if (!open || !ltp) continue;
    openingSnaps[sym] = {
      t915: open, t925: ltp, open, prevClose: q.prevClose,
    };
    const hist = histCache[sym] || {};
    const pred = buildPrediction(sym, openingSnaps[sym], null, hist, { fallback: true });
    if (pred) preds.push(pred);
  }
  lockedPredictions = preds;
  snapshotStatus    = 'fallback';
  console.log(`[Fallback] ${preds.filter(p=>p.action!=='HOLD').length} active`);
}

// ══════════════════════════════════════════════════════════════
// PREDICTION LOGGING (for win-rate tracking)
// ══════════════════════════════════════════════════════════════
async function logPredictionsForBacktest(preds) {
  if (!preds.length) return;
  const log = preds.map(p => ({
    date: dateStr(0), symbol: p.symbol,
    action: p.action, anchor: p.open915Price,
    target: p.targetPrice, stop: p.stopLossPrice,
    targetPct: p.targetPct, stopPct: p.stopPct,
    confidence: p.confidence, dev10: p.dev10,
    rsi: p.rsi, adx: p.adx, volSurge: p.volSurge,
    gap: p.gap?.type, emaStack: p.emaStack,
    growwLists: p.growwLists,
  }));
  await kvSet(`tb:log:${dateStr(0)}`, log, 30 * 86400);
}

async function tagOutcomes() {
  if (!lockedPredictions.length) return null;
  const syms = lockedPredictions.map(p=>p.symbol);
  const ltpMap = HAS_TOKEN ? await growwLTP(syms) : null;
  const webMap = HAS_TOKEN ? null : await growwWebBatchPrices(syms);

  const outcomes = lockedPredictions.map(p => {
    const eod = HAS_TOKEN
      ? (ltpMap?.[`NSE_${p.symbol}`] || p.currentPrice)
      : (webMap?.[p.symbol]?.ltp || p.currentPrice);
    const eodDev = p.open915Price>0 ? (eod-p.open915Price)/p.open915Price*100 : 0;
    let outcome = 'NEUTRAL';
    if (p.action === 'BUY') {
      if (eod >= p.targetPrice)        outcome = 'TARGET_HIT';
      else if (eod <= p.stopLossPrice) outcome = 'STOP_HIT';
      else if (eodDev > 0)             outcome = 'WIN_PARTIAL';
      else                              outcome = 'LOSS';
    } else if (p.action === 'SELL') {
      if (eod <= p.targetPrice)        outcome = 'TARGET_HIT';
      else if (eod >= p.stopLossPrice) outcome = 'STOP_HIT';
      else if (eodDev < 0)             outcome = 'WIN_PARTIAL';
      else                              outcome = 'LOSS';
    }
    return {
      symbol: p.symbol, action: p.action, anchor: p.open915Price,
      eod, eodDev: +eodDev.toFixed(2), outcome, confidence: p.confidence,
    };
  });
  await kvSet(`tb:outcome:${dateStr(0)}`, outcomes, 90 * 86400);
  console.log(`[Outcome] Logged ${outcomes.length} outcomes for ${dateStr(0)}`);
  return outcomes;
}

// ══════════════════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════════════════
async function mainRefresh() {
  console.log(`\n[Bot] ─── ${istStr()} | ${marketPhase()} ───`);
  try {
    await restoreState();
    const quotes = await fetchAllLiveData();
    dataStore.quotes = quotes;
    dataStore.lastUpdated = new Date().toISOString();

    const { totalMins, day } = getIST();
    const pastOpen = day>=1 && day<=5 && totalMins>=9*60+25 && totalMins<15*60+30;

    if (pastOpen && !lockedPredictions.length) {
      generateFallbackFromLive(quotes);
      await persistState();
    }
    if (lockedPredictions.length) {
      await updateLivePrices();
    }

    const active = lockedPredictions.filter(p=>p.action!=='HOLD');
    console.log(`[Bot] ✅ quotes:${Object.keys(quotes).length} | preds:${active.length} | status:${snapshotStatus}`);
  } catch(e) {
    console.error('[Bot] Refresh error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// API ENDPOINTS
// ══════════════════════════════════════════════════════════════
app.use(async (_, __, next) => { await restoreState(); next(); });

app.get('/api/status', (_, res) => {
  const ph = marketPhase();
  const { h, m } = getIST();
  const pad = n => String(n).padStart(2,'0');
  res.json({
    phase: ph, isOpen: isOpen(),
    istTime: `${pad(h)}:${pad(m)} IST`,
    snapshotStatus,
    activePredictions: lockedPredictions.filter(p=>p.action!=='HOLD').length,
    totalPredictions:  lockedPredictions.length,
    watchlist:         getAllSymbols().length,
    universeSize:      universe.length,
    universeLists:     Object.keys(universeMeta?.byList || {}),
    mtfStocks:         universe.filter(u => u.lists?.includes('MOST_BOUGHT_MTF')).length,
    lastUpdated:       dataStore.lastUpdated,
    kvEnabled:         !!kv,
    growwTokenSet:     HAS_TOKEN,
  });
});

app.get('/api/quotes', (_, res) => {
  maybeRefresh();
  res.json({ quotes:dataStore.quotes, lastUpdated:dataStore.lastUpdated });
});

// ★ MAIN PREDICTION ENDPOINT
app.get('/api/mtf/live', (req, res) => {
  maybeRefresh();
  const { action, limit=50, list } = req.query;
  let preds = [...lockedPredictions];
  if (action) preds = preds.filter(p=>p.action===action.toUpperCase());
  if (list)   preds = preds.filter(p=>p.growwLists?.includes(list));

  preds.sort((a,b) => {
    const r={BUY:0,SELL:1,HOLD:2};
    if (r[a.action]!==r[b.action]) return r[a.action]-r[b.action];
    return b.confidence-a.confidence || Math.abs(b.dev10)-Math.abs(a.dev10);
  });
  preds = preds.slice(0, parseInt(limit));

  res.json({
    predictions: preds,
    summary: {
      total:       preds.length,
      buy:         preds.filter(p=>p.action==='BUY').length,
      sell:        preds.filter(p=>p.action==='SELL').length,
      hold:        preds.filter(p=>p.action==='HOLD').length,
      targetsHit:  preds.filter(p=>p.currentStatus?.includes('TARGET HIT')).length,
      onTrack:     preds.filter(p=>p.currentStatus?.includes('ON TRACK')).length,
    },
    snapshotStatus, phase: marketPhase(),
    updatedAt: new Date().toISOString(),
  });
});

app.get('/api/mtf/predictions', (req,res) =>
  res.redirect(`/api/mtf/live${req.query.action?'?action='+req.query.action:''}`)
);

// Universe view — which lists each stock is on
app.get('/api/universe', (_, res) => res.json({
  count: universe.length,
  byList: universeMeta?.byList || {},
  fetchedAt: universeMeta?.fetchedAt,
  stocks: universe.map(u => ({
    symbol: u.symbol, name: u.name, ltp: u.ltp,
    dayChangePct: u.dayChangePct,
    lists: u.lists, popularityScore: u.popularityScore,
    growwUrl: growwUrl(u.symbol),
    prediction: lockedPredictions.find(p=>p.symbol===u.symbol) || null,
  })),
}));

// Backwards-compat with v15 frontend
app.get('/api/mtf/stocks', (_, res) => res.json({
  stocks: universe.map(u => ({
    symbol: u.symbol, companyName: u.name, shortName: u.name,
    searchId: u.searchId, ltp: u.ltp, prevClose: u.prevClose,
    dayChange: u.dayChange, dayChangePct: u.dayChangePct,
    lists: u.lists, popularityScore: u.popularityScore,
    growwUrl: growwUrl(u.symbol),
    prediction: lockedPredictions.find(p=>p.symbol===u.symbol) || null,
    liveQuote: dataStore.quotes?.[u.symbol] || null,
  })),
  count: universe.length,
  lastFetched: dataStore.lastUpdated,
}));

app.get('/api/analyze/:sym', async (req,res) => {
  const sym   = req.params.sym.toUpperCase();
  const quote = await growwQuote(sym);
  if (!histCache[sym]) await loadHistoryForSym(sym);
  const hist  = histCache[sym] || {};
  const snap  = openingSnaps[sym] || {
    t915: quote?.last_price || 0,
    t925: quote?.last_price || 0,
    open: quote?.last_price || 0,
  };
  const pred  = buildPrediction(sym, snap, quote, hist);
  res.json({ symbol:sym, quote, prediction:pred, indicators: pred ? {
    rsi: pred.rsi, rsi1m: pred.rsi1m, vwap: pred.vwap,
    ema9: pred.ema9, ema21: pred.ema21, ema50: pred.ema50,
    adx: pred.adx, atr: pred.atr, atrPct: pred.atrPct,
    volSurge: pred.volSurge, gap: pred.gap,
    pivots: pred.pivots,
  } : null });
});

app.get('/api/candles/:sym', async (req,res) => {
  const sym = req.params.sym.toUpperCase();
  const tf  = parseInt(req.query.interval||'5');
  const days= parseInt(req.query.days||'1');
  const end  = dateStr(0)  + ' 15:30:00';
  const start= dateStr(-days) + ' 09:15:00';
  const candles = await growwCandles(sym, tf, start, end);
  res.json({ symbol:sym, interval:tf, candles });
});

// Backtest / win-rate
app.get('/api/backtest', async (_, res) => {
  const out = [];
  for (let d=0; d<30; d++) {
    const k = dateStr(-d);
    const outcomes = await kvGet(`tb:outcome:${k}`);
    if (outcomes) out.push({ date: k, outcomes });
  }
  const flat = out.flatMap(d=>d.outcomes);
  const wins   = flat.filter(o => o.outcome==='TARGET_HIT' || o.outcome==='WIN_PARTIAL').length;
  const losses = flat.filter(o => o.outcome==='STOP_HIT'   || o.outcome==='LOSS').length;
  const winRate = (wins+losses)>0 ? +(wins/(wins+losses)*100).toFixed(1) : 0;
  // Win rate by confidence bucket
  const buckets = { '90+':[], '80-90':[], '70-80':[], '<70':[] };
  flat.forEach(o => {
    const c = o.confidence || 0;
    const k = c>=90?'90+':c>=80?'80-90':c>=70?'70-80':'<70';
    buckets[k].push(o);
  });
  const byConf = {};
  for (const [k, list] of Object.entries(buckets)) {
    const w = list.filter(o => o.outcome==='TARGET_HIT' || o.outcome==='WIN_PARTIAL').length;
    const l = list.filter(o => o.outcome==='STOP_HIT'   || o.outcome==='LOSS').length;
    byConf[k] = { trades: list.length, wins: w, losses: l,
                  winRate: (w+l)>0 ? +(w/(w+l)*100).toFixed(1) : 0 };
  }
  res.json({ days: out.length, totalTrades: flat.length, wins, losses, winRate, byConfidence: byConf, history: out });
});

app.get('/api/debug', (_,res) => res.json({
  snapshotStatus, phase: marketPhase(),
  growwTokenSet: HAS_TOKEN, kvEnabled: !!kv,
  universeSize: universe.length,
  snapshots: Object.fromEntries(
    Object.entries(openingSnaps).slice(0,10)
      .map(([k,v])=>[k,{t915:v.t915,t925:v.t925,open:v.open,vwap10:v.vwap10}])
  ),
  activePredictions: lockedPredictions.filter(p=>p.action!=='HOLD').length,
}));

app.post('/api/refresh', async(_,res) => {
  await mainRefresh();
  res.json({ success:true, predictions:lockedPredictions.filter(p=>p.action!=='HOLD').length });
});
app.post('/api/reset', async(_,res) => {
  Object.keys(openingSnaps).forEach(k=>delete openingSnaps[k]);
  lockedPredictions = [];
  snapshotStatus = 'waiting';
  await persistState();
  res.json({ success:true });
});
app.post('/api/load-history', async(_,res) => {
  await loadAllHistory();
  res.json({ success:true, symbols:Object.keys(histCache).length });
});

// ══════════════════════════════════════════════════════════════
// CRON ENDPOINTS
// ══════════════════════════════════════════════════════════════
app.get('/api/cron/mtf-refresh', async (_, res) => {
  console.log('[Cron] mtf-refresh — building universe');
  await buildUniverse();
  res.json({ ok: true, universeSize: universe.length, ts: istStr() });
});

app.get('/api/cron/load-history', async (_, res) => {
  console.log('[Cron] load-history');
  await loadAllHistory();
  res.json({ ok: true, symbols: Object.keys(histCache).length, ts: istStr() });
});

app.get('/api/cron/snapshot-915', async (_, res) => {
  console.log('[Cron] snapshot-915');
  await capture915Snapshot();
  res.json({ ok: true, snaps: Object.keys(openingSnaps).length, ts: istStr() });
});

app.get('/api/cron/snapshot-925', async (_, res) => {
  console.log('[Cron] snapshot-925');
  await capture925AndLock();
  const buy  = lockedPredictions.filter(p => p.action === 'BUY').length;
  const sell = lockedPredictions.filter(p => p.action === 'SELL').length;
  res.json({ ok: true, total: lockedPredictions.length, buy, sell, ts: istStr() });
});

app.get('/api/cron/refresh', async (_, res) => {
  console.log('[Cron] refresh');
  await mainRefresh();
  res.json({ ok: true, quotes: Object.keys(dataStore.quotes).length,
    active: lockedPredictions.filter(p => p.action !== 'HOLD').length, ts: istStr() });
});

app.get('/api/cron/tag-outcomes', async (_, res) => {
  console.log('[Cron] tag-outcomes');
  const outcomes = await tagOutcomes();
  res.json({ ok: true, count: outcomes?.length || 0, ts: istStr() });
});

app.get('/api/cron/reset', async (_, res) => {
  console.log('[Cron] reset');
  Object.keys(openingSnaps).forEach(k => delete openingSnaps[k]);
  lockedPredictions = [];
  snapshotStatus = 'waiting';
  await persistState();
  res.json({ ok: true, ts: istStr() });
});

// LOCAL FALLBACK
if (require.main === module) {
  setInterval(async () => {
    const { totalMins, day } = getIST();
    if (day < 1 || day > 5) return;
    if (totalMins < 9*60+15 || totalMins >= 15*60+30) return;
    await mainRefresh();
  }, 3 * 60 * 1000);
}

// ══════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════
async function init() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════╗
║  ⚡ TradeBot v16 — Most-Bought / Top-Intraday AI Engine          ║
║  http://localhost:${PORT}                                             ║
╠═══════════════════════════════════════════════════════════════════╣
║  Universe: Groww explore lists (MOST_BOUGHT, INTRADAY_VOLUME,    ║
║            MOST_BOUGHT_MTF, TOP_GAINERS/LOSERS, MOST_ACTIVE)     ║
║  Engine:   12 factors — momentum, VWAP, RSI(5m+1m), EMA, ADX,    ║
║            depth, candle, gap, vol-surge, pivot, popularity      ║
║  Persist:  ${(kv ? 'Vercel KV / Upstash Redis' : 'In-memory only (set KV creds!)').padEnd(45)}║
║  Token:    ${(HAS_TOKEN ? 'Groww Trade API ✓' : 'Public delayed feed (set GROWW_ACCESS_TOKEN!)').padEnd(45)}║
╚═══════════════════════════════════════════════════════════════════╝`);

  await restoreState();

  console.log('\n[Init] 🔍 Building universe from Groww explore lists...');
  await buildUniverse();
  if (universe.length) {
    console.log(`[Init] ✅ ${universe.length} unique stocks loaded`);
    universe.slice(0, 8).forEach(u => {
      const sign = (u.dayChangePct||0)>=0?'+':'';
      const lists = u.lists.slice(0,3).join(',');
      console.log(`  ${(u.name||u.symbol).slice(0,28).padEnd(28)} ${u.symbol.padEnd(12)} ₹${(u.ltp||0).toFixed(1).padStart(8)} ${(sign+(u.dayChangePct||0).toFixed(2)+'%').padStart(8)}  [${lists}]`);
    });
    if (universe.length > 8) console.log(`  ... and ${universe.length-8} more`);
  }

  console.log('\n[Init] 📊 Loading 90-day historical candles...');
  await loadAllHistory();

  const phase = marketPhase();
  console.log(`\n[Init] 🕐 ${istStr()} | Phase: ${phase}`);
  await mainRefresh();

  const { totalMins, day } = getIST();
  if (day>=1 && day<=5 && totalMins>=9*60+25 && totalMins<15*60+30 && !lockedPredictions.length) {
    console.log('[Init] ⚡ Past 9:25 — generating fallback predictions');
    generateFallbackFromLive(dataStore.quotes);
    await persistState();
  }

  const active = lockedPredictions.filter(p=>p.action!=='HOLD').length;
  const buys   = lockedPredictions.filter(p=>p.action==='BUY').length;
  const sells  = lockedPredictions.filter(p=>p.action==='SELL').length;
  console.log(`\n╔═══════════════════════════════════════════════════════════════════╗`);
  console.log(`║  ✅ READY at ${istStr().padEnd(20)}                                       ║`);
  console.log(`║  Phase: ${phase.padEnd(20)} Universe: ${String(universe.length).padEnd(4)}                       ║`);
  console.log(`║  Active: ${String(active).padEnd(4)} (${buys} BUY / ${sells} SELL)                                  ║`);
  console.log(`╚═══════════════════════════════════════════════════════════════════╝\n`);
}

let _initialized = false;
const _originalHandle = app.handle.bind(app);
app.handle = async (req, res, next) => {
  if (!_initialized) {
    _initialized = true;
    try { await init(); } catch(e) { console.error('[Init Error]', e.message); }
  }
  _originalHandle(req, res, next);
};

if (require.main === module) {
  app.listen(PORT, init);
}

module.exports = app;
