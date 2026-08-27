// api/gen4-scan.js — CommonJS format matching study platform
// Generation 4 Full Universe Scanner
// Manual trigger — testing formula and outcomes
// Cost: ~$0.07 per run (Haiku only)
// GET /api/gen4-scan?secret=pulsestock2026&mode=test  (50 stocks, ~2 min)
// GET /api/gen4-scan?secret=pulsestock2026&mode=full  (all stocks, ~30 min)

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB  = process.env.FINNHUB_KEY  || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
const POLYGON  = process.env.POLYGON_API_KEY || '2c90554e-b7d3-485f-a497-b350eb8136f5';
const AV_KEY   = process.env.AV_KEY       || '9D1A2PAECG3F11MG';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';

const SECTOR_ETFS = {
  'Technology': 'XLK', 'Healthcare': 'XLV', 'Energy': 'XLE',
  'Financial Services': 'XLF', 'Consumer Cyclical': 'XLY',
  'Consumer Defensive': 'XLP', 'Industrials': 'XLI',
  'Basic Materials': 'XLB', 'Utilities': 'XLU',
  'Real Estate': 'XLRE', 'Communication Services': 'XLC'
};

async function sf(url, timeout=12000) {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, {signal: ctrl.signal});
    clearTimeout(id);
    return r.ok ? await r.json() : null;
  } catch(e) { return null; }
}

async function checkMacroRegime() {
  const topics = 'economy_macro,geopolitics,finance,earnings,manufacturing,energy_transportation';
  const data = await sf(
    `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${topics}&limit=100&sort=LATEST&apikey=${AV_KEY}`,
    20000
  );
  const articles = data?.feed || [];
  if (!articles.length) return { regime: 'NEUTRAL', reason: 'No AV data', score: 0 };

  let totalScore = 0, count = 0;
  const extremeBearish = [];
  for (const a of articles) {
    const score = parseFloat(a.overall_sentiment_score) || 0;
    const macroRelevant = (a.topics||[]).find(t =>
      t.topic === 'economy_macro' && parseFloat(t.relevance_score) > 0.5
    );
    if (macroRelevant) {
      totalScore += score; count++;
      if (score < -0.4) extremeBearish.push(a.title);
    }
  }
  const avgScore = count > 0 ? totalScore / count : 0;

  const [spy, vix] = await Promise.all([
    sf(`https://finnhub.io/api/v1/quote?symbol=SPY&token=${FINNHUB}`),
    sf(`https://finnhub.io/api/v1/quote?symbol=VIX&token=${FINNHUB}`)
  ]);
  const vixLevel = vix?.c || 20;

  if (vixLevel > 30) return { regime: 'SKIP', reason: `VIX ${vixLevel.toFixed(1)} > 30`, score: avgScore };
  if (extremeBearish.length >= 3) return { regime: 'SKIP', reason: `${extremeBearish.length} extreme bearish events`, score: avgScore };

  const regime = avgScore > 0.15 ? 'BULLISH' : avgScore < -0.15 ? 'BEARISH' : 'NEUTRAL';
  return { regime, score: avgScore.toFixed(3), vix: vixLevel, articleCount: count };
}

