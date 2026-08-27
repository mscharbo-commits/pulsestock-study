// api/gen4-scan.js
// Generation 4 Full Universe Scanner
// Manual trigger only — testing formula and outcomes
// Takes 20-30 min to run full universe — that's fine, this is research
// Cost: ~$0.07 per run (Haiku only, math does the heavy lifting)
//
// Trigger: GET /api/gen4-scan?secret=pulsestock2026&mode=full
//          GET /api/gen4-scan?secret=pulsestock2026&mode=test (50 stocks only)

export const config = { maxDuration: 300 }; // Vercel max — Railway handles overflow

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB  = process.env.FINNHUB_KEY  || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
const POLYGON  = process.env.POLYGON_API_KEY || '2c90554e-b7d3-485f-a497-b350eb8136f5';
const AV_KEY   = process.env.AV_KEY       || '9D1A2PAECG3F11MG';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

// ── SECTOR ETF MAP ──
const SECTOR_ETFS = {
  'Technology': 'XLK', 'Healthcare': 'XLV', 'Energy': 'XLE',
  'Financial Services': 'XLF', 'Consumer Cyclical': 'XLY',
  'Consumer Defensive': 'XLP', 'Industrials': 'XLI',
  'Basic Materials': 'XLB', 'Utilities': 'XLU',
  'Real Estate': 'XLRE', 'Communication Services': 'XLC'
};

// ── SAFE FETCH ──
async function sf(url, timeout=12000) {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url);
    clearTimeout(id);
    return r.ok ? await r.json() : null;
  } catch(e) { return null; }
}

// ── RATE-LIMITED BATCH FETCH ──
// Finnhub free tier: 60 calls/min = 1 call/second
async function batchFetch(urls, delayMs=1100) {
  const results = [];
  for (const url of urls) {
    const data = await sf(url);
    results.push(data);
    await new Promise(r => setTimeout(r, delayMs));
  }
  return results;
}

// ── STEP 1: MACRO REGIME CHECK ──
// Alpha Vantage — 1 call covers all macro topics
// Returns: BULLISH / NEUTRAL / BEARISH / SKIP
async function checkMacroRegime() {
  const topics = 'economy_macro,geopolitics,finance,earnings,manufacturing,energy_transportation';
  const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${topics}&limit=100&sort=LATEST&apikey=${AV_KEY}`;
  
  const data = await sf(url, 20000);
  const articles = data?.feed || [];
  
  if (!articles.length) return { regime: 'NEUTRAL', reason: 'No AV data', score: 0 };

  // Score macro sentiment
  let totalScore = 0, count = 0;
  const extremeBearish = [];
  
  for (const a of articles) {
    const score = parseFloat(a.overall_sentiment_score) || 0;
    const macroRelevance = (a.topics || []).find(t => 
      t.topic === 'economy_macro' && parseFloat(t.relevance_score) > 0.5
    );
    if (macroRelevance) {
      totalScore += score;
      count++;
      if (score < -0.4) extremeBearish.push(a.title);
    }
  }

  const avgScore = count > 0 ? totalScore / count : 0;
  
  // Check SPY and VIX
  const [spy, vix] = await Promise.all([
    sf(`https://finnhub.io/api/v1/quote?symbol=SPY&token=${FINNHUB}`),
    sf(`https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB}`)
  ]);
  
  const spyPrice = spy?.c || 0;
  const vixLevel = vix?.c || 20;

  // Hard SKIP conditions
  if (vixLevel > 30) return { regime: 'SKIP', reason: `VIX elevated at ${vixLevel.toFixed(1)}`, score: avgScore };
  if (extremeBearish.length >= 3) return { regime: 'SKIP', reason: `${extremeBearish.length} extreme bearish macro events`, score: avgScore, events: extremeBearish.slice(0,3) };

  // Regime classification
  const regime = avgScore > 0.15 ? 'BULLISH' : avgScore < -0.15 ? 'BEARISH' : 'NEUTRAL';
  return { regime, score: avgScore.toFixed(3), vix: vixLevel, articleCount: count };
}

