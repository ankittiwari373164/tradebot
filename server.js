/**
 * TradeBot v15 — Groww Trade API Edition
 * ══════════════════════════════════════════════════════════════
 * Data Source:  Groww Trade API (official, real-time)
 * Historical:   Groww /v1/historical/candle/range (1-min, 5-min, day)
 * Live:         Groww /v1/live-data/quote + /v1/live-data/ohlc (up to 50 at once)
 * Prediction:   Multi-factor AI engine:
 *               1. Opening 10-min momentum (9:15 vs 9:25) ← THE CORE
 *               2. Previous 5-day candle pattern analysis
 *               3. VWAP deviation
 *               4. RSI(14) from 5-min candles
 *               5. EMA stack (9/21/50)
 *               6. Buy/Sell depth pressure from live quote
 *               7. Day change % momentum
 * Stocks:       Groww most-traded (scraped) + base watchlist
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
// node-cron not used on Vercel — cron jobs run via /api/cron/* endpoints (see vercel.json)
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════
const GROWW_TOKEN = process.env.GROWW_ACCESS_TOKEN || '';
const PORT        = process.env.PORT || 3001;

if (!GROWW_TOKEN) {
  console.error('❌ GROWW_ACCESS_TOKEN not set in .env — set it and restart');
  process.exit(1);
}

// Groww API headers
const GHDRS = {
  'Authorization':  `Bearer ${GROWW_TOKEN}`,
  'X-API-VERSION':  '1.0',
  'Accept':         'application/json',
  'Content-Type':   'application/json',
};
const GROWW_BASE = 'https://api.groww.in/v1';

// Fallback — used ONLY if Groww MTF scrape fails completely
const BASE_STOCKS = [
  'RELIANCE','TCS','INFY','HDFCBANK','ICICIBANK','SBIN','BAJFINANCE',
];

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ══════════════════════════════════════════════════════════════
// TIME HELPERS
// ══════════════════════════════════════════════════════════════
function getIST() {
  const ist = new Date(Date.now() + 5.5 * 3600000);
  const h = ist.getUTCHours(), m = ist.getUTCMinutes(), s = ist.getUTCSeconds();
  const totalMins = h * 60 + m;
  const day = ist.getUTCDay();
  return { h, m, s, totalMins, day, ist };
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
  // Returns yyyy-mm-dd offset by d days
  const dt = new Date(Date.now() + 5.5*3600000 + d*86400000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth()+1).padStart(2,'0')}-${String(dt.getUTCDate()).padStart(2,'0')}`;
}

// ══════════════════════════════════════════════════════════════
// GROWW API WRAPPERS
// ══════════════════════════════════════════════════════════════

// Live quote for one symbol (full depth + OHLC)
async function growwQuote(symbol) {
  try {
    const r = await axios.get(`${GROWW_BASE}/live-data/quote`, {
      params: { exchange:'NSE', segment:'CASH', trading_symbol:symbol },
      headers: GHDRS, timeout: 8000,
    });
    if (r.data?.status !== 'SUCCESS') return null;
    return r.data.payload;
  } catch(e) {
    console.error(`[Quote] ${symbol}: ${e.message?.slice(0,40)}`);
    return null;
  }
}

// Batch LTP for up to 50 symbols at once
async function growwLTP(symbols) {
  if (!symbols.length) return {};
  const exchangeSymbols = symbols.map(s=>`NSE_${s}`).join(',');
  try {
    const r = await axios.get(`${GROWW_BASE}/live-data/ltp`, {
      params: { segment:'CASH', exchange_symbols:exchangeSymbols },
      headers: GHDRS, timeout: 8000,
    });
    if (r.data?.status !== 'SUCCESS') return {};
    return r.data.payload || {};
  } catch(e) {
    console.error(`[LTP] batch: ${e.message?.slice(0,40)}`);
    return {};
  }
}

// Batch OHLC for up to 50 symbols at once
async function growwOHLC(symbols) {
  if (!symbols.length) return {};
  const exchangeSymbols = symbols.map(s=>`NSE_${s}`).join(',');
  try {
    const r = await axios.get(`${GROWW_BASE}/live-data/ohlc`, {
      params: { segment:'CASH', exchange_symbols:exchangeSymbols },
      headers: GHDRS, timeout: 8000,
    });
    if (r.data?.status !== 'SUCCESS') return {};
    return r.data.payload || {};
  } catch(e) {
    console.error(`[OHLC] batch: ${e.message?.slice(0,40)}`);
    return {};
  }
}

// Historical candles (interval_in_minutes: 1,5,10,60,1440)
async function growwCandles(symbol, intervalMins, startTime, endTime) {
  try {
    const r = await axios.get(`${GROWW_BASE}/historical/candle/range`, {
      params: {
        exchange:'NSE', segment:'CASH',
        trading_symbol:symbol,
        start_time: startTime,
        end_time:   endTime,
        interval_in_minutes: intervalMins,
      },
      headers: GHDRS, timeout: 12000,
    });
    if (r.data?.status !== 'SUCCESS') return [];
    // Each candle: [timestamp, open, high, low, close, volume]
    return r.data.payload?.candles || [];
  } catch(e) {
    console.error(`[Candles] ${symbol} ${intervalMins}m: ${e.message?.slice(0,40)}`);
    return [];
  }
}

// Fetch last N days of daily candles
async function fetchDailyHistory(symbol, days=10) {
  const end   = dateStr(0) + ' 15:30:00';
  const start = dateStr(-days) + ' 09:15:00';
  return growwCandles(symbol, 1440, start, end);
}

// Fetch today's 5-min candles
async function fetchToday5min(symbol) {
  const today = dateStr(0);
  return growwCandles(symbol, 5, `${today} 09:15:00`, `${today} 15:30:00`);
}

// Fetch today's 1-min candles
async function fetchToday1min(symbol) {
  const today = dateStr(0);
  return growwCandles(symbol, 1, `${today} 09:15:00`, `${today} 15:30:00`);
}

// ══════════════════════════════════════════════════════════════
// TECHNICAL INDICATORS
// ══════════════════════════════════════════════════════════════
function calcEMA(closes, p) {
  if (!closes || closes.length < p) return null;
  const k = 2 / (p + 1);
  let v = closes.slice(0, p).reduce((s,x) => s+x, 0) / p;
  for (let i = p; i < closes.length; i++) v = closes[i] * k + v * (1 - k);
  return +v.toFixed(2);
}

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
    ag=(ag*(p-1)+Math.max(0,d))/p;
    al=(al*(p-1)+Math.max(0,-d))/p;
  }
  return al===0 ? 100 : +(100-100/(1+ag/al)).toFixed(1);
}

function calcVWAP(candles) {
  // candle = [ts, open, high, low, close, volume]
  let pv=0, vol=0;
  for (const c of candles) {
    const tp = (c[2]+c[3]+c[4])/3; // (high+low+close)/3
    pv += tp * c[5]; vol += c[5];
  }
  return vol>0 ? +(pv/vol).toFixed(2) : 0;
}

function calcATR(dailyCandles, p=14) {
  // dailyCandles: [ts, open, high, low, close, vol]
  if (dailyCandles.length < p+1) return 0;
  const trs = dailyCandles.slice(1).map((c,i)=>Math.max(
    c[2]-c[3],
    Math.abs(c[2]-dailyCandles[i][4]),
    Math.abs(c[3]-dailyCandles[i][4])
  ));
  return +(trs.slice(-p).reduce((s,v)=>s+v,0)/p).toFixed(2);
}

function pivotPoints(high, low, close) {
  const pp = (high+low+close)/3;
  return {
    pp: +pp.toFixed(2),
    r1: +(2*pp-low).toFixed(2),  r2: +(pp+high-low).toFixed(2),
    s1: +(2*pp-high).toFixed(2), s2: +(pp-high+low).toFixed(2),
  };
}

// ══════════════════════════════════════════════════════════════
// RUNTIME STATE
// ══════════════════════════════════════════════════════════════

// Opening snapshots — the WORKING engine from v4
const openingSnaps = {};  // { SYM: { t915, t925, open } }
let snapshotStatus  = 'waiting';

// Locked predictions (set at 9:25, updated with live prices)
let lockedPredictions = [];

// Historical cache
const histCache = {};     // { SYM: { daily:[], m5:[], m1:[] } }
const liveQuotes= {};     // { SYM: full quote payload }

let dataStore = {
  quotes: {}, news: [], lastUpdated: null,
};
let mtfStocks = [];
const companyNames = {};

// ── Request-time lazy refresh (replaces */3 cron on Vercel Hobby) ──
// On each frontend poll to /api/mtf/live or /api/quotes,
// if data is stale (>2 min) and market is open → refresh in background
const STALE_MS = 2 * 60 * 1000; // 2 minutes
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
// GROWW MOST-TRADED SCRAPE
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// GROWW MTF MOST-TRADED SCRAPER
// Exact implementation from the Python script that works:
//   url = "https://groww.in/stocks/mtf/most-traded"
//   data["props"]["pageProps"]["mbgStocks"]
// Each stock has:
//   company: { nseScriptCode, companyName, companyShortName, searchId, mtfHaircut, isin }
//   stats:   { ltp, high, low, close, dayChange, dayChangePerc }
// ══════════════════════════════════════════════════════════════
async function fetchGrowwMostTraded() {
  console.log('[MTF] Scraping https://groww.in/stocks/mtf/most-traded ...');
  try {
    const r = await axios.get('https://groww.in/stocks/mtf/most-traded', {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0',
        'Accept':     'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
    });

    // Extract __NEXT_DATA__ — same as Python: soup.find("script", {"id": "__NEXT_DATA__"})
    const match = r.data.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('__NEXT_DATA__ not found in page');

    const nextData = JSON.parse(match[1]);
    // Exact path: data["props"]["pageProps"]["mbgStocks"]
    const mbgStocks = nextData?.props?.pageProps?.mbgStocks;
    if (!Array.isArray(mbgStocks) || !mbgStocks.length) throw new Error('mbgStocks empty or missing');

    const stocks = mbgStocks.map(s => {
      const c  = s.company;
      const st = s.stats;
      const sym = c.nseScriptCode;

      // Cache company info
      companyNames[sym]  = c.companyShortName || c.companyName || sym;
      growwSlugs[sym]    = c.searchId; // exact slug for Groww URL

      return {
        symbol:      sym,
        companyName: c.companyName,
        shortName:   c.companyShortName || c.companyName,
        searchId:    c.searchId,        // e.g. "rm-drip-and-sprinklers-system-ltd"
        isin:        c.isin,
        haircut:     c.mtfHaircut,      // e.g. 22.56%
        // Live stats from page load
        ltp:         st.ltp,
        high:        st.high,
        low:         st.low,
        prevClose:   st.close,          // yesterday's close
        dayChange:   st.dayChange,
        dayChangePct:st.dayChangePerc,
        circuitLow:  st.lowPriceRange,
        circuitHigh: st.highPriceRange,
      };
    });

    console.log(`[MTF] ✅ ${stocks.length} MTF stocks scraped`);
    console.log('[MTF] Stocks:', stocks.map(s=>`${s.symbol}(${s.dayChangePct.toFixed(1)}%)`).join(', '));
    return stocks;

  } catch(e) {
    console.error('[MTF] Scrape failed:', e.message?.slice(0,80));
    // Return cached if available
    if (mtfStocks.length > 0) {
      console.log('[MTF] Using cached stocks:', mtfStocks.length);
      return mtfStocks;
    }
    // Last resort: fallback list
    console.log('[MTF] Using BASE_STOCKS fallback');
    return BASE_STOCKS.map(sym => ({
      symbol:sym, companyName:companyNames[sym]||sym, shortName:companyNames[sym]||sym,
      searchId:sym.toLowerCase(), isin:'', haircut:0,
      ltp:0, high:0, low:0, prevClose:0, dayChange:0, dayChangePct:0,
    }));
  }
}