async function getUniverse() {
  const data = await sf(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB}`, 30000);
  if (!data) return [];
  return data.filter(s =>
    s.type === 'Common Stock' && s.currency === 'USD' && s.symbol &&
    !s.symbol.includes('.') && !s.symbol.includes('/') &&
    s.symbol.length <= 5 && !/[FKEPHY]$/.test(s.symbol.toUpperCase()) &&
    ['XNAS','XNYS','XASE'].includes(s.mic)
  ).map(s => s.symbol);
}

function quantScore(m, q) {
  if (!m || !q) return null;
  const scores = {};
  const pe = m.peBasicExclExtraTTM || m.peRatio || 0;
  scores.value = pe <= 0 ? 3 : pe < 15 ? 9 : pe < 20 ? 8 : pe < 25 ? 7 : pe < 30 ? 6 : pe < 40 ? 5 : pe < 60 ? 4 : 2;
  const revGrowth = m.revenueGrowthTTMYoy || 0;
  scores.growth = revGrowth > 0.30 ? 10 : revGrowth > 0.20 ? 8 : revGrowth > 0.10 ? 7 : revGrowth > 0.05 ? 5 : revGrowth > 0 ? 4 : 2;
  const margin = m.netMarginTTM || 0;
  scores.profitability = margin > 0.25 ? 10 : margin > 0.15 ? 8 : margin > 0.08 ? 6 : margin > 0 ? 4 : 1;
  const price = q.c || 0;
  const vs52High = m['52WeekHigh'] ? price / m['52WeekHigh'] : 0.85;
  const dayChange = q.pc > 0 ? ((price - q.pc) / q.pc) * 100 : 0;
  scores.momentum = (vs52High > 0.90 && dayChange > 0) ? 9 : (vs52High > 0.80 && dayChange > -1) ? 7 : vs52High > 0.70 ? 5 : 3;
  const epsGrowth = m.epsGrowthTTMYoy || m.epsGrowthQuarterlyYoy || 0;
  scores.epsRevisions = epsGrowth > 0.20 ? 9 : epsGrowth > 0.10 ? 7 : epsGrowth > 0 ? 5 : epsGrowth > -0.10 ? 3 : 1;
  const composite = scores.value*0.20 + scores.growth*0.25 + scores.profitability*0.20 + scores.momentum*0.25 + scores.epsRevisions*0.10;
  return { scores, composite: parseFloat(composite.toFixed(2)) };
}

function check7Rules(m, q) {
  const rules = {};
  const price = q?.c || 0;
  rules.minPrice = price >= 2.0;
  const ma50 = m?.['50DayMA'] || 0;
  rules.above50MA = ma50 > 0 ? price > ma50 : true;
  const ma200 = m?.['200DayMA'] || 0;
  rules.above200MA = ma200 > 0 ? price > ma200 : true;
  rules.revenueGrowth = (m?.revenueGrowthTTMYoy || 0) > 0.05;
  rules.profitable = (m?.netMarginTTM || 0) > 0;
  const sharesOut = (m?.sharesOutstandingTTM || 0) * 1e6;
  rules.minMarketCap = sharesOut > 0 ? (sharesOut * price) > 50e6 : true;
  const pe = m?.peBasicExclExtraTTM || m?.peRatio;
  rules.hasEarnings = pe !== null && pe !== undefined && pe > 0 && pe < 200;
  const passed = Object.values(rules).filter(Boolean).length;
  return { rules, passed, total: Object.keys(rules).length, allPass: passed === Object.keys(rules).length };
}

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
  const above50MA = ma50 > 0 ? price > ma50 : true;
  return { healthy: above50MA, etf, price: price.toFixed(2), above50MA };
}

async function checkDeathSpiral(ticker) {
  const news = await sf(
    `https://api.polygon.io/v2/reference/news?ticker=${ticker}&limit=5&sort=published_utc&order=descending&apiKey=${POLYGON}`
  );
  const articles = news?.results || [];
  const RED_FLAGS = ['going concern','bankruptcy','chapter 11','insolvency',
    'convertible note','dilution','ATM offering','shelf registration',
    'SEC investigation','DOJ','fraud','default','liquidity crisis'];
  for (const a of articles) {
    const text = `${a.title} ${a.description||''}`.toLowerCase();
    const flagged = RED_FLAGS.find(f => text.includes(f));
    if (flagged) return { clean: false, flag: flagged, title: a.title };
  }
  return { clean: true };
}

const HAIKU_SYSTEM = `You are a systematic stock screener. These stocks passed all filters.
Reject ONLY if you see an obvious problem not captured by the rules.
Default to approve. Respond JSON only: [{"ticker":"X","approve":true,"reason":"brief"}]`;