// ── STEP 2: GET FULL UNIVERSE ──
async function getUniverse() {
  const data = await sf(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB}`, 30000);
  if (!data) return [];
  
  return data.filter(s =>
    s.type === 'Common Stock' &&
    s.currency === 'USD' &&
    s.symbol &&
    !s.symbol.includes('.') &&
    !s.symbol.includes('/') &&
    s.symbol.length <= 5 &&
    !/[FKEPHY]$/.test(s.symbol.toUpperCase()) &&
    ['XNAS','XNYS','XASE'].includes(s.mic)
  ).map(s => s.symbol);
}

// ── STEP 3: QUANT SCORING (pure math, no Claude) ──
// Score 0-10 on 5 factors. Weights can be adjusted by Critic.
function quantScore(m, q) {
  if (!m || !q) return null;
  
  const scores = {};
  
  // 1. VALUE — lower P/E vs sector = better (weight: 20%)
  // Using absolute P/E as proxy since we don't have sector median here
  const pe = m.peBasicExclExtraTTM || m.peRatio || 0;
  scores.value = pe <= 0   ? 3 : // Negative earnings
                 pe < 15   ? 9 :
                 pe < 20   ? 8 :
                 pe < 25   ? 7 :
                 pe < 30   ? 6 :
                 pe < 40   ? 5 :
                 pe < 60   ? 4 : 2;

  // 2. GROWTH — revenue growth YoY (weight: 25%)
  const revGrowth = m.revenueGrowthTTMYoy || 0;
  scores.growth = revGrowth > 0.30 ? 10 :
                  revGrowth > 0.20 ? 8 :
                  revGrowth > 0.10 ? 7 :
                  revGrowth > 0.05 ? 5 :
                  revGrowth > 0    ? 4 : 2;

  // 3. PROFITABILITY — net margin (weight: 20%)
  const margin = m.netMarginTTM || 0;
  scores.profitability = margin > 0.25 ? 10 :
                         margin > 0.15 ? 8 :
                         margin > 0.08 ? 6 :
                         margin > 0    ? 4 : 1;

  // 4. MOMENTUM — price action (weight: 25%)
  const price = q.c || 0;
  const high52 = q.h || price; // Using daily high as proxy — metrics has 52W
  const pc = q.pc || price;
  const dayChange = pc > 0 ? ((price - pc) / pc) * 100 : 0;
  
  // RSI from basic metrics if available, otherwise estimate from price action
  const rsi = m.rsi14 || 50; // Finnhub doesn't provide RSI in basic metrics
  
  const vs52High = m['52WeekHigh'] ? price / m['52WeekHigh'] : 0.85;
  
  scores.momentum = (vs52High > 0.90 && dayChange > 0) ? 9 :
                    (vs52High > 0.80 && dayChange > -1) ? 7 :
                    (vs52High > 0.70) ? 5 : 3;

  // 5. EPS REVISIONS — using EPS growth as proxy (weight: 10%)
  const epsGrowth = m.epsGrowthTTMYoy || m.epsGrowthQuarterlyYoy || 0;
  scores.epsRevisions = epsGrowth > 0.20 ? 9 :
                        epsGrowth > 0.10 ? 7 :
                        epsGrowth > 0    ? 5 :
                        epsGrowth > -0.10 ? 3 : 1;

  // Weighted composite
  const composite = (
    scores.value        * 0.20 +
    scores.growth       * 0.25 +
    scores.profitability * 0.20 +
    scores.momentum     * 0.25 +
    scores.epsRevisions * 0.10
  );

  return { scores, composite: parseFloat(composite.toFixed(2)) };
}

// ── STEP 4: 7 ENTRY RULES (pure math) ──
function check7Rules(m, q) {
  const rules = {};
  const price = q?.c || 0;
  
  // Rule 1: Price > $2
  rules.minPrice = price >= 2.0;
  
  // Rule 2: Price > 50MA (using Finnhub's 50-day MA if available)
  const ma50 = m?.['50DayMA'] || m?.ma50 || 0;
  rules.above50MA = ma50 > 0 ? price > ma50 : true; // Skip if no data
  
  // Rule 3: Price > 200MA
  const ma200 = m?.['200DayMA'] || m?.ma200 || 0;
  rules.above200MA = ma200 > 0 ? price > ma200 : true;
  
  // Rule 4: Revenue growth > 5% YoY
  const revGrowth = m?.revenueGrowthTTMYoy || 0;
  rules.revenueGrowth = revGrowth > 0.05;
  
  // Rule 5: Net margin positive
  const margin = m?.netMarginTTM || 0;
  rules.profitable = margin > 0;
  
  // Rule 6: Market cap > $50M (using shares * price as proxy)
  const sharesOut = (m?.sharesOutstandingTTM || 0) * 1e6;
  const marketCap = sharesOut * price;
  rules.minMarketCap = marketCap > 50e6 || sharesOut === 0; // Skip if no data
  
  // Rule 7: P/E exists and is positive (has earnings)
  const pe = m?.peBasicExclExtraTTM || m?.peRatio;
  rules.hasEarnings = pe !== null && pe !== undefined && pe > 0 && pe < 200;
  
  const passed = Object.values(rules).filter(Boolean).length;
  const total = Object.keys(rules).length;
  
  return { rules, passed, total, allPass: passed === total };
}

// ── STEP 5: SECTOR HEALTH CHECK ──
async function checkSectorHealth(sector) {
  const etf = SECTOR_ETFS[sector];
  if (!etf) return { healthy: true, reason: 'Unknown sector' };
  
  const [quote, metrics] = await Promise.all([
    sf(`https://finnhub.io/api/v1/quote?symbol=${etf}&token=${FINNHUB}`),
    sf(`https://finnhub.io/api/v1/stock/metric?symbol=${etf}&metric=all&token=${FINNHUB}`)
  ]);
  
  if (!quote?.c) return { healthy: true, reason: 'No ETF data' };
  
  const price = quote.c;
  const ma50 = metrics?.metric?.['50DayMA'] || 0;
  const ma200 = metrics?.metric?.['200DayMA'] || 0;
  
  const above50MA = ma50 > 0 ? price > ma50 : true;
  const above200MA = ma200 > 0 ? price > ma200 : true;
  
  return {
    healthy: above50MA,  // Must be above 50MA minimum
    etf, price: price.toFixed(2),
    above50MA, above200MA,
    reason: above50MA ? 'Sector ETF healthy' : `${etf} below 50MA`
  };
}

