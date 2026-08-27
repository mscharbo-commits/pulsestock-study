// api/day-trade-scan.js — CommonJS
// Day Trade Scanner — pure technicals, catalyst-driven
// Runs pre-market (9:00am ET) — looks for TODAY's opportunities
// GET /api/day-trade-scan?secret=pulsestock2026
//
// Day trade rules — completely different from swing/position:
// - Fundamentals irrelevant for same-day trade
// - Price action, volume, momentum, catalyst = everything
// - Enter on first 30-min pullback to VWAP
// - Exit: EOD or +8% target or -4% stop, same day
//
// Cost: ~$0.02 per run (Haiku only, small candidate list)

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB  = process.env.FINNHUB_KEY  || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
const POLYGON  = process.env.POLYGON_API_KEY || '2c90554e-b7d3-485f-a497-b350eb8136f5';
const AV_KEY   = process.env.AV_KEY       || '9D1A2PAECG3F11MG';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';

async function sf(url, timeout=10000) {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, {signal: ctrl.signal});
    clearTimeout(id);
    return r.ok ? await r.json() : null;
  } catch(e) { return null; }
}

// ── TECHNICAL INDICATORS ──
// Calculated from quote data — no external library needed

function calcVWAP(candles) {
  // VWAP = sum(price * volume) / sum(volume)
  if (!candles || !candles.length) return null;
  let pvSum = 0, vSum = 0;
  for (const c of candles) {
    const typicalPrice = (c.h + c.l + c.c) / 3;
    pvSum += typicalPrice * c.v;
    vSum += c.v;
  }
  return vSum > 0 ? pvSum / vSum : null;
}

function calcRSI(closes, period=14) {
  if (!closes || closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const change = closes[i] - closes[i-1];
    if (change > 0) gains += change;
    else losses -= change;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return parseFloat((100 - (100 / (1 + rs))).toFixed(2));
}

function calcEMA(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let ema = values.slice(0, period).reduce((a,b) => a+b, 0) / period;
  for (let i = period; i < values.length; i++) {
    ema = values[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcMACD(closes) {
  if (!closes || closes.length < 26) return null;
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  if (!ema12 || !ema26) return null;
  return parseFloat((ema12 - ema26).toFixed(4));
}

function calcATR(candles, period=14) {
  // Average True Range — measures volatility
  if (!candles || candles.length < period) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].h - candles[i].l,
      Math.abs(candles[i].h - candles[i-1].c),
      Math.abs(candles[i].l - candles[i-1].c)
    );
    trs.push(tr);
  }
  return parseFloat((trs.slice(-period).reduce((a,b) => a+b, 0) / period).toFixed(4));
}

function calcBollingerBands(closes, period=20, stdDev=2) {
  if (!closes || closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a,b) => a+b, 0) / period;
  const variance = slice.reduce((sum, v) => sum + Math.pow(v - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: parseFloat((sma + stdDev * std).toFixed(2)),
    middle: parseFloat(sma.toFixed(2)),
    lower: parseFloat((sma - stdDev * std).toFixed(2)),
    bandwidth: parseFloat((2 * stdDev * std / sma * 100).toFixed(2))
  };
}

// ── GET INTRADAY CANDLES (1-minute) via Finnhub ──
async function getIntradayCandles(ticker) {
  const now = Math.floor(Date.now() / 1000);
  const marketOpen = now - (now % 86400) + (9 * 3600 + 30 * 60); // 9:30am today UTC
  const from = marketOpen - 7200; // 2 hours before open for pre-market context
  
  const data = await sf(
    `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=1&from=${from}&to=${now}&token=${FINNHUB}`
  );
  
  if (!data || data.s !== 'ok') return null;
  
  const candles = data.t.map((t, i) => ({
    t, o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i], v: data.v[i]
  }));
  
  return candles;
}