// Groww URL slug cache (populated from searchId in MTF scrape)
const growwSlugs = {};

// ONLY use MTF stocks — no other watchlist mixed in
// These are the exact stocks Groww users are most actively trading in MTF mode
function getAllSymbols() {
  if (mtfStocks.length > 0) return mtfStocks.map(s => s.symbol);
  return BASE_STOCKS; // fallback only
}

function growwUrl(sym) {
  const slug = growwSlugs[sym];
  if (slug) return `https://groww.in/stocks/${slug}`;
  // Try from mtfStocks
  const mtf = mtfStocks.find(s=>s.symbol===sym);
  if (mtf?.searchId) return `https://groww.in/stocks/${mtf.searchId}`;
  return `https://groww.in/stocks/${sym.toLowerCase()}`;
}

// ══════════════════════════════════════════════════════════════
// HISTORICAL DATA FETCH (pre-market prep)
// ══════════════════════════════════════════════════════════════
async function loadHistoryForSym(sym) {
  const [daily, m5] = await Promise.all([
    fetchDailyHistory(sym, 30),
    isOpen() ? fetchToday5min(sym) : Promise.resolve([]),
  ]);
  histCache[sym] = { daily, m5, loadedAt: Date.now() };
  return histCache[sym];
}

async function loadAllHistory() {
  const syms = getAllSymbols();
  console.log(`[Hist] Loading history for ${syms.length} stocks...`);
  for (let i=0; i<syms.length; i+=3) {
    await Promise.all(syms.slice(i,i+3).map(loadHistoryForSym));
    await sleep(400);
  }
  console.log('[Hist] ✅ Done');
}