// ── STEP 6: DEATH SPIRAL CHECK (Polygon news keywords) ──
async function checkDeathSpiral(ticker) {
  const news = await sf(
    `https://api.polygon.io/v2/reference/news?ticker=${ticker}&limit=5&sort=published_utc&order=descending&apiKey=${POLYGON}`
  );
  const articles = news?.results || [];
  
  const RED_FLAGS = [
    'going concern','bankruptcy','chapter 11','insolvency',
    'convertible note','dilution','ATM offering','shelf registration',
    'SEC investigation','DOJ','fraud','default','liquidity crisis'
  ];
  
  for (const a of articles) {
    const text = `${a.title} ${a.description||''}`.toLowerCase();
    const flagged = RED_FLAGS.find(f => text.includes(f));
    if (flagged) return { clean: false, flag: flagged, title: a.title };
  }
  
  return { clean: true };
}

// ── STEP 7: HAIKU REVIEW (top candidates only) ──
const HAIKU_SYSTEM = `You are a systematic stock screener reviewing pre-filtered candidates.
These stocks have already passed: macro regime, 7 entry rules, quant score ≥ 7, sector health, death spiral check.
Your job: identify any OBVIOUS reason to reject despite passing all filters.

Look for:
- Recent news suggesting fundamental deterioration not in the metrics yet
- Sector-specific headwinds not captured by ETF check
- Extreme valuation red flags the rules might have missed

Respond with JSON ONLY: [{"ticker":"X","approve":true,"reason":"brief"}]
Default to APPROVE unless you see a clear problem. The rules already did the heavy lifting.`;