// ── GET DAILY CANDLES (last 60 days) ──
async function getDailyCandles(ticker, days=60) {
  const now = Math.floor(Date.now() / 1000);
  const from = now - (days * 86400);
  
  const data = await sf(
    `https://finnhub.io/api/v1/stock/candle?symbol=${ticker}&resolution=D&from=${from}&to=${now}&token=${FINNHUB}`
  );
  
  if (!data || data.s !== 'ok') return null;
  
  return data.t.map((t, i) => ({
    t, o: data.o[i], h: data.h[i], l: data.l[i], c: data.c[i], v: data.v[i]
  }));
}

// ── DAY TRADE SCORING ──
function scoreDayTrade(ticker, quote, intraday, daily, news) {
  const scores = {};
  const price = quote?.c || 0;
  const prevClose = quote?.pc || price;
  const gapPct = prevClose > 0 ? ((price - prevClose) / prevClose * 100) : 0;
  const todayVol = quote?.v || 0;

  // Calculate avg daily volume from daily candles (last 20 days)
  const avgDailyVol = daily && daily.length >= 20
    ? daily.slice(-20).reduce((s,c) => s+c.v, 0) / 20
    : todayVol || 1;
  
  const relativeVol = todayVol > 0 ? todayVol / avgDailyVol : 0;

  // SCORE 1: GAP (most important for day trade) — weight 25%
  // We want meaningful gap — too small = no momentum, too big = overextended
  const absGap = Math.abs(gapPct);
  scores.gap = absGap > 10 ? 6 :  // Overextended — risky
               absGap > 5  ? 10 : // Sweet spot
               absGap > 3  ? 8  : // Good
               absGap > 1  ? 5  : // Weak
                             2;   // No gap

  // SCORE 2: RELATIVE VOLUME — weight 25%
  // Real day traders only touch stocks with 3x+ relative volume
  scores.relVol = relativeVol > 5  ? 10 :
                  relativeVol > 3  ? 8  :
                  relativeVol > 2  ? 6  :
                  relativeVol > 1  ? 3  : 1;

  // SCORE 3: RSI — weight 15%
  // Day trade sweet spots: momentum plays 55-75, mean reversion <30 or >70
  const closes = daily ? daily.map(c => c.c) : [];
  const rsi = calcRSI([...closes, price]);
  scores.rsi = rsi === null ? 5 :
               (rsi >= 55 && rsi <= 75) ? 9 :  // Momentum zone
               (rsi >= 45 && rsi < 55)  ? 6 :  // Neutral
               (rsi > 75)               ? 4 :  // Overbought — risky
               (rsi < 30)               ? 8 :  // Oversold bounce candidate
                                          5;

  // SCORE 4: PRICE RANGE (optimal day trade range) — weight 10%
  scores.priceRange = price >= 5  && price <= 20  ? 10 :  // Ideal
                      price >= 2  && price < 5    ? 8  :  // Good
                      price > 20  && price <= 50  ? 7  :  // OK
                      price > 50  && price <= 100 ? 5  :  // Wider spreads
                      price > 100                 ? 3  :  // Hard to scalp
                                                    1;   // Sub-$2 trap

  // SCORE 5: VWAP POSITION — weight 15%
  // Price above VWAP = bullish day trade bias, below = bearish
  const vwap = intraday ? calcVWAP(intraday) : null;
  scores.vwap = vwap === null ? 5 :
                price > vwap * 1.02 ? 9 :   // Clearly above VWAP — long bias
                price > vwap        ? 7 :   // Above VWAP
                price > vwap * 0.98 ? 4 :   // Just below VWAP
                                      2;    // Well below VWAP — caution

  // SCORE 6: ATR (volatility = opportunity for day traders) — weight 10%
  const atr = daily ? calcATR(daily) : null;
  const atrPct = (atr && price > 0) ? (atr / price * 100) : 0;
  scores.atr = atrPct > 4  ? 10 :  // Very high volatility — great for day trade
               atrPct > 2  ? 8  :
               atrPct > 1  ? 6  :
               atrPct > 0.5? 4  : 2;

  // SCORE 7: NEWS CATALYST (existence of catalyst today) — weight 0% in math
  // Used as a binary filter — must have catalyst for day trade
  const hasNewsCatalyst = news && news.length > 0;
  const catalystKeywords = ['earnings','revenue','guidance','FDA','merger','acquisition',
    'contract','partnership','buyout','beat','miss','approval','upgrade','downgrade'];
  const hasMaterialCatalyst = hasNewsCatalyst && news.some(n => {
    const text = `${n.title} ${n.description||''}`.toLowerCase();
    return catalystKeywords.some(kw => text.includes(kw));
  });

  // Weighted composite (technicals only)
  const composite = (
    scores.gap      * 0.25 +
    scores.relVol   * 0.25 +
    scores.rsi      * 0.15 +
    scores.priceRange * 0.10 +
    scores.vwap     * 0.15 +
    scores.atr      * 0.10
  );

  return {
    scores, composite: parseFloat(composite.toFixed(2)),
    technicals: {
      gapPct: parseFloat(gapPct.toFixed(2)),
      relativeVol: parseFloat(relativeVol.toFixed(1)),
      rsi, vwap: vwap ? parseFloat(vwap.toFixed(2)) : null,
      atr, atrPct: parseFloat(atrPct.toFixed(2)),
      price, prevClose
    },
    catalyst: { hasNews: hasNewsCatalyst, hasMaterial: hasMaterialCatalyst },
    // Day trade plan
    plan: {
      bias:      gapPct > 0 ? 'LONG' : 'SHORT',
      entry:     vwap ? `First pullback to VWAP (${vwap?.toFixed(2)})` : `First pullback after open`,
      stop:      parseFloat((price * (gapPct > 0 ? 0.96 : 1.04)).toFixed(2)),  // 4% stop
      target:    parseFloat((price * (gapPct > 0 ? 1.08 : 0.92)).toFixed(2)),  // 8% target
      riskReward:'1:2 (4% risk, 8% reward)',
      exit:      'EOD or target/stop — same day, no overnight holds'
    }
  };
}

// ── DAY TRADE ENTRY RULES (all must pass) ──
function checkDayTradeRules(score, quote) {
  const rules = {};
  const t = score.technicals;

  // Rule 1: Meaningful gap (>2% either direction)
  rules.hasGap = Math.abs(t.gapPct) >= 2.0;

  // Rule 2: Relative volume >= 2x (real activity, not noise)
  rules.relVolume = t.relativeVol >= 2.0;

  // Rule 3: Price in tradeable range ($2-$200)
  rules.priceRange = t.price >= 2 && t.price <= 200;

  // Rule 4: ATR% >= 1% (enough daily movement to trade)
  rules.hasVolatility = t.atrPct >= 1.0;

  // Rule 5: Not on Death Spiral list (checked separately)
  rules.notDeathSpiral = true; // Set to false if flagged

  // Rule 6: Composite score >= 6
  rules.minScore = score.composite >= 6.0;

  const passed = Object.values(rules).filter(Boolean).length;
  return { rules, passed, total: Object.keys(rules).length, allPass: passed === Object.keys(rules).length };
}

// ── HAIKU DAY TRADE REVIEW ──
const HAIKU_DT_SYSTEM = `You are an experienced day trader reviewing pre-screened setups.
These stocks passed technical filters: gap, relative volume, volatility, price range.
You trade based on TECHNICALS ONLY. Fundamentals don't matter for same-day trades.

Review each setup and decide: TAKE or SKIP.

TAKE if: Clean gap with volume, clear bias direction, manageable spread
SKIP if: Too extended (>15% gap), thin volume, unclear direction, obvious trap

Respond JSON only: [{"ticker":"X","decision":"TAKE","bias":"LONG","reason":"brief technical reason","confidence":"High/Medium/Low"}]`;

