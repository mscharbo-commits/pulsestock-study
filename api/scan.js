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

  // Curated universes per strategy — tight, high quality
  const MOMENTUM_UNIVERSE = [
    // AI/Semiconductors
    'NVDA','AMD','AVGO','AMAT','KLAC','LRCX','MRVL','ARM','TSM','ASML',
    'QCOM','TXN','INTC','MU','MPWR','ON','WOLF',
    // Cloud/SaaS high growth
    'NOW','CRM','ADBE','PANW','CRWD','DDOG','SNOW','PLTR','ZS','NET',
    'FTNT','OKTA','HUBS','TEAM','WDAY','VEEV','MDB','GTLB',
    // Fintech/Payments
    'V','MA','PYPL','SQ','AFRM','UPST','COIN','HOOD','SOFI',
    // Biotech momentum
    'ISRG','DXCM','IDXX','ALGN','INSP','AXON','TMDX',
    // Industrial momentum
    'STRL','TRGP','GEV','VRT','ETN','PWR','ONTO',
    // Consumer momentum  
    'LULU','CELH','ELF','BOOT','DECK','RCL','UAL','DAL',
    // AI infrastructure
    'DELL','HPE','SMCI','ALAB','CRDO','CIEN',
    // High momentum misc
    'APP','TTD','RBLX','UBER','ABNB','DASH'
  ];

  const COMPOUNDER_UNIVERSE = [
    // Quality moat businesses
    'MSFT','AAPL','GOOGL','META','AMZN',
    'V','MA','AXP','SPGI','MCO','MSCI','FICO',
    'UNH','TMO','DHR','ISRG','ABT','SYK','EW',
    'COST','WMT','HD','LOW','MCD','SBUX',
    'NOW','CRM','ADBE','INTU','VEEV','PAYC',
    'PANW','CRWD','FTNT',
    'ODFL','CTAS','CPRT','POOL','WSO','ROP',
    'CB','PGR','AJG','MMC',
    'NVDA','AVGO','AMAT','KLAC','ASML',
    'BRK.B','JPM','BAC','GS','BLK',
    'LLY','ABBV','REGN','BMY',
    'AMT','EQIX','PSA',
    'AXON','TMDX','DXCM','IDXX',
    'NKE','LULU','ELF'
  ];

  const CATALYST_UNIVERSE = [
    // Earnings this week/next
    'JPM','BAC','WFC','GS','MS','C','BLK',
    'NFLX','TSLA','NVDA','ASML','TSM',
    'JNJ','UNH','LLY','PFE',
    'AMZN','GOOGL','META','MSFT','AAPL',
    // High beta momentum
    'PLTR','HOOD','COIN','AFRM','APP',
    'CRWD','DDOG','SNOW','NET','ZS',
    'UBER','ABNB','DASH',
    'AMD','MU','AVGO','ARM',
    'STRL','VRT','ALAB','CRDO'
  ];

  // No batch = return appropriate universe based on strategy param
  if (!batch.length) {
    const strategy = req.query.strategy || 'momentum';
    let universe;
    if (strategy === 'compounder') universe = COMPOUNDER_UNIVERSE;
    else if (strategy === 'catalyst') universe = CATALYST_UNIVERSE;
    else universe = MOMENTUM_UNIVERSE;
    res.status(200).json({ tickers: universe, keys: { finnhub: !!FINNHUB, polygon: !!POLYGON } });
    return;
  }

  function scoreStock(d, strategy) {
    const { cur, vwap, rangePos, pctFromHigh, pctAboveLow, rsi, r6m, dollarVol } = d;
    
    if (strategy === 'momentum') {
      // Hard gates — must pass ALL
      if (!cur || !vwap || cur <= vwap) return null;        // must be above VWAP
      if (!rangePos || rangePos < 60) return null;           // must be in strong uptrend
      if (!pctFromHigh || pctFromHigh < -20) return null;   // within 20% of 52W high
      if (!rsi || rsi < 52 || rsi > 78) return null;        // RSI strength zone
      if (!r6m || r6m < 8) return null;                     // must show momentum
      if (dollarVol < 15) return null;                       // institutional liquidity
      
      // Scoring — each component truly differentiated
      let s = 0;
      // 6-month return — continuous scoring, primary differentiator (40 points)
      // Each % of return adds 0.4 points, capped at 40
      // This ensures DDOG+105% scores higher than BMO+32%
      s += Math.min(r6m * 0.4, 40);
      
      // Range position (25 points) — higher in range = stronger trend
      if (rangePos >= 90) s += 25;
      else if (rangePos >= 80) s += 20;
      else if (rangePos >= 70) s += 14;
      else s += 8;
      
      // RSI quality (20 points) — ideal zone 55-70
      if (rsi >= 58 && rsi <= 70) s += 20;
      else if (rsi >= 54 && rsi <= 74) s += 14;
      else s += 7;
      
      // Dollar volume (15 points) — institutional participation
      if (dollarVol >= 100) s += 15;
      else if (dollarVol >= 50) s += 12;
      else if (dollarVol >= 25) s += 8;
      else s += 4;
      
      return s; // max theoretical = 100, but requires 60%+ 6m return + 90%+ range + perfect RSI + high volume
    }
    
    if (strategy === 'compounder') {
      // Pure technical filter — Sonnet finds fundamentals via web search during deep dive
      // This ensures every stock in universe gets a fair shot
      if (!rangePos || rangePos < 40) return null;     // must be in uptrend
      if (!rsi || rsi < 40 || rsi > 78) return null;  // healthy RSI range
      if (dollarVol < 5) return null;                   // minimum liquidity
      if (!r6m || r6m < -10) return null;              // not in freefall

      let s = 0;

      // Range position — price structure (35 points)
      if (rangePos >= 80) s += 35;
      else if (rangePos >= 65) s += 25;
      else if (rangePos >= 50) s += 15;
      else s += 8;

      // RSI — entry timing (25 points)
      if (rsi >= 48 && rsi <= 65) s += 25;
      else if (rsi >= 42 && rsi <= 72) s += 16;
      else s += 8;

      // VWAP — institutional positioning (20 points)
      s += cur > vwap ? 20 : 8;

      // 6-month return — momentum confirmation (20 points)
      s += Math.min(Math.max(r6m * 0.2, 0), 20);

      return s;
    }
    
    if (strategy === 'catalyst') {
      if (!cur || !vwap || cur <= vwap) return null;
      if (!rsi || rsi < 38 || rsi > 70) return null;
      if (!rangePos || rangePos < 30 || rangePos > 90) return null;
      if (dollarVol < 8) return null;
      
      const vwapDev = (cur - vwap) / vwap * 100;
      let s = 0;
      
      // VWAP deviation (35 points) — just above VWAP is ideal
      if (vwapDev <= 1.5) s += 35;
      else if (vwapDev <= 3) s += 26;
      else if (vwapDev <= 6) s += 16;
      else s += 8;
      
      // RSI sweet spot (30 points) — 50-65 = room to run
      if (rsi >= 52 && rsi <= 63) s += 30;
      else if (rsi >= 45 && rsi <= 68) s += 20;
      else s += 10;
      
      // Range position (20 points) — prefer mid-range
      const distFromMid = Math.abs(rangePos - 62);
      if (distFromMid <= 10) s += 20;
      else if (distFromMid <= 20) s += 13;
      else s += 6;
      
      // 6-month return (15 points)
      if ((r6m||0) >= 15) s += 15;
      else if ((r6m||0) >= 5) s += 10;
      else if ((r6m||0) >= 0) s += 5;
      
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
    const hist = await sf(`https://api.polygon.io/v2/aggs/ticker/${ticker}/range/1/day/${yearAgo}/${today}?adjusted=true&sort=asc&limit=260`, {
      headers: { 'Authorization': `Bearer ${POLYGON}` }
    });
    const bars = hist?.results || [];
    if (bars.length < 60) continue;

    const cur = r.c;
    const vwap = r.vw;
    const closes = bars.map(b => b.c);
    const high52 = Math.max(...bars.map(b => b.h));
    const low52 = Math.min(...bars.map(b => b.l));
    const rangePos = high52 > low52 ? Math.min((cur - low52) / (high52 - low52) * 100, 100) : null;
    const pctFromHigh = high52 > 0 ? (cur - high52) / high52 * 100 : null;
    const pctAboveLow = low52 > 0 ? (cur - low52) / low52 * 100 : null;
    const r6m = closes.length >= 126 ? (cur - closes[closes.length-126]) / closes[closes.length-126] * 100 : null;

    // RSI
    // Wilder's RSI - proper calculation using 14 period
    let avgGain = 0, avgLoss = 0;
    // First average
    for (let j = 1; j <= 14; j++) {
      const diff = closes[closes.length - 14 - 14 + j] - closes[closes.length - 14 - 14 + j - 1];
      if (diff > 0) avgGain += diff; else avgLoss -= diff;
    }
    avgGain /= 14; avgLoss /= 14;
    // Smooth
    for (let j = closes.length - 14; j < closes.length; j++) {
      const diff = closes[j] - closes[j-1];
      avgGain = (avgGain * 13 + (diff > 0 ? diff : 0)) / 14;
      avgLoss = (avgLoss * 13 + (diff < 0 ? -diff : 0)) / 14;
    }
    const rsi = avgLoss === 0 ? 100 : parseFloat((100 - 100/(1+avgGain/avgLoss)).toFixed(1));

    // Finnhub metrics for fundamentals
    const met = FINNHUB ? await sf(`https://finnhub.io/api/v1/stock/metric?symbol=${ticker}&metric=all&token=${FINNHUB}`) : null;
    const m = met?.metric || {};

    const d = { 
      cur, vwap, rangePos, pctFromHigh, pctAboveLow, rsi, r6m, 
      dollarVol: r.v * cur / 1e6,
      // Fundamentals from Finnhub
      roe: m.roeTTM || null,
      netMargin: m.netProfitMarginTTM || null,
      revenueGrowth: m.revenueGrowthTTMYoy || null,
      grossMargin: m.grossMarginTTM || null,
      debtEquity: m.totalDebt2TotalEquityAnnual || null,
      peRatio: m.peTTM || null
    };

    for (const strat of ['momentum', 'compounder', 'catalyst']) {
      let raw = scoreStock(d, strat);
      if (raw === null) continue;
      if (m.revenueGrowthTTMYoy > 0.1 && strat === 'momentum') raw += 5;
      if (m.roeTTM > 15 && strat === 'compounder') raw += 5;
      // Catalyst: bonus for upcoming earnings in next 14 days
      if (strat === 'catalyst' && req.query.earningsTickers) {
        const earningsSet = new Set(req.query.earningsTickers.split(','));
        if (earningsSet.has(ticker)) raw += 20;
      }
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
