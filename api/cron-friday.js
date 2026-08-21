// api/cron-friday.js
// Friday 4:30pm ET — full universe discovery run
// Finnhub 4,948 symbols → price filter → Haiku → Sonnet + web search
// Cost: ~$80-130 per run

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB = process.env.FINNHUB_KEY || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

async function sf(url, opts={}, timeout=10000) {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, {signal: ctrl.signal, ...opts});
    clearTimeout(id);
    return r.ok ? await r.json() : null;
  } catch(e) { return null; }
}

// Cached system prompts — 90% off repeat input tokens
const HAIKU_SCORE_SYSTEM = `You are a stock screener. Rate each stock 1-10 for momentum opportunity.
Score 8-10: Strong — above key MAs, RSI 40-65, volume spike, near 52W high, positive momentum
Score 5-7: Moderate — mixed signals
Score 1-4: Weak — downtrend, no catalyst

Respond ONLY with JSON array: [{"ticker":"X","score":8,"reason":"brief"}]`;

const SONNET_DEEP_SYSTEM = `You are a senior institutional analyst conducting a Friday discovery deep dive. Analyze this stock for Monday trading opportunity.

Write exactly 4 sections:
1. SETUP — Technical picture, key levels, momentum quality
2. CATALYST — What could drive this stock next week? Use web search for recent news.
3. THESIS — Bull case in 2-3 sentences. What is the edge here?
4. TRADE PLAN — Entry zone, stop loss, target 1, target 2, position size (1-5%), time horizon

Be specific with price levels. No disclaimers.`;

const POSTMORTEM_SYSTEM = `You are a trading coach conducting a post-mortem analysis. Review this closed trade and extract lessons.

Analyze:
1. Was the entry thesis correct? What signals worked/failed?
2. Was exit timing optimal?
3. What would you do differently?
4. Key lesson in one sentence.

Respond with structured JSON: {"entry_correct":bool,"exit_optimal":bool,"lessons":string,"key_lesson":string}`;

async function callHaiku(system, user) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version':'2023-06-01',
      'anthropic-beta':'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: [{type:'text', text:system, cache_control:{type:'ephemeral'}}],
      messages: [{role:'user', content:user}]
    })
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.content?.[0]?.text || null;
}