// ══════════════════════════════════════════════════════════════
// LIVE QUOTES — batch fetch all symbols
// ══════════════════════════════════════════════════════════════
async function fetchAllLiveData() {
  const syms = getAllSymbols();
  const quotes = {};

  // Batch LTP (50 at a time)
  for (let i=0; i<syms.length; i+=50) {
    const batch  = syms.slice(i,i+50);
    const ltpMap = await growwLTP(batch);
    for (const sym of batch) {
      const key = `NSE_${sym}`;
      if (ltpMap[key]) quotes[sym] = { symbol:sym, ltp: ltpMap[key] };
    }
    if (i+50 < syms.length) await sleep(300);
  }

  // Batch OHLC (50 at a time)
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

  // Compute derived values
  for (const [sym, q] of Object.entries(quotes)) {
    const ltp  = q.ltp || 0;
    const open = q.open || ltp;
    const prev = q.prevClose || ltp;
    q.change    = +(ltp - prev).toFixed(2);
    q.changePct = prev>0 ? +((ltp-prev)/prev*100).toFixed(2) : 0;
    q.devOpen   = open>0 ? +((ltp-open)/open*100).toFixed(2) : 0;
    q.growwUrl  = growwUrl(sym);
    q.name      = companyNames[sym] || sym;
  }

  return quotes;
}

// Full quote for a single symbol (includes market depth for pressure)
async function fetchFullQuote(sym) {
  const q = await growwQuote(sym);
  if (!q) return null;
  liveQuotes[sym] = q;
  return q;
}

// ══════════════════════════════════════════════════════════════
// ★★★ AI PREDICTION ENGINE ★★★
// Multi-factor analysis using Groww historical + live data
// ══════════════════════════════════════════════════════════════