async function haikuVeto(candidates) {
  if (!candidates.length || !ANTHROPIC_KEY) return candidates.map(c => ({...c, approved: true, haikuReason: 'No API key'}));
  const list = candidates.map(c =>
    `${c.ticker}: quant=${c.quantScore}/10 sector=${c.sector} margin=${((c.metrics?.netMarginTTM||0)*100).toFixed(1)}% revGrowth=${((c.metrics?.revenueGrowthTTMYoy||0)*100).toFixed(1)}%`
  ).join('\n');
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31'},
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001', max_tokens: 800,
      system: [{type:'text',text:HAIKU_SYSTEM,cache_control:{type:'ephemeral'}}],
      messages: [{role:'user',content:`Review:\n${list}\nApprove or reject each.`}]
    })
  });
  if (!resp.ok) return candidates.map(c => ({...c, approved: true, haikuReason: 'Haiku error'}));
  const d = await resp.json();
  const text = d.content?.[0]?.text || '[]';
  try {
    const vetoes = JSON.parse(text.replace(/```json|```/g,'').trim());
    return candidates.map(c => {
      const v = vetoes.find(x => x.ticker === c.ticker);
      return {...c, approved: v?.approve !== false, haikuReason: v?.reason || 'Approved'};
    });
  } catch(e) {
    return candidates.map(c => ({...c, approved: true, haikuReason: 'Parse error'}));
  }
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'OPTIONS') { res.status(200).end(); return; }

  const secret = req.query?.secret || '';
  const mode   = req.query?.mode   || 'test';

  if (secret !== 'pulsestock2026') {
    res.status(401).json({error:'Unauthorized'}); return;
  }

  const log = [];
  const startTime = Date.now();

  try {
    // PHASE 1: MACRO REGIME
    log.push('Phase 1: Macro regime check...');
    const macro = await checkMacroRegime();
    log.push(`Macro: ${macro.regime} score=${macro.score} VIX=${macro.vix}`);

    if (macro.regime === 'SKIP') {
      res.json({result:'SKIP', reason:macro.reason, macro, log}); return;
    }

    // PHASE 2: UNIVERSE
    log.push('Phase 2: Fetching universe...');
    const allSymbols = await getUniverse();
    log.push(`Universe: ${allSymbols.length} symbols`);

    const symbols = mode === 'test'
      ? allSymbols.sort(()=>Math.random()-0.5).slice(0,50)
      : allSymbols;
    log.push(`Processing: ${symbols.length} stocks (${mode} mode)`);

    // PHASE 3: FETCH QUOTES + METRICS (rate limited)
    log.push('Phase 3: Fetching quotes + metrics (1 per second)...');
    const stockData = [];
    let processed = 0;

    for (const sym of symbols) {
      const [quote, metricsResp] = await Promise.all([
        sf(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`),
        sf(`https://finnhub.io/api/v1/stock/metric?symbol=${sym}&metric=all&token=${FINNHUB}`)
      ]);
      const metrics = metricsResp?.metric || null;
      const price = quote?.c || 0;

      if (price >= 2.0 && metrics) {
        const dollarVol = price * (quote?.v || 0);
        if (!quote?.v || dollarVol >= 500000) {
          const profile = await sf(`https://finnhub.io/api/v1/stock/profile2?symbol=${sym}&token=${FINNHUB}`);
          stockData.push({
            ticker: sym, price, dollarVol, quote, metrics,
            sector: profile?.finnhubIndustry || 'Unknown',
            marketCap: profile?.marketCapitalization || 0
          });
        }
      }
      processed++;
      if (processed % 25 === 0) log.push(`  ${processed}/${symbols.length} processed, ${stockData.length} passing...`);
      await new Promise(r => setTimeout(r, 1100));
    }
    log.push(`Phase 3 done: ${stockData.length} stocks with valid data`);

    // PHASE 4: QUANT SCORING
    log.push('Phase 4: Quant scoring...');
    const scored = stockData
      .map(s => { const q = quantScore(s.metrics, s.quote); return {...s, quant:q, quantScore:q?.composite||0}; })
      .filter(s => s.quantScore >= 6)
      .sort((a,b) => b.quantScore - a.quantScore);
    log.push(`After quant ≥6: ${scored.length} stocks`);

    // PHASE 5: 7 RULES — with debug
    log.push('Phase 5: 7 entry rules...');
    const rulesPass = [];
    for (const s of scored) {
      const c = check7Rules(s.metrics, s.quote);
      s.rules = c;
      if (c.allPass) {
        rulesPass.push(s);
      } else {
        const failed = Object.entries(c.rules).filter(([k,v]) => !v).map(([k]) => k);
        const m = s.metrics || {};
        log.push(`  ${s.ticker}(q=${s.quantScore}) FAILED:[${failed.join(',')}] price=${s.price?.toFixed(2)} ma50=${m['50DayMA']||'?'} ma200=${m['200DayMA']||'?'} revGrowth=${m.revenueGrowthTTMYoy||'?'} margin=${m.netMarginTTM||'?'} pe=${m.peBasicExclExtraTTM||m.peRatio||'?'} shares=${m.sharesOutstandingTTM||'?'}`);
      }
    }
    log.push(`After 7 rules: ${rulesPass.length} stocks`);

    // PHASE 6: SECTOR HEALTH
    log.push('Phase 6: Sector health...');
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
    log.push(`After sector: ${sectorPass.length} stocks`);

    // PHASE 7: DEATH SPIRAL
    log.push('Phase 7: Death spiral check...');
    const clean = [];
    for (const s of sectorPass) {
      const ds = await checkDeathSpiral(s.ticker);
      s.deathSpiral = ds;
      if (ds.clean) clean.push(s);
      else log.push(`  REJECTED ${s.ticker}: ${ds.flag}`);
      await new Promise(r => setTimeout(r, 300));
    }
    log.push(`After death spiral: ${clean.length} stocks`);

    // PHASE 8: HAIKU VETO
    log.push('Phase 8: Haiku veto (top 50)...');
    const top50 = clean.slice(0,50);
    const vetoed = await haikuVeto(top50);
    const approved = vetoed.filter(s => s.approved);
    log.push(`After Haiku: ${approved.length} approved`);

    // SAVE TO SUPABASE
    const scanDate = new Date().toISOString().split('T')[0];
    if (approved.length > 0) {
      await fetch(`${SUPABASE_URL}/rest/v1/gen4_candidates`, {
        method: 'POST',
        headers: {'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json','Prefer':'return=minimal'},
        body: JSON.stringify(approved.map(s => ({
          ticker: s.ticker, scan_date: scanDate, scan_mode: mode,
          quant_score: s.quantScore, quant_detail: s.quant?.scores,
          price: s.price, market_cap: s.marketCap, sector: s.sector,
          rules_passed: s.rules?.passed, sector_healthy: s.sectorHealth?.healthy,
          haiku_reason: s.haikuReason, macro_regime: macro.regime,
          macro_score: parseFloat(macro.score||0), status: 'candidate',
          created_at: new Date().toISOString()
        })))
      }).catch(e => log.push(`Supabase error: ${e.message}`));
      log.push(`Saved ${approved.length} candidates to Supabase`);
    }

    const elapsed = ((Date.now()-startTime)/1000/60).toFixed(1);

    res.json({
      success: true, mode, elapsed:`${elapsed} min`,
      estimatedCost:`$${(Math.min(top50.length,50)*0.001).toFixed(3)}`,
      macro: {regime:macro.regime, score:macro.score, vix:macro.vix},
      funnel: {
        universe: symbols.length,
        withValidData: stockData.length,
        passedQuant: scored.length,
        passed7Rules: rulesPass.length,
        passedSector: sectorPass.length,
        passedDeathSpiral: clean.length,
        passedHaiku: approved.length
      },
      topCandidates: approved.slice(0,20).map(s => ({
        ticker: s.ticker,
        price: `$${s.price?.toFixed(2)}`,
        quantScore: s.quantScore,
        scores: s.quant?.scores,
        sector: s.sector,
        haikuReason: s.haikuReason
      })),
      log
    });

  } catch(e) {
    res.status(500).json({error: e.message, stack: e.stack?.slice(0,500), log});
  }
};