async function haikuDayTradeReview(candidates) {
  if (!candidates.length || !ANTHROPIC_KEY) {
    return candidates.map(c => ({...c, decision:'TAKE', dtReason:'No API key', confidence:'Medium'}));
  }

  const list = candidates.map(c => {
    const t = c.score.technicals;
    const p = c.score.plan;
    return `${c.ticker}: gap=${t.gapPct>0?'+':''}${t.gapPct}% relVol=${t.relativeVol}x RSI=${t.rsi||'?'} VWAP=${t.vwap||'?'} ATR%=${t.atrPct}% price=${t.price} bias=${p.bias} score=${c.score.composite}/10`;
  }).join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31'},
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 600,
      system: [{type:'text',text:HAIKU_DT_SYSTEM,cache_control:{type:'ephemeral'}}],
      messages: [{role:'user',content:`Review these day trade setups:\n${list}\nTAKE or SKIP each.`}]
    })
  });

  if (!resp.ok) return candidates.map(c => ({...c, decision:'TAKE', dtReason:'Haiku error', confidence:'Low'}));
  const d = await resp.json();
  const text = d.content?.[0]?.text || '[]';

  try {
    const reviews = JSON.parse(text.replace(/```json|```/g,'').trim());
    return candidates.map(c => {
      const r = reviews.find(x => x.ticker === c.ticker);
      return {...c, decision: r?.decision||'TAKE', dtReason: r?.reason||'', confidence: r?.confidence||'Medium', haikuBias: r?.bias};
    });
  } catch(e) {
    return candidates.map(c => ({...c, decision:'TAKE', dtReason:'Parse error', confidence:'Low'}));
  }
}