function buildPrediction(sym, snap, liveQ, histData) {
  const { t915, t925, open } = snap;
  const daily = histData?.daily || [];
  const m5    = histData?.m5    || [];

  // ── FACTOR 1: Opening 10-min momentum (THE CORE, from v4) ──
  const dev10  = t915>0 ? +((t925-t915)/t915*100).toFixed(2) : 0;
  const devDay = open>0 && liveQ ? +((liveQ.ltp-open)/open*100).toFixed(2) : dev10;

  // ── FACTOR 2: 5-min VWAP ──
  const vwap = m5.length ? calcVWAP(m5) : 0;
  const ltp  = liveQ?.ltp || t925;
  const vwapDev = vwap>0 ? +((ltp-vwap)/vwap*100).toFixed(2) : 0;
  const aboveVWAP = ltp > vwap;

  // ── FACTOR 3: RSI from 5-min closes ──
  const m5closes = m5.map(c=>c[4]);
  const rsi5m = m5closes.length >= 15 ? calcRSI(m5closes) : 50;

  // ── FACTOR 4: EMA stack from daily closes ──
  const dayCloses = daily.map(c=>c[4]);
  const ema9   = calcEMA(dayCloses, 9);
  const ema21  = calcEMA(dayCloses, 21);
  const ema50  = calcEMA(dayCloses, 50);
  const emaStack = ema9&&ema21&&ema50 ? (ema9>ema21&&ema21>ema50?'BULL':ema9<ema21&&ema21<ema50?'BEAR':'MIXED') : 'MIXED';

  // ── FACTOR 5: Prev day candle pattern ──
  const prevDayCandle = daily.length>=2 ? daily[daily.length-2] : null;
  let candleSignal = 0; // positive=bullish, negative=bearish
  if (prevDayCandle) {
    const [,po,ph,pl,pc] = prevDayCandle;
    const range = ph-pl, body=Math.abs(pc-po);
    const isBull = pc>po;
    const closePos = range>0?(pc-pl)/range:0.5;
    const bodyRatio= range>0?body/range:0;
    if (isBull && bodyRatio>0.6 && closePos>0.65)      candleSignal=+2;
    else if (!isBull && bodyRatio>0.6 && closePos<0.35) candleSignal=-2;
    else if (isBull)                                     candleSignal=+1;
    else                                                 candleSignal=-1;
  }

  // ── FACTOR 6: Buy/Sell depth pressure (from full quote) ──
  let buyPressure = 50; // default 50%
  if (liveQ?.total_buy_quantity && liveQ?.total_sell_quantity) {
    const total = liveQ.total_buy_quantity + liveQ.total_sell_quantity;
    buyPressure = total>0 ? Math.round(liveQ.total_buy_quantity/total*100) : 50;
  }
  const depthSignal = buyPressure>60?1:buyPressure<40?-1:0;

  // ── FACTOR 7: ATR volatility ──
  const atr = calcATR(daily);

  // ── FACTOR 8: Pivot points (from previous day) ──
  let pivots = null;
  if (prevDayCandle) {
    pivots = pivotPoints(prevDayCandle[2], prevDayCandle[3], prevDayCandle[4]);
  }

  // ── COMPOSITE SCORING (0-100) ──
  let bullScore = 0, bearScore = 0;
  const reasons = [];

  // Dev10 (weight: 35)
  if (dev10 > 2.0)        { bullScore += 35; reasons.push(`📈 Strong open +${dev10}% in 10 min`); }
  else if (dev10 > 1.0)   { bullScore += 22; reasons.push(`📈 Bullish open +${dev10}%`); }
  else if (dev10 > 0.3)   { bullScore += 12; reasons.push(`📈 Mild open +${dev10}%`); }
  else if (dev10 < -2.0)  { bearScore += 35; reasons.push(`📉 Strong drop ${dev10}% at open`); }
  else if (dev10 < -1.0)  { bearScore += 22; reasons.push(`📉 Bearish open ${dev10}%`); }
  else if (dev10 < -0.3)  { bearScore += 12; reasons.push(`📉 Mild drop ${dev10}%`); }
  else                     { reasons.push(`⚖️ Flat open (${dev10}%)`); }

  // VWAP (weight: 20)
  if (aboveVWAP && vwap>0)   { bullScore += 20; reasons.push(`✅ Above VWAP ₹${vwap} (+${vwapDev.toFixed(2)}%)`); }
  else if (!aboveVWAP && vwap>0) { bearScore += 20; reasons.push(`🔴 Below VWAP ₹${vwap} (${vwapDev.toFixed(2)}%)`); }

  // RSI (weight: 15)
  if (rsi5m >= 60 && rsi5m < 75)     { bullScore += 15; reasons.push(`✅ RSI ${rsi5m} — bullish momentum`); }
  else if (rsi5m <= 40 && rsi5m > 25){ bearScore += 15; reasons.push(`🔴 RSI ${rsi5m} — bearish momentum`); }
  else if (rsi5m >= 75)               { bearScore += 8;  reasons.push(`⚠️ RSI ${rsi5m} overbought`); }
  else if (rsi5m <= 25)               { bullScore += 8;  reasons.push(`⚠️ RSI ${rsi5m} oversold — bounce`); }
  else                                { reasons.push(`RSI ${rsi5m} neutral`); }

  // EMA stack (weight: 12)
  if (emaStack==='BULL')        { bullScore += 12; reasons.push(`✅ EMA9>EMA21>EMA50 bull stack`); }
  else if (emaStack==='BEAR')   { bearScore += 12; reasons.push(`🔴 EMA9<EMA21<EMA50 bear stack`); }

  // Candle pattern (weight: 10)
  if (candleSignal >= 2)        { bullScore += 10; reasons.push(`✅ Strong bull candle yesterday`); }
  else if (candleSignal === 1)  { bullScore += 5;  reasons.push(`📈 Bullish candle yesterday`); }
  else if (candleSignal <= -2)  { bearScore += 10; reasons.push(`🔴 Strong bear candle yesterday`); }
  else if (candleSignal === -1) { bearScore += 5;  reasons.push(`📉 Bearish candle yesterday`); }

  // Depth pressure (weight: 8)
  if (depthSignal === 1)        { bullScore += 8;  reasons.push(`✅ ${buyPressure}% buy pressure in depth`); }
  else if (depthSignal === -1)  { bearScore += 8;  reasons.push(`🔴 ${100-buyPressure}% sell pressure in depth`); }

  // ── ACTION & CONFIDENCE ──
  const total = bullScore + bearScore;
  const bullPct = total>0 ? bullScore/total : 0.5;
  const confidence = Math.min(90, Math.round(Math.abs(bullPct-0.5)*200));
  let action = 'HOLD';
  if (bullScore > bearScore + 15 && bullPct > 0.55)  action = 'BUY';
  if (bearScore > bullScore + 15 && bullPct < 0.45)  action = 'SELL';

  // ── TARGETS & STOP LOSS (from core v4 formula + pivot refinement) ──
  const absMove = Math.abs(dev10);
  const targetMultiplier = absMove<0.5?1.2:absMove<1?1.4:absMove<1.5?1.6:absMove<2?1.8:absMove<3?2.2:2.5;
  const stopMultiplier   = absMove<0.5?0.3:absMove<1?0.5:absMove<2?0.7:absMove<3?1.0:1.5;

  let targetPct   = action==='BUY'  ?  +(dev10*targetMultiplier).toFixed(2)
                  : action==='SELL' ? -(absMove*targetMultiplier).toFixed(2) : 0;
  let stopPct     = action==='BUY'  ? -stopMultiplier : action==='SELL' ? stopMultiplier : 0;

  // Override with pivot levels if available
  if (pivots && action === 'BUY' && pivots.r1 > t915) {
    const pivotTarget = +((pivots.r1-t915)/t915*100).toFixed(2);
    if (pivotTarget > 0) targetPct = Math.max(targetPct, pivotTarget*0.8); // blend
    stopPct = Math.min(stopPct, -+((t915-pivots.s1)/t915*100).toFixed(2));
  } else if (pivots && action === 'SELL' && pivots.s1 < t915) {
    const pivotTarget = +((t915-pivots.s1)/t915*100).toFixed(2);
    if (pivotTarget > 0) targetPct = Math.min(targetPct, -pivotTarget*0.8);
  }

  const targetPrice   = action!=='HOLD' ? +(t915*(1+targetPct/100)).toFixed(2) : 0;
  const stopLossPrice = action!=='HOLD' ? +(t915*(1+stopPct/100)).toFixed(2) : 0;
  const rr = stopPct!==0 ? +(Math.abs(targetPct)/Math.abs(stopPct)).toFixed(1) : 0;

  // ── FULL DAY PREDICTION TEXT ──
  const name = companyNames[sym] || sym;
  let prediction;
  if (action === 'BUY') {
    prediction = `📈 ${name} EXPECTED TO RISE ~${targetPct.toFixed(1)}% today. ` +
      `Open ₹${t915} → Target ₹${targetPrice} (+${targetPct}%) | Stop ₹${stopLossPrice}. R:R=${rr}:1. ` +
      (rsi5m>50?`RSI ${rsi5m}. `:'') + (aboveVWAP?'Above VWAP. ':'') +
      `Based on +${dev10}% in first 10 min (${emaStack} EMA).`;
  } else if (action === 'SELL') {
    prediction = `📉 ${name} EXPECTED TO FALL ~${Math.abs(targetPct).toFixed(1)}% today. ` +
      `Open ₹${t915} → Target ₹${targetPrice} (${targetPct}%) | Stop ₹${stopLossPrice}. R:R=${rr}:1. ` +
      (rsi5m<50?`RSI ${rsi5m}. `:'') + (!aboveVWAP?'Below VWAP. ':'') +
      `Based on ${dev10}% in first 10 min (${emaStack} EMA).`;
  } else {
    prediction = `⚖️ ${name} — no clear direction. Open ${dev10>=0?'+':''}${dev10}% | RSI ${rsi5m} | ${emaStack} EMA. Wait for 10:00 AM confirmation.`;
  }

  const gUrl = growwUrl(sym);

  return {
    symbol:sym, name, action, confidence,
    prediction, bullScore, bearScore, buyPressure,
    // Prices
    open915Price: t915, lockedAtPrice: t925,
    currentPrice: ltp, targetPrice, stopLossPrice,
    targetPct: +targetPct.toFixed(2), stopPct: +stopPct.toFixed(2),
    riskReward: rr,
    // Deviation
    dev10, devDay, devFromOpen: devDay,
    // Indicators
    rsi: rsi5m, vwap, vwapDev, aboveVWAP,
    ema9, ema21, ema50, emaStack, atr,
    pivots, candleSignal,
    // Depth
    totalBuyQty:  liveQ?.total_buy_quantity  || 0,
    totalSellQty: liveQ?.total_sell_quantity || 0,
    reasons: reasons.slice(0,5),
    // Status (live updated)
    currentStatus: 'LOCKED 🔒',
    progressPct: 0,
    // Groww MIS links
    growwUrl: gUrl,
    growwBuyUrl:  `${gUrl}?action=buy`,
    growwSellUrl: `${gUrl}?action=sell`,
    lockedAt: new Date().toISOString(),
  };
}

