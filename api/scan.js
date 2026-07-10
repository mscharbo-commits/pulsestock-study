// api/scan.js - Universe scanner using server-side API keys
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const FINNHUB = process.env.FINNHUB_KEY;
  const POLYGON = process.env.POLYGON_API_KEY;
  const TICKER_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';
  const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';

  async function sf(url, opts = {}) {
    try {
      const r = await fetch(url, { ...opts });
      return r.ok ? await r.json() : null;
    } catch(e) { return null; }
  }

  const batch = (req.query.batch || '').split(',').filter(Boolean);
  const today = req.query.date || new Date().toISOString().split('T')[0];
  const yearAgo = new Date(Date.now() - 380*86400000).toISOString().split('T')[0];

  // No batch = return universe + key status
  if (!batch.length) {
    const uni = await sf(TICKER_URL);
    res.status(200).json({ tickers: uni?.all || [], keys: { finnhub: !!FINNHUB, polygon: !!POLYGON } });
    return;
  }

  function scoreStock(d, strategy) {
    const { cur, vwap, rangePos, pctFromHigh, pctAboveLow, rsi, r6m, dollarVol } = d;
    if (strategy === 'momentum') {
      if (!cur || !vwap || cur <= vwap) return null;
      if (!rangePos || rangePos < 55) return null;
      if (!pctFromHigh || pctFromHigh < -25) return null;
      if (!rsi || rsi < 50 || rsi > 80) return null;
      if (!r6m || r6m < 5) return null;
      if (dollarVol < 10) return null;
      let s = Math.min(rangePos * 0.3, 25);
      s += pctFromHigh >= -10 ? 15 : pctFromHigh >= -20 ? 8 : 3;
      s += (pctAboveLow||0) >= 30 ? 10 : 0;
      s += rsi >= 55 && rsi <= 72 ? 15 : 8;
      s += 15;
      s += r6m >= 30 ? 20 : r6m >= 20 ? 14 : r6m >= 10 ? 8 : 4;
      return s;
    }
    if (strategy === 'compounder') {
      if (!rangePos || rangePos < 40) return null;
      if (!rsi || rsi > 78) return null;
      let s = Math.min(rangePos * 0.35, 30);
      s += rsi >= 45 && rsi <= 68 ? 20 : 10;
      s += cur > vwap ? 20 : 0;
      s += pctFromHigh >= -15 ? 15 : pctFromHigh >= -25 ? 8 : 3;
      s += (r6m||0) >= 15 ? 15 : (r6m||0) >= 5 ? 8 : 0;
      return s;
    }
    if (strategy === 'catalyst') {
      if (!cur || !vwap || cur <= vwap) return null;
      if (!rsi || rsi < 35 || rsi > 72) return null;
      if (!rangePos || rangePos < 25 || rangePos > 92) return null;
      const dev = (cur - vwap) / vwap * 100;
      let s = dev <= 2 ? 30 : dev <= 5 ? 20 : 12;
      s += rsi >= 50 && rsi <= 65 ? 30 : 18;
      s += (100 - Math.abs(rangePos - 60)) * 0.25;
      s += (r6m||0) >= 10 ? 12 : (r6m||0) >= 0 ? 6 : 0;
      return s;
    }
    return null;
  }

  const results = { momentum: [], compounder: [], catalyst: [] };

  for (const ticker of batch) {
    // Polygon prev day
    const prev = await sf(`https://api.polygon.io/v2/aggs/ticker/${ticker}/prev`, {
      headers: { 'Authorization': `Bearer ${POLYGON}` }
    });
    const r = prev?.results?.[0];
    if (!r || !r.c || !r.vw || r.c < 5) continue;
    if ((r.v * r.c) < 5e6) continue;

    // Polygon candle history for RSI + 6m return
    const hist = await sf(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${yearAgo}/${today}?adjusted=true&sort=asc&limit=130`, {
      headers: { 'Authorization': `Bearer ${POLYGON}` }
    });
    const bars = hist?.results || [];
    if (bars.length < 60) continue;

    const cur = r.c;
    const vwap = r.vw;
    const closes = bars.map(b => b.c);
    const high52 = Math.max(...bars.map(b => b.h));
    const low52 = Math.min(...bars.map(b => b.l));
    const rangePos = high52 > low52 ? (cur - low52) / (high52 - low52) * 100 : null;
    const pctFromHigh = high52 > 0 ? (cur - high52) / high52 * 100 : null;
    const pctAboveLow = low52 > 0 ? (cur - low52) / low52 * 100 : null;
    const r6m = closes.length >= 126 ? (cur - closes[closes.length-126]) / closes[closes.length-126] * 100 : null;

    // RSI
    let gains = 0, losses = 0;
    for (let j = closes.length - 14; j < closes.length; j++) {
      const diff = closes[j] - closes[j-1];
      if (diff > 0) gains += diff; else losses -= diff;
    }
    const rsi = losses === 0 ? 100 : parseFloat((100 - 100/(1+(gains/14)/(losses/14))).toFixed(1));

    // Finnhub metrics for fundamentals
    const met = FINNHUB ? await sf(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB}`) : null;
    const m = met?.metric || {};

    const d = { cur, vwap, rangePos, pctFromHigh, pctAboveLow, rsi, r6m, dollarVol: r.v * cur / 1e6 };

    for (const strat of ['momentum', 'compounder', 'catalyst']) {
      let raw = scoreStock(d, strat);
      if (raw === null) continue;
      if (m.revenueGrowthTTMYoy > 0.1 && strat === 'momentum') raw += 5;
      if (m.roeTTM > 15 && strat === 'compounder') raw += 5;
      const hash = ticker.split('').reduce((a,c) => a + c.charCodeAt(0), 0);
      const score = parseFloat(Math.min(raw + (hash%100)/1000, 100).toFixed(3));
      if (score >= 70) results[strat].push({ ticker, score, rsi, rangePos: parseFloat((rangePos||0).toFixed(1)), r6m: r6m ? parseFloat(r6m.toFixed(1)) : null, price: cur });
    }
  }

  // If save=true, persist to Supabase
  if (req.query.save === 'true') {
    for (const [strat, scored] of Object.entries(results)) {
      scored.sort((a,b) => b.score - a.score);
      if (!scored.length) continue;
      await sf(`${SUPABASE_URL}/rest/v1/pre_screened_candidates?strategy_id=eq.${strat}&trading_date=eq.${today}`, {
        method: 'DELETE', headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      for (let i = 0; i < scored.length; i++) {
        const c = scored[i];
        await sf(`${SUPABASE_URL}/rest/v1/pre_screened_candidates`, {
          method: 'POST',
          headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
          body: JSON.stringify({ strategy_id: strat, ticker: c.ticker, rank: i+1, screen_score: c.score, screen_reason: (c.score>=85?'STRONG_BUY':c.score>=80?'BUY':'WATCH')+' RSI:'+c.rsi+' Range:'+c.rangePos+'%', price: c.price, rsi: c.rsi, range_position: c.rangePos, trading_date: today })
        });
      }
    }
  }

  res.status(200).json(results);
};