// ── MAIN HANDLER ──
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const secret = req.query?.secret || '';
  if (secret !== 'pulsestock2026') { res.status(401).json({error:'Unauthorized'}); return; }

  const log = [];
  const startTime = Date.now();

  try {
    // ── PHASE 1: MARKET CONDITIONS CHECK ──
    log.push('Phase 1: Market conditions...');
    const [spy, vix] = await Promise.all([
      sf(`https://finnhub.io/api/v1/quote?symbol=SPY&token=${FINNHUB}`),
      sf(`https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB}`)
    ]);
    const vixLevel = vix?.c || 20;
    const spyGap = spy?.pc > 0 ? ((spy.c - spy.pc) / spy.pc * 100) : 0;

    // Day traders LOVE high VIX — more volatility = more opportunity
    // Only skip on extreme VIX (>40 = market circuit breaker territory)
    if (vixLevel > 40) {
      res.json({result:'SKIP', reason:`VIX ${vixLevel} — extreme volatility, circuit breaker risk`, log});
      return;
    }

    log.push(`Market: SPY gap=${spyGap.toFixed(2)}% VIX=${vixLevel} — ${vixLevel > 25 ? 'HIGH VOL (good for day trade)' : 'Normal'}`);

    // ── PHASE 2: GET TODAY'S CATALYST LIST ──
    // Alpha Vantage earnings topic catches today's pre-market movers
    log.push('Phase 2: Getting today catalysts from Alpha Vantage...');
    const avData = await sf(
      `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=earnings,ipo,mergers_and_acquisitions&limit=50&sort=LATEST&apikey=${AV_KEY}`,
      15000
    );
    const avArticles = avData?.feed || [];

    // Extract tickers mentioned in today's news
    const catalystTickers = new Set();
    const today = new Date().toISOString().split('T')[0].replace(/-/g,'');

    for (const a of avArticles) {
      // Only today's articles
      if (!a.time_published?.startsWith(today)) continue;
      for (const ts of (a.ticker_sentiment || [])) {
        if (ts.ticker && !ts.ticker.includes(':') && ts.ticker.length <= 5) {
          catalystTickers.add(ts.ticker);
        }
      }
    }
    log.push(`Catalyst tickers from AV today: ${catalystTickers.size}`);

    // ── PHASE 3: GET UNIVERSE + FILTER FOR MOVERS ──
    // For day trading we want stocks already moving — use Finnhub symbols
    // but focus on stocks with significant pre-market/open moves
    log.push('Phase 3: Fetching universe for pre-market movers...');
    const symbolsData = await sf(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB}`, 30000);
    const allSymbols = (symbolsData || []).filter(s =>
      s.type === 'Common Stock' && s.currency === 'USD' && s.symbol &&
      !s.symbol.includes('.') && !s.symbol.includes('/') &&
      s.symbol.length <= 5 && !/[FKEPHY]$/.test(s.symbol.toUpperCase()) &&
      ['XNAS','XNYS','XASE'].includes(s.mic)
    ).map(s => s.symbol);

    // Prioritize catalyst tickers + random sample
    // Day trade universe: catalyst stocks FIRST, then random movers
    const prioritized = [
      ...Array.from(catalystTickers).filter(t => allSymbols.includes(t)),
      ...allSymbols.filter(t => !catalystTickers.has(t)).sort(()=>Math.random()-0.5).slice(0, 100)
    ].slice(0, 150); // Process up to 150 stocks

    log.push(`Processing: ${prioritized.length} stocks (${catalystTickers.size} with catalysts + random)`);

    // ── PHASE 4: FETCH QUOTES + FILTER MOVERS ──
    log.push('Phase 4: Fetching quotes, filtering for gaps + volume...');
    const movers = [];

    for (const sym of prioritized) {
      const quote = await sf(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`);
      if (!quote?.c || !quote?.pc) {
        await new Promise(r => setTimeout(r, 1100));
        continue;
      }

      const price = quote.c;
      const gapPct = ((price - quote.pc) / quote.pc * 100);
      const absGap = Math.abs(gapPct);

      // Pre-filter: only meaningful movers
      if (absGap >= 2.0 && price >= 2 && price <= 200) {
        movers.push({ ticker: sym, quote, price, gapPct });
      }
      await new Promise(r => setTimeout(r, 1100));
    }
    log.push(`Movers (gap ≥2%): ${movers.length}`);

    if (!movers.length) {
      res.json({
        result: 'NO_SETUPS',
        reason: 'No stocks with meaningful gaps today',
        market: {vix: vixLevel, spyGap},
        log
      });
      return;
    }

    // ── PHASE 5: GET TECHNICALS FOR MOVERS ──
    log.push('Phase 5: Fetching technicals (daily candles, intraday)...');
    const withTechnicals = [];

    for (const m of movers.slice(0, 50)) { // Max 50 deep analysis
      const [daily, intraday, news] = await Promise.all([
        getDailyCandles(m.ticker, 60),
        getIntradayCandles(m.ticker),
        sf(`https://api.polygon.io/v2/reference/news?ticker=${m.ticker}&limit=5&sort=published_utc&order=descending&apiKey=${POLYGON}`)
          .then(d => d?.results || [])
      ]);

      const score = scoreDayTrade(m.ticker, m.quote, intraday, daily, news);

      // Death spiral check
      const RED_FLAGS = ['going concern','bankruptcy','convertible note','dilution','ATM offering','SEC investigation'];
      const hasRedFlag = news.some(n => {
        const text = `${n.title} ${n.description||''}`.toLowerCase();
        return RED_FLAGS.some(f => text.includes(f));
      });

      if (hasRedFlag) {
        log.push(`  SKIP ${m.ticker}: death spiral red flag`);
        await new Promise(r => setTimeout(r, 1100));
        continue;
      }

      withTechnicals.push({
        ticker: m.ticker,
        score,
        hasCatalyst: catalystTickers.has(m.ticker),
        newsCount: news.length
      });

      await new Promise(r => setTimeout(r, 1100));
    }
    log.push(`With full technicals: ${withTechnicals.length}`);

    // ── PHASE 6: APPLY DAY TRADE RULES ──
    log.push('Phase 6: Day trade rules...');
    const rulePass = [];
    for (const s of withTechnicals) {
      const check = checkDayTradeRules(s.score, s.score.technicals, mode);
      s.rules = check;
      if (check.allPass) {
        rulePass.push(s);
      } else {
        const failed = Object.entries(check.rules).filter(([k,v])=>!v).map(([k])=>k);
        log.push(`  ${s.ticker}: FAILED [${failed.join(',')}]`);
      }
    }
    // Sort by: catalyst first, then composite score
    rulePass.sort((a,b) => {
      if (a.hasCatalyst && !b.hasCatalyst) return -1;
      if (!a.hasCatalyst && b.hasCatalyst) return 1;
      return b.score.composite - a.score.composite;
    });
    log.push(`After day trade rules: ${rulePass.length} setups`);

    // ── PHASE 7: HAIKU TECHNICAL REVIEW ──
    log.push('Phase 7: Haiku technical review...');
    const top20 = rulePass.slice(0, 20);
    const reviewed = await haikuDayTradeReview(top20);
    const takes = reviewed.filter(s => s.decision === 'TAKE');
    log.push(`Haiku TAKE: ${takes.length} setups`);

    // ── SAVE TO SUPABASE ──
    const scanDate = new Date().toISOString().split('T')[0];
    if (takes.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/day_trade_candidates`, {
        method: 'POST',
        headers: {'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json','Prefer':'return=minimal'},
        body: JSON.stringify(takes.map(s => ({
          ticker: s.ticker,
          scan_date: scanDate,
          scan_time: new Date().toISOString(),
          composite_score: s.score.composite,
          gap_pct: s.score.technicals.gapPct,
          relative_vol: s.score.technicals.relativeVol,
          rsi: s.score.technicals.rsi,
          vwap: s.score.technicals.vwap,
          atr_pct: s.score.technicals.atrPct,
          price: s.score.technicals.price,
          bias: s.score.plan.bias,
          entry_note: s.score.plan.entry,
          stop: s.score.plan.stop,
          target: s.score.plan.target,
          has_catalyst: s.hasCatalyst,
          haiku_decision: s.decision,
          haiku_reason: s.dtReason,
          confidence: s.confidence,
          status: 'candidate',
          created_at: new Date().toISOString()
        })))
      }).catch(e => log.push(`Supabase error: ${e.message}`));
    }

    const elapsed = ((Date.now()-startTime)/1000/60).toFixed(1);

    res.json({
      success: true,
      elapsed: `${elapsed} min`,
      market: {vix: vixLevel, spyGap: spyGap.toFixed(2), dayTradeConditions: vixLevel > 20 ? 'FAVORABLE (elevated vol)' : 'NORMAL'},
      funnel: {
        catalystTickers: catalystTickers.size,
        processed: prioritized.length,
        moversGap2pct: movers.length,
        withTechnicals: withTechnicals.length,
        passedRules: rulePass.length,
        haikuTake: takes.length
      },
      setups: takes.map(s => ({
        ticker: s.ticker,
        bias: s.score.plan.bias,
        price: `$${s.score.technicals.price?.toFixed(2)}`,
        gap: `${s.score.technicals.gapPct>0?'+':''}${s.score.technicals.gapPct?.toFixed(2)}%`,
        relVol: `${s.score.technicals.relativeVol?.toFixed(1)}x`,
        rsi: s.score.technicals.rsi,
        vwap: s.score.technicals.vwap,
        atrPct: `${s.score.technicals.atrPct?.toFixed(2)}%`,
        compositeScore: s.score.composite,
        entry: s.score.plan.entry,
        stop: `$${s.score.plan.stop}`,
        target: `$${s.score.plan.target}`,
        riskReward: s.score.plan.riskReward,
        hasCatalyst: s.hasCatalyst,
        confidence: s.confidence,
        reason: s.dtReason
      })),
      log
    });

  } catch(e) {
    res.status(500).json({error: e.message, stack: e.stack?.slice(0,500), log});
  }
};