// ══════════════════════════════════════════════════════════════
// SNAPSHOT CAPTURE (v4 exact timing)
// ══════════════════════════════════════════════════════════════
async function capture915Snapshot() {
  console.log('\n[9:15] 📸 Capturing opening prices...');
  const syms = getAllSymbols();

  // Use batch OHLC for speed
  const ohlcMap = await growwOHLC(syms);
  const ltpMap  = await growwLTP(syms);

  for (const sym of syms) {
    const ohlcKey = `NSE_${sym}`;
    const ohlc    = ohlcMap[ohlcKey];
    const ltp     = ltpMap[ohlcKey] || 0;
    if (ohlc) {
      openingSnaps[sym] = {
        t915: ltp || ohlc.open || ohlc.close,
        open: ohlc.open,
      };
    }
  }
  snapshotStatus = 't915_done';
  console.log(`[9:15] ✅ Captured ${Object.keys(openingSnaps).length} opening prices`);
}

async function capture925AndLock() {
  console.log('\n[9:25] 📸 Capturing 10-min prices + generating predictions...');
  const syms = getAllSymbols();
  const ltpMap = await growwLTP(syms);

  for (const sym of syms) {
    const key = `NSE_${sym}`;
    const ltp = ltpMap[key];
    if (ltp && openingSnaps[sym]) {
      openingSnaps[sym].t925 = ltp;
    } else if (!openingSnaps[sym] && ltp) {
      // Server started late — use current price for both
      openingSnaps[sym] = { t915: ltp, t925: ltp, open: ltp };
    }
  }

  // Fetch full quotes for top stocks (for depth analysis)
  const top15 = syms.slice(0,15);
  for (const sym of top15) {
    await fetchFullQuote(sym);
    await sleep(100);
  }

  // Also load 5-min candles for indicators
  for (let i=0; i<top15.length; i+=3) {
    const batch = top15.slice(i,i+3);
    await Promise.all(batch.map(async s => {
      if (!histCache[s]) histCache[s] = {};
      histCache[s].m5 = await fetchToday5min(s);
    }));
    await sleep(300);
  }

  // Build predictions for all symbols with snapshots
  lockedPredictions = Object.entries(openingSnaps)
    .filter(([,snap]) => snap.t915>0)
    .map(([sym, snap]) => {
      const liveQ = liveQuotes[sym] || null;
      const hist  = histCache[sym]  || {};
      return buildPrediction(sym, snap, liveQ, hist);
    })
    .filter(Boolean);

  snapshotStatus = 'locked';
  const buy  = lockedPredictions.filter(p=>p.action==='BUY').length;
  const sell = lockedPredictions.filter(p=>p.action==='SELL').length;
  console.log(`\n[9:25] ✅ ${lockedPredictions.length} predictions locked | ${buy} BUY | ${sell} SELL`);
  lockedPredictions.filter(p=>p.action!=='HOLD').forEach(p =>
    console.log(`  ${p.action} ${p.symbol.padEnd(14)} conf:${p.confidence}% | dev10:${p.dev10}% | ${p.reasons[0]||''}`)
  );
}