async function callSonnet(system, user) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version':'2023-06-01',
      'anthropic-beta':'prompt-caching-2024-07-31,web-search-2025-03-05'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: [{type:'text', text:system, cache_control:{type:'ephemeral'}}],
      messages: [{role:'user', content:user}],
      tools: [{type:'web_search_20250305', name:'web_search', max_results:2}]
    })
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.content?.filter(b => b.type==='text').map(b => b.text).join('') || null;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', {headers: CORS});

  // Allow manual trigger or cron
  const secret = new URL(req.url).searchParams.get('secret');
  if (secret !== 'pulsestock2026' && req.headers.get('x-vercel-cron') !== '1') {
    return new Response(JSON.stringify({error:'Unauthorized'}), {status:401, headers:CORS});
  }

  try {
    const log = [];
    const start = Date.now();

    // STEP 1: Get full US stock universe — 4,948 NYSE/NASDAQ stocks
    log.push('Fetching universe...');
    const symbolsResp = await sf(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB}`, {}, 30000);
    
    const allSymbols = (symbolsResp || []).filter(s =>
      s.type === 'Common Stock' && s.currency === 'USD' &&
      s.symbol && !s.symbol.includes('.') && !s.symbol.includes('/') &&
      s.symbol.length <= 5 && !/[FKEPHY]$/.test(s.symbol.toUpperCase()) &&
      ['XNAS','XNYS','XASE'].includes(s.mic)
    ).map(s => s.symbol);

    log.push(`Universe: ${allSymbols.length} stocks after symbol filter`);

    // STEP 2: Get quotes in batches — filter price > $2, dollar vol > $500k
    // Process in batches of 20 with rate limiting
    const passing = [];
    const batchSize = 20;
    
    for (let i = 0; i < Math.min(allSymbols.length, 500); i += batchSize) {
      const batch = allSymbols.slice(i, i + batchSize);
      const results = await Promise.all(
        batch.map(sym =>
          sf(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`)
            .then(q => {
              if (!q || q.c < 2) return null;
              const dollarVol = q.c * (q.v || 0);
              if (q.v > 0 && dollarVol < 500000) return null;
              return {
                ticker: sym,
                price: q.c,
                change: q.dp || 0,
                prevClose: q.pc || 0,
                high: q.h || 0,
                low: q.l || 0,
                volume: q.v || 0,
                dollarVol
              };
            })
            .catch(() => null)
        )
      );
      passing.push(...results.filter(Boolean));
      if (i + batchSize < allSymbols.length) await new Promise(r => setTimeout(r, 300));
    }

    log.push(`After price+volume filter (sample of 500): ${passing.length} passing`);

    // STEP 3: Sort by momentum signals — biggest movers + highest volume
    const sorted = passing
      .sort((a,b) => (Math.abs(b.change) * (b.dollarVol || 1)) - (Math.abs(a.change) * (a.dollarVol || 1)))
      .slice(0, 200);

    // STEP 4: Haiku scores top 200 in batches of 50
    log.push('Haiku scoring...');
    const haikuScored = [];
    
    for (let i = 0; i < sorted.length; i += 50) {
      const batch = sorted.slice(i, i + 50);
      const stockList = batch.map(q =>
        `${q.ticker}: $${q.price.toFixed(2)} (${q.change>0?'+':''}${q.change.toFixed(1)}%) vol:${q.volume ? (q.dollarVol/1e6).toFixed(1)+'M' : 'N/A'}`
      ).join('\n');
      
      const scored = await callHaiku(HAIKU_SCORE_SYSTEM, `Rate these stocks:\n${stockList}`);
      if (scored) {
        try {
          const parsed = JSON.parse(scored.replace(/```json|```/g,'').trim());
          haikuScored.push(...parsed);
        } catch(e) {}
      }
      await new Promise(r => setTimeout(r, 500));
    }

    // Top 50 from Haiku scoring
    const top50 = haikuScored
      .filter(s => s.score >= 6)
      .sort((a,b) => b.score - a.score)
      .slice(0, 50);
    
    log.push(`Haiku top 50 (score 6+): ${top50.length} stocks`);

    // STEP 5: Keyword news searches on top 50
    const withNews = await Promise.all(
      top50.map(async s => {
        const news = await sf(`https://finnhub.io/api/v1/news?category=company&symbol=${s.ticker}&token=${FINNHUB}`);
        const headlines = (news || []).slice(0, 3).map(n => n.headline || '').join('. ');
        return {...s, headlines};
      })
    );

    // Haiku filters for red flags
    const clean = [];
    for (const s of withNews) {
      if (!s.headlines) { clean.push(s); continue; }
      const check = await callHaiku(
        `You are a risk filter. Does this news contain RED FLAGS that would make this a dangerous trade? Red flags: dilution, going concern, fraud, regulatory action, massive insider selling. Respond ONLY: CLEAN or RISKY: [reason]`,
        `Stock: ${s.ticker}\nNews: ${s.headlines}`
      );
      if (!check?.startsWith('RISKY')) clean.push({...s, headlines: s.headlines});
    }

    log.push(`Clean after risk filter: ${clean.length} stocks`);

    // STEP 6: Sonnet full deep dive on top candidates
    // No cap on how many we analyze — run through the clean list
    const deepDives = [];
    let sonnetCount = 0;

    for (const s of clean) {
      const quoteData = passing.find(p => p.ticker === s.ticker);
      if (!quoteData) continue;

      const analysis = await callSonnet(
        SONNET_DEEP_SYSTEM,
        `Ticker: ${s.ticker}\nPrice: $${quoteData.price.toFixed(2)} (${quoteData.change>0?'+':''}${quoteData.change.toFixed(1)}% today)\nVolume: ${quoteData.volume?.toLocaleString() || 'N/A'}\nHaiku score: ${s.score}/10\nHaiku reason: ${s.reason}\nRecent news: ${s.headlines || 'none'}\n\nConduct full Friday discovery deep dive.`
      );

      if (analysis) {
        deepDives.push({
          ticker: s.ticker,
          score: s.score,
          price: quoteData.price,
          change: quoteData.change,
          analysis: analysis.slice(0, 1000),
          headlines: s.headlines
        });
        sonnetCount++;

        // Save to Supabase candidates table
        await fetch(`${SUPABASE_URL}/rest/v1/study_candidates`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            ticker: s.ticker,
            scan_date: new Date().toISOString().split('T')[0],
            haiku_score: s.score,
            haiku_reason: s.reason,
            price: quoteData.price,
            change_pct: quoteData.change,
            analysis,
            headlines: s.headlines,
            status: 'candidate',
            created_at: new Date().toISOString()
          })
        }).catch(() => null);
      }

      // Rate limit between Sonnet calls
      await new Promise(r => setTimeout(r, 200));
    }

    log.push(`Sonnet deep dives: ${sonnetCount}`);

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const estimatedCost = (sonnetCount * 0.055).toFixed(2);

    return new Response(JSON.stringify({
      success: true,
      summary: {
        universeSize: allSymbols.length,
        sampleProcessed: 500,
        passingFilters: passing.length,
        haikuScored: haikuScored.length,
        top50: top50.length,
        cleanAfterRisk: clean.length,
        sonnetDives: sonnetCount,
        elapsed: `${elapsed}s`,
        estimatedCost: `$${estimatedCost}`
      },
      topCandidates: deepDives.slice(0, 10).map(d => ({
        ticker: d.ticker,
        score: d.score,
        price: `$${d.price?.toFixed(2)}`,
        change: `${d.change>0?'+':''}${d.change?.toFixed(1)}%`,
        analysisPreview: d.analysis?.slice(0, 200)
      })),
      log
    }), {headers: CORS});

  } catch(e) {
    return new Response(JSON.stringify({error: e.message, stack: e.stack?.slice(0,300)}), {status:500, headers:CORS});
  }
}