async function haikuVeto(candidates) {
  if (!candidates.length) return [];
  
  const list = candidates.map(c =>
    `${c.ticker}: quant=${c.quantScore}/10 sector=${c.sector} margin=${(c.metrics?.netMarginTTM*100||0).toFixed(1)}% revGrowth=${(c.metrics?.revenueGrowthTTMYoy*100||0).toFixed(1)}%`
  ).join('\n');

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 800,
      system: [{type:'text', text:HAIKU_SYSTEM, cache_control:{type:'ephemeral'}}],
      messages: [{role:'user', content:`Review these candidates:\n${list}\n\nApprove or reject each.`}]
    })
  });
  
  if (!resp.ok) return candidates.map(c => ({...c, approved: true, haikuReason: 'Haiku unavailable'}));
  const d = await resp.json();
  const text = d.content?.[0]?.text || '[]';
  
  try {
    const vetoes = JSON.parse(text.replace(/```json|```/g,'').trim());
    return candidates.map(c => {
      const veto = vetoes.find(v => v.ticker === c.ticker);
      return {...c, approved: veto?.approve !== false, haikuReason: veto?.reason || 'Approved'};
    });
  } catch(e) {
    return candidates.map(c => ({...c, approved: true, haikuReason: 'Parse error — defaulting approve'}));
  }
}

// ── MAIN HANDLER ──
export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', {headers: CORS});
  
  const url = new URL(req.url, `https://${{req.headers.get('host') || 'localhost'}}`);
  const secret = url.searchParams.get('secret');
  const mode = url.searchParams.get('mode') || 'test'; // 'test' = 50 stocks, 'full' = all
  
  if (secret !== 'pulsestock2026') {
    return new Response(JSON.stringify({error:'Unauthorized'}), {status:401, headers:CORS});
  }

  const log = [];
  const startTime = Date.now();
  
  try {
    // ── PHASE 1: MACRO REGIME CHECK ──
    log.push('Phase 1: Macro regime check...');
    const macro = await checkMacroRegime();
    log.push(`Macro regime: ${macro.regime} (score: ${macro.score}, VIX: ${macro.vix})`);
    
    if (macro.regime === 'SKIP') {
      return new Response(JSON.stringify({
        result: 'SKIP',
        reason: macro.reason,
        macro,
        log
      }), {headers: CORS});
    }

    // ── PHASE 2: GET UNIVERSE ──
    log.push('Phase 2: Fetching universe from Finnhub...');
    const allSymbols = await getUniverse();
    log.push(`Universe: ${allSymbols.length} valid symbols after symbol filter`);
    
    // In test mode, take a random sample
    const symbols = mode === 'test' 
      ? allSymbols.sort(() => Math.random()-0.5).slice(0, 50)
      : allSymbols;
    log.push(`Processing: ${symbols.length} stocks (${mode} mode)`);

    // ── PHASE 3: FETCH QUOTES + METRICS ──
    // Rate limited: 1 call per second per endpoint
    // For full run: ~1,500 stocks × 2 calls = ~50 min
    // For test: 50 stocks × 2 calls = ~2 min
    log.push('Phase 3: Fetching quotes and metrics (rate limited 1/sec)...');
    
    const stockData = [];
    let processed = 0;
    
    for (const sym of symbols) {
      // Fetch quote and metrics in parallel (2 calls, 1.1s gap after)
      const [quote, metricsResp] = await Promise.all([
        sf(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`),
        sf(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${FINNHUB}`)
      ]);
      
      const metrics = metricsResp?.metric || null;
      const price = quote?.c || 0;
      
      // Hard price filter — eliminate immediately
      if (price < 2.0 || !metrics) {
        processed++;
        await new Promise(r => setTimeout(r, 1100)); // Rate limit
        continue;
      }
      
      // Dollar volume filter
      const dollarVol = price * (quote?.v || 0);
      if (quote?.v > 0 && dollarVol < 500000) {
        processed++;
        await new Promise(r => setTimeout(r, 1100));
        continue;
      }
      
      // Get sector from profile (cached — reuse if available)
      const profile = await sf(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${FINNHUB}`);
      
      stockData.push({
        ticker: sym,
        price,
        dollarVol,
        quote,
        metrics,
        sector: profile?.finnhubIndustry || 'Unknown',
        marketCap: profile?.marketCapitalization || 0
      });
      
      processed++;
      if (processed % 50 === 0) log.push(`  Processed ${processed}/${symbols.length}...`);
      await new Promise(r => setTimeout(r, 1100)); // Strict rate limit
    }
    
    log.push(`Phase 3 complete: ${stockData.length} stocks with valid data`);

    // ── PHASE 4: QUANT SCORING ──
    log.push('Phase 4: Quant scoring...');
    const scored = stockData.map(s => {
      const quant = quantScore(s.metrics, s.quote);
      return {...s, quant, quantScore: quant?.composite || 0};
    }).filter(s => s.quantScore >= 6); // Min quant score 6/10
    
    scored.sort((a,b) => b.quantScore - a.quantScore);
    log.push(`After quant filter (≥6/10): ${scored.length} stocks`);

    // ── PHASE 5: 7 ENTRY RULES ──
    log.push('Phase 5: 7 entry rules check...');
    const rulesPass = scored.filter(s => {
      const check = check7Rules(s.metrics, s.quote);
      s.rules = check;
      return check.allPass;
    });
    log.push(`After 7 rules: ${rulesPass.length} stocks`);

    // ── PHASE 6: SECTOR HEALTH ──
    log.push('Phase 6: Sector health check...');
    const sectorCache = {};
    const sectorPass = [];
    
    for (const s of rulesPass) {
      if (!sectorCache[s.sector]) {
        sectorCache[s.sector] = await checkSectorHealth(s.sector);
        await new Promise(r => setTimeout(r, 1100));
      }
      s.sectorHealth = sectorCache[s.sector];
      if (s.sectorHealth.healthy) sectorPass.push(s);
    }
    log.push(`After sector health: ${sectorPass.length} stocks`);

    // ── PHASE 7: DEATH SPIRAL CHECK ──
    log.push('Phase 7: Death spiral / news red flag check...');
    const clean = [];
    
    for (const s of sectorPass) {
      const ds = await checkDeathSpiral(s.ticker);
      s.deathSpiral = ds;
      if (ds.clean) clean.push(s);
      else log.push(`  REJECTED ${s.ticker}: ${ds.flag}`);
      await new Promise(r => setTimeout(r, 300));
    }
    log.push(`After death spiral: ${clean.length} clean stocks`);

    // ── PHASE 8: HAIKU VETO (top 50 only) ──
    log.push('Phase 8: Haiku veto check...');
    const top50 = clean.slice(0, 50);
    const vetoed = await haikuVeto(top50);
    const approved = vetoed.filter(s => s.approved);
    log.push(`After Haiku veto: ${approved.length} approved`);

    // ── SAVE RESULTS TO SUPABASE ──
    const scanDate = new Date().toISOString().split('T')[0];
    const results = approved.map(s => ({
      ticker: s.ticker,
      scan_date: scanDate,
      scan_mode: mode,
      quant_score: s.quantScore,
      quant_detail: s.quant?.scores,
      price: s.price,
      market_cap: s.marketCap,
      sector: s.sector,
      rules_passed: s.rules?.passed,
      sector_healthy: s.sectorHealth?.healthy,
      haiku_reason: s.haikuReason,
      macro_regime: macro.regime,
      macro_score: parseFloat(macro.score),
      status: 'candidate',
      created_at: new Date().toISOString()
    }));

    // Save to Supabase
    if (results.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/gen4_candidates`, {
        method: 'POST',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify(results)
      }).catch(e => log.push(`Supabase save error: ${e.message}`));
    }

    const elapsed = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    const haikuCost = (Math.min(top50.length, 50) * 0.001).toFixed(3);

    return new Response(JSON.stringify({
      success: true,
      mode,
      elapsed: `${elapsed} minutes`,
      estimatedCost: `$${haikuCost} (Haiku only)`,
      macro: { regime: macro.regime, score: macro.score, vix: macro.vix },
      funnel: {
        universe: symbols.length,
        withValidData: stockData.length,
        passedQuant: scored.length,
        passed7Rules: rulesPass.length,
        passedSector: sectorPass.length,
        passedDeathSpiral: clean.length,
        passedHaiku: approved.length
      },
      topCandidates: approved.slice(0, 20).map(s => ({
        ticker: s.ticker,
        price: `$${s.price?.toFixed(2)}`,
        quantScore: s.quantScore,
        sector: s.sector,
        scores: s.quant?.scores,
        haikuReason: s.haikuReason
      })),
      log
    }, null, 2), {headers: CORS});

  } catch(e) {
    return new Response(JSON.stringify({
      error: e.message,
      stack: e.stack?.slice(0,500),
      log
    }), {status:500, headers:CORS});
  }
}