// ══════════════════════════════════════════════════════════════
// LIVE PRICE UPDATE (every 3 min after lock)
// ══════════════════════════════════════════════════════════════
async function updateLivePrices() {
  if (!lockedPredictions.length) return;
  const syms   = lockedPredictions.map(p=>p.symbol);
  const ltpMap = await growwLTP(syms);

  lockedPredictions = lockedPredictions.map(p => {
    const key = `NSE_${p.symbol}`;
    const ltp = ltpMap[key] || p.currentPrice;
    if (!ltp) return p;

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
      ? +(p.targetPct-currentDev).toFixed(2)
      : +(currentDev-p.targetPct).toFixed(2);

    // Rebuild live prediction text
    let prediction = p.prediction;
    if (p.action!=='HOLD') {
      const dir = isBuy?'📈 RISE':'📉 FALL';
      prediction = `${dir} ~${Math.abs(p.targetPct).toFixed(1)}% today. `+
        `Open ₹${p.open915Price} → Target ₹${p.targetPrice} | Stop ₹${p.stopLossPrice}. R:R=${p.riskReward}:1. `+
        (remaining>0?`~${remaining.toFixed(1)}% ${isBuy?'more to go':'more to fall'}. `:'TARGET ZONE! ')+
        `[Live ₹${ltp.toFixed(1)} | ${currentDev>=0?'+':''}${currentDev.toFixed(2)}% from open]`;
    }

    return { ...p, currentPrice:+ltp.toFixed(2), devFromOpen:currentDev, progressPct, currentStatus, prediction };
  });
}

// Fallback when server started late
function generateFallbackFromLive(quotes) {
  console.log('[Fallback] Building predictions from current open prices...');
  const preds = [];
  for (const [sym, q] of Object.entries(quotes)) {
    const open = q.open || q.ltp;
    const ltp  = q.ltp || open;
    if (!open || !ltp) continue;
    openingSnaps[sym] = { t915:open, t925:ltp, open };
    const hist = histCache[sym] || {};
    const pred = buildPrediction(sym, { t915:open, t925:ltp, open }, null, hist);
    if (pred) preds.push(pred);
  }
  lockedPredictions = preds;
  snapshotStatus    = 'fallback';
  console.log(`[Fallback] ${preds.filter(p=>p.action!=='HOLD').length} active predictions`);
}

// ══════════════════════════════════════════════════════════════
// MAIN LOOP
// ══════════════════════════════════════════════════════════════
async function mainRefresh() {
  console.log(`\n[Bot] ─── ${istStr()} | ${marketPhase()} ───`);
  try {
    const quotes = await fetchAllLiveData();
    dataStore.quotes     = quotes;
    dataStore.lastUpdated = new Date().toISOString();

    const { totalMins, day } = getIST();
    const pastOpen = day>=1&&day<=5&&totalMins>=9*60+25&&totalMins<15*60+30;

    // Late start — generate from current open
    if (pastOpen && !lockedPredictions.length) {
      generateFallbackFromLive(quotes);
    }

    // Update live prices in locked predictions
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
    mtfStocks:         mtfStocks.length,
    lastUpdated:       dataStore.lastUpdated,
  });
});

app.get('/api/quotes', (_, res) => {
  maybeRefresh(); // trigger background refresh if stale
  res.json({ quotes:dataStore.quotes, lastUpdated:dataStore.lastUpdated });
});

// ★ MAIN PREDICTION ENDPOINT
app.get('/api/mtf/live', (req, res) => {
  maybeRefresh(); // trigger background refresh if stale
  const { action, limit=50 } = req.query;
  let preds = [...lockedPredictions];

  if (action) preds = preds.filter(p=>p.action===action.toUpperCase());

  // Sort: active signals first, then by |dev10| desc, then by confidence desc
  preds.sort((a,b) => {
    const r={BUY:0,SELL:1,HOLD:2};
    if (r[a.action]!==r[b.action]) return r[a.action]-r[b.action];
    return Math.abs(b.dev10)-Math.abs(a.dev10)||b.confidence-a.confidence;
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

// MTF stock list with predictions merged in
app.get('/api/mtf/stocks', (_, res) => res.json({
  stocks: mtfStocks.map(s => ({
    ...s,
    growwUrl: growwUrl(s.symbol),
    companyName: companyNames[s.symbol] || s.companyName,
    prediction: lockedPredictions.find(p=>p.symbol===s.symbol) || null,
    liveQuote:  dataStore.quotes?.[s.symbol] || null,
  })),
  count:       mtfStocks.length,
  lastFetched: dataStore.lastUpdated,
}));

// Full analysis for one stock
app.get('/api/analyze/:sym', async (req,res) => {
  const sym   = req.params.sym.toUpperCase();
  const quote = await growwQuote(sym);
  if (!histCache[sym]) await loadHistoryForSym(sym);
  const hist  = histCache[sym] || {};
  const snap  = openingSnaps[sym] || { t915:quote?.last_price||0, t925:quote?.last_price||0 };
  const pred  = buildPrediction(sym, snap, quote, hist);
  res.json({ symbol:sym, quote, prediction:pred, indicators:{
    rsi:pred?.rsi, vwap:pred?.vwap, ema9:pred?.ema9, ema21:pred?.ema21, pivots:pred?.pivots,
  }});
});

// Historical candles endpoint (for frontend chart)
app.get('/api/candles/:sym', async (req,res) => {
  const sym = req.params.sym.toUpperCase();
  const tf  = parseInt(req.query.interval||'5');
  const days= parseInt(req.query.days||'1');
  const end  = dateStr(0)  + ' 15:30:00';
  const start= dateStr(-days) + ' 09:15:00';
  const candles = await growwCandles(sym, tf, start, end);
  res.json({ symbol:sym, interval:tf, candles });
});

// Debug
app.get('/api/debug', (_,res) => res.json({
  snapshotStatus, phase:marketPhase(),
  snapshots: Object.fromEntries(
    Object.entries(openingSnaps).slice(0,10).map(([k,v])=>[k,{t915:v.t915,t925:v.t925}])
  ),
  activePredictions: lockedPredictions.filter(p=>p.action!=='HOLD').length,
}));

app.post('/api/refresh', async(_,res) => {
  await mainRefresh();
  res.json({ success:true, predictions:lockedPredictions.filter(p=>p.action!=='HOLD').length });
});
app.post('/api/reset', (_,res) => {
  Object.keys(openingSnaps).forEach(k=>delete openingSnaps[k]);
  lockedPredictions = [];
  snapshotStatus    = 'waiting';
  res.json({ success:true });
});
app.post('/api/load-history', async(_,res) => {
  await loadAllHistory();
  res.json({ success:true, symbols:Object.keys(histCache).length });
});

// ══════════════════════════════════════════════════════════════
// CRON ENDPOINTS — called by Vercel crons (vercel.json)
// Also work as manual triggers via GET /api/cron/*
// On local: a simple setInterval polls mainRefresh every 3 min
// ══════════════════════════════════════════════════════════════

// 8:00 IST = 2:30 UTC — refresh MTF most-traded list
app.get('/api/cron/mtf-refresh', async (_, res) => {
  console.log('[Cron] mtf-refresh');
  const fresh = await fetchGrowwMostTraded();
  if (fresh.length) mtfStocks = fresh;
  res.json({ ok: true, mtfStocks: mtfStocks.length, ts: istStr() });
});

// 8:30 IST = 3:00 UTC — load historical candles pre-market
app.get('/api/cron/load-history', async (_, res) => {
  console.log('[Cron] load-history');
  await loadAllHistory();
  res.json({ ok: true, symbols: Object.keys(histCache).length, ts: istStr() });
});

// 9:15 IST = 3:45 UTC — capture opening prices
app.get('/api/cron/snapshot-915', async (_, res) => {
  console.log('[Cron] snapshot-915');
  await capture915Snapshot();
  res.json({ ok: true, snaps: Object.keys(openingSnaps).length, ts: istStr() });
});

// 9:25 IST = 3:55 UTC — lock predictions from 10-min momentum
app.get('/api/cron/snapshot-925', async (_, res) => {
  console.log('[Cron] snapshot-925');
  await capture925AndLock();
  const buy  = lockedPredictions.filter(p => p.action === 'BUY').length;
  const sell = lockedPredictions.filter(p => p.action === 'SELL').length;
  res.json({ ok: true, total: lockedPredictions.length, buy, sell, ts: istStr() });
});

// Every 3 min during market hours — update live prices + quotes
app.get('/api/cron/refresh', async (_, res) => {
  console.log('[Cron] refresh');
  await mainRefresh();
  res.json({ ok: true, quotes: Object.keys(dataStore.quotes).length,
    active: lockedPredictions.filter(p => p.action !== 'HOLD').length, ts: istStr() });
});

// 16:00 IST = 10:30 UTC — daily reset
app.get('/api/cron/reset', (_, res) => {
  console.log('[Cron] reset');
  Object.keys(openingSnaps).forEach(k => delete openingSnaps[k]);
  lockedPredictions = [];
  snapshotStatus    = 'waiting';
  console.log('[Cron] ✅ Daily reset — ready for next session');
  res.json({ ok: true, ts: istStr() });
});

// ── LOCAL FALLBACK — simple interval when running with node server.js ──
// Vercel uses the cron endpoints above; locally we poll every 3 min
if (require.main === module) {
  setInterval(async () => {
    const { totalMins, day } = getIST();
    if (day < 1 || day > 5) return;                          // skip weekends
    if (totalMins < 9*60+15 || totalMins >= 15*60+30) return; // skip outside market
    await mainRefresh();
  }, 3 * 60 * 1000); // every 3 min
}

// ══════════════════════════════════════════════════════════════
// STARTUP
// ══════════════════════════════════════════════════════════════
async function init() {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  ⚡ TradeBot v15 — Groww MTF Most-Traded Edition         ║
║  http://localhost:${PORT}                                    ║
╠══════════════════════════════════════════════════════════╣
║  Source:   groww.in/stocks/mtf/most-traded (live scrape) ║
║  Engine:   9:15 vs 9:25 momentum + 7 technical factors   ║
║  Targets:  Pivot-adjusted, R:R based stop loss           ║
║  Refresh:  Every 3 min (prices) + 30 min (MTF list)      ║
╚══════════════════════════════════════════════════════════╝`);

  // Step 1 — Scrape Groww MTF most-traded list
  console.log('\n[Init] 🔍 Scraping Groww MTF most-traded list...');
  mtfStocks = await fetchGrowwMostTraded();

  if (mtfStocks.length) {
    console.log(`[Init] ✅ ${mtfStocks.length} MTF stocks loaded:`);
    // Print table like the Python script
    console.log(`  ${'Company'.padEnd(32)} ${'NSE'.padEnd(12)} ${'LTP'.padStart(10)} ${'Chg%'.padStart(8)} ${'Haircut'.padStart(9)}`);
    console.log('  ' + '─'.repeat(80));
    mtfStocks.forEach(s => {
      const chg = (s.dayChangePct||0).toFixed(2);
      const sign = s.dayChangePct>=0?'+':'';
      console.log(`  ${(s.companyName||s.symbol).slice(0,32).padEnd(32)} ${s.symbol.padEnd(12)} ₹${String((s.ltp||0).toFixed(1)).padStart(9)} ${(sign+chg+'%').padStart(8)} ${((s.haircut||0).toFixed(1)+'%').padStart(9)}`);
    });
  } else {
    console.log('[Init] ⚠️  MTF scrape failed — using BASE_STOCKS fallback');
  }

  // Step 2 — Load 5-day historical candles for all MTF stocks
  console.log('\n[Init] 📊 Loading historical candles...');
  await loadAllHistory();

  // Step 3 — Run initial data refresh + generate predictions if market is open
  const { totalMins, day } = getIST();
  const phase = marketPhase();
  console.log(`\n[Init] 🕐 ${istStr()} | Phase: ${phase}`);

  await mainRefresh();

  // Step 4 — If already past 9:25, generate fallback predictions immediately
  if (day>=1&&day<=5&&totalMins>=9*60+25&&totalMins<15*60+30 && !lockedPredictions.length) {
    console.log('[Init] ⚡ Market open past 9:25 — generating fallback predictions from open prices');
    generateFallbackFromLive(dataStore.quotes);
  }

  const active = lockedPredictions.filter(p=>p.action!=='HOLD').length;
  console.log(`\n╔══════════════════════════════════════════════════════════╗`);
  console.log(`║  ✅ READY at ${istStr()}                              ║`);
  console.log(`║  Phase: ${phase.padEnd(20)} MTF Stocks: ${mtfStocks.length}           ║`);
  console.log(`║  Active Predictions: ${String(active).padEnd(4)} (${lockedPredictions.filter(p=>p.action==='BUY').length} BUY / ${lockedPredictions.filter(p=>p.action==='SELL').length} SELL)         ║`);
  console.log(`║  Dashboard: http://localhost:${PORT}                         ║`);
  console.log(`╚══════════════════════════════════════════════════════════╝\n`);
}

// ══════════════════════════════════════════════════════════════
// START — local dev OR Vercel serverless
// ══════════════════════════════════════════════════════════════

// Vercel serverless: lazy-init on first request
let _initialized = false;
const _originalHandle = app.handle.bind(app);
app.handle = async (req, res, next) => {
  if (!_initialized) {
    _initialized = true;
    try { await init(); } catch(e) { console.error('[Init Error]', e.message); }
  }
  _originalHandle(req, res, next);
};

// Local: listen immediately
if (require.main === module) {
  app.listen(PORT, init);
}

module.exports = app;