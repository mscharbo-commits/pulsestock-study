// api/cron-friday.js — Friday 4:30pm ET
// Full universe discovery using Polygon news (no web search)
// Cost: ~$5-15/run vs $127/run with web search

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB = process.env.FINNHUB_KEY || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
const POLYGON = process.env.POLYGON_API_KEY || '2c90554e-b7d3-485f-a497-b350eb8136f5';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

// ── Keyword categories for client-side news filtering ──
// No web search needed — filter Polygon news results in code
const COMPANY_KEYWORDS = {
  earnings:   ['earnings','EPS','revenue','guidance','beat','miss','outlook','quarterly'],
  financing:  ['convertible','offering','dilution','ATM','shelf','registration','raise','note'],
  regulatory: ['SEC','investigation','lawsuit','FDA','regulation','subpoena','DOJ','fine'],
  ma:         ['merger','acquisition','buyout','takeover','DEFM14A','strategic','deal'],
  goingconcern: ['going concern','bankruptcy','Chapter 11','insolvency','liquidity']
};

const MACRO_KEYWORDS = [
  'tariff','trade war','import duty','China',
  'Fed','Federal Reserve','rate hike','rate cut','FOMC','interest rate',
  'inflation','CPI','PPI','PCE',
  'regulation','antitrust','legislation','executive order',
  'recession','GDP','employment','jobs report',
  'sanctions','geopolitical','war','supply chain'
];

async function sf(url, opts={}, timeout=10000) {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, {signal: ctrl.signal, ...opts});
    clearTimeout(id);
    return r.ok ? await r.json() : null;
  } catch(e) { return null; }
}

// Polygon news — free, structured, no web search needed
// Returns articles with title, description, keywords, sentiment, tickers
async function getPolygonNews(ticker, limit=10) {
  const url = ticker
    ? `https://api.polygon.io/v2/reference/news?ticker=${ticker}&limit=${limit}&sort=published_utc&order=descending&apiKey=${POLYGON}`
    : `https://api.polygon.io/v2/reference/news?limit=50&sort=published_utc&order=descending&apiKey=${POLYGON}`;
  const data = await sf(url, {}, 8000);
  return data?.results || [];
}

// Filter news articles by keyword categories
function filterNewsByCategory(articles, categories) {
  const matched = {};
  for (const [cat, keywords] of Object.entries(categories)) {
    const hits = articles.filter(a => {
      const text = `${a.title} ${a.description||''} ${(a.keywords||[]).join(' ')}`.toLowerCase();
      return keywords.some(kw => text.includes(kw.toLowerCase()));
    });
    if (hits.length > 0) matched[cat] = hits.map(a => a.title);
  }
  return matched;
}

// Filter general news for macro events
function filterMacroNews(articles) {
  return articles.filter(a => {
    const text = `${a.title} ${a.description||''} ${(a.keywords||[]).join(' ')}`.toLowerCase();
    return MACRO_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  }).map(a => ({
    title: a.title,
    sentiment: a.insights?.[0]?.sentiment || 'neutral',
    keywords: a.keywords || []
  }));
}

// Haiku with prompt caching
async function callHaiku(systemPrompt, userPrompt, maxTokens=200) {
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
      max_tokens: maxTokens,
      system: [{type:'text', text:systemPrompt, cache_control:{type:'ephemeral'}}],
      messages: [{role:'user', content:userPrompt}]
    })
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.content?.[0]?.text || null;
}

// Sonnet with prompt caching — NO web search (Polygon handles news)
async function callSonnet(systemPrompt, userPrompt, maxTokens=2000) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'prompt-caching-2024-07-31'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: maxTokens,
      system: [{type:'text', text:systemPrompt, cache_control:{type:'ephemeral'}}],
      messages: [{role:'user', content:userPrompt}]
    })
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.content?.[0]?.text || null;
}

// Cached system prompts
const HAIKU_MATERIAL_SYSTEM = `You are a financial news filter for active trading positions.
Determine if any of the matched news categories require a full re-analysis of this position.

TRIGGER FULL DIVE (respond YES):
- Earnings: miss, beat, or guidance change
- Financing: any dilution, convertible notes, ATM offering
- Regulatory: SEC investigation, FDA action, DOJ inquiry
- M&A: merger announcement, buyout offer
- Going concern warning

SKIP (respond NO):
- Analyst ratings or price target changes only
- Normal market commentary
- Minor operational updates

Respond ONLY: YES: [one sentence reason] or NO: [one sentence reason]`;

const HAIKU_SCORE_SYSTEM = `You are a stock screener. Rate each stock 1-10 for momentum/swing trading opportunity.
Score 8-10: Strong — uptrend, RSI 40-65, volume surge, near 52W high, positive news
Score 5-7: Moderate — some positive signals, mixed picture  
Score 1-4: Weak — downtrend, no catalyst, poor technicals

Respond ONLY with valid JSON array: [{"ticker":"X","score":8,"reason":"brief reason"}]`;

const SONNET_TRIGGERED_SYSTEM = `You are a senior portfolio manager analyzing a triggered position alert.
Material news was detected. Decide: HOLD, ADD, REDUCE, or EXIT.

Provide:
- DECISION: one of the four options
- CONFIDENCE: High/Medium/Low  
- REASON: why in 2 sentences
- NEW STOP: updated stop loss price
- NEW TARGET: updated price target

Use the Polygon news data provided — no need to search externally.`;

const SONNET_DISCOVERY_SYSTEM = `You are a senior institutional analyst conducting a Friday discovery analysis.
You have Polygon news data for context — analyze for Monday trading opportunity.

Write exactly 4 sections:
1. SETUP — Technical picture, key levels, momentum quality
2. CATALYST — What news or events could drive this stock? Reference the provided news.
3. THESIS — Bull case in 2-3 sentences. What is the edge?
4. TRADE PLAN — Entry zone, stop loss, target 1, target 2, position size (1-5%), horizon

Be specific with price levels. No disclaimers.`;

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', {headers: CORS});

  const secret = new URL(req.url).searchParams.get('secret');
  if (secret !== 'pulsestock2026' && req.headers.get('x-vercel-cron') !== '1') {
    return new Response(JSON.stringify({error:'Unauthorized'}), {status:401,headers:CORS});
  }

  try {
    const log = [];
    const start = Date.now();

    // STEP 1: Macro context — ONE Polygon call, filter client-side
    log.push('Fetching macro news...');
    const generalNews = await getPolygonNews(null, 50);
    const macroEvents = filterMacroNews(generalNews);
    const macroSummary = macroEvents.slice(0,5).map(a=>a.title).join('. ');
    log.push(`Macro events: ${macroEvents.length} detected`);

    // STEP 2: Full universe from Finnhub symbols
    log.push('Fetching universe...');
    const symbolsResp = await sf(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB}`, {}, 30000);
    const allSymbols = (symbolsResp || []).filter(s =>
      s.type==='Common Stock' && s.currency==='USD' &&
      s.symbol && !s.symbol.includes('.') && !s.symbol.includes('/') &&
      s.symbol.length<=5 && !/[FKEPHY]$/.test(s.symbol.toUpperCase()) &&
      ['XNAS','XNYS','XASE'].includes(s.mic)
    ).map(s=>s.symbol);
    log.push(`Universe: ${allSymbols.length} symbols`);

    // STEP 3: Price + volume filter on sample
    const passing = [];
    const batchSize = 20;
    for (let i=0; i<Math.min(allSymbols.length,500); i+=batchSize) {
      const batch = allSymbols.slice(i,i+batchSize);
      const results = await Promise.all(
        batch.map(sym =>
          sf(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`)
            .then(q => {
              if (!q || q.c < 2) return null;
              if (q.v > 0 && (q.c * q.v) < 500000) return null;
              return {ticker:sym, price:q.c, change:q.dp||0, volume:q.v||0, dollarVol:q.c*(q.v||0)};
            })
            .catch(()=>null)
        )
      );
      passing.push(...results.filter(Boolean));
      if (i+batchSize < allSymbols.length) await new Promise(r=>setTimeout(r,300));
    }
    log.push(`Passing price+vol filter: ${passing.length}`);

    // STEP 4: Sort by momentum, take top 200
    const sorted = passing
      .sort((a,b) => (Math.abs(b.change)*(b.dollarVol||1)) - (Math.abs(a.change)*(a.dollarVol||1)))
      .slice(0,200);

    // STEP 5: Haiku scores in batches of 50
    log.push('Haiku scoring...');
    const haikuScored = [];
    for (let i=0; i<sorted.length; i+=50) {
      const batch = sorted.slice(i,i+50);
      const list = batch.map(q =>
        `${q.ticker}: $${q.price.toFixed(2)} (${q.change>0?'+':''}${q.change.toFixed(1)}%)`
      ).join('\n');
      const scored = await callHaiku(HAIKU_SCORE_SYSTEM, `Rate these stocks:\n${list}`, 800);
      if (scored) {
        try {
          const parsed = JSON.parse(scored.replace(/```json|```/g,'').trim());
          haikuScored.push(...parsed);
        } catch(e) {}
      }
      await new Promise(r=>setTimeout(r,500));
    }
    const top50 = haikuScored.filter(s=>s.score>=6).sort((a,b)=>b.score-a.score).slice(0,50);
    log.push(`Haiku top 50 (score 6+): ${top50.length}`);

    // STEP 6: Polygon news per ticker — filter for red flags + catalysts
    // NO web search — Polygon covers all company news
    log.push('Fetching Polygon news for top candidates...');
    const withNews = [];
    for (const s of top50) {
      const articles = await getPolygonNews(s.ticker, 5);
      const matched = filterNewsByCategory(articles, COMPANY_KEYWORDS);
      const redFlags = matched.financing || matched.goingconcern;
      const catalysts = matched.earnings || matched.ma || matched.regulatory;
      
      const sentiment = articles.length > 0
        ? articles[0]?.insights?.[0]?.sentiment || 'neutral'
        : 'neutral';

      const newsContext = Object.entries(matched)
        .map(([cat,titles]) => `${cat.toUpperCase()}: ${titles.slice(0,1).join('; ')}`)
        .join('\n');

      withNews.push({
        ...s,
        articles,
        redFlags: !!redFlags,
        catalysts: !!catalysts,
        sentiment,
        newsContext: newsContext || 'No material news detected'
      });
      await new Promise(r=>setTimeout(r,100)); // gentle rate limit
    }

    // Filter out red flags
    const clean = withNews.filter(s => !s.redFlags);
    log.push(`Clean after red flag filter: ${clean.length}`);

    // STEP 7: Sonnet full deep dive — NO web search, uses Polygon news context
    log.push('Running Sonnet deep dives...');
    const deepDives = [];

    for (const s of clean) {
      const quoteData = passing.find(p=>p.ticker===s.ticker);
      if (!quoteData) continue;

      const analysis = await callSonnet(
        SONNET_DISCOVERY_SYSTEM,
        `Ticker: ${s.ticker}
Price: $${quoteData.price.toFixed(2)} (${quoteData.change>0?'+':''}${quoteData.change.toFixed(1)}% today)
Volume: $${quoteData.dollarVol?(quoteData.dollarVol/1e6).toFixed(1)+'M':'N/A'}
Haiku score: ${s.score}/10 — ${s.reason}
Sentiment: ${s.sentiment}

Company news (from Polygon):
${s.newsContext}

Macro context:
${macroSummary || 'No significant macro events'}

Conduct Friday discovery deep dive.`,
        1500
      );

      if (analysis) {
        deepDives.push({
          ticker: s.ticker,
          score: s.score,
          price: quoteData.price,
          change: quoteData.change,
          sentiment: s.sentiment,
          catalysts: s.catalysts,
          analysis
        });

        // Save to Supabase
        await fetch(`${SUPABASE_URL}/rest/v1/study_candidates`, {
          method: 'POST',
          headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json','Prefer':'return=minimal'},
          body: JSON.stringify({
            ticker: s.ticker,
            scan_date: new Date().toISOString().split('T')[0],
            haiku_score: s.score,
            haiku_reason: s.reason,
            price: quoteData.price,
            change_pct: quoteData.change,
            analysis,
            news_context: s.newsContext,
            sentiment: s.sentiment,
            status: 'candidate',
            created_at: new Date().toISOString()
          })
        }).catch(()=>null);
      }
      await new Promise(r=>setTimeout(r,200));
    }

    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const estimatedCost = (deepDives.length * 0.037).toFixed(2); // No web search surcharge

    return new Response(JSON.stringify({
      success: true,
      summary: {
        universeSize: allSymbols.length,
        sampleProcessed: 500,
        passingFilters: passing.length,
        haikuScored: haikuScored.length,
        top50: top50.length,
        cleanAfterRedFlags: clean.length,
        sonnetDives: deepDives.length,
        webSearchesUsed: 0,
        polygonNewsCallsUsed: top50.length + 1,
        elapsed: `${elapsed}s`,
        estimatedCost: `$${estimatedCost} (Sonnet only, no web search)`
      },
      macroEvents: macroEvents.slice(0,5).map(a=>a.title),
      topCandidates: deepDives.slice(0,10).map(d=>
        `${d.ticker} $$${d.price?.toFixed(2)} (${d.change>0?'+':''}${d.change?.toFixed(1)}%) score:${d.score}/10 ${d.sentiment}`
      ),
      log
    }), {headers:CORS});

  } catch(e) {
    return new Response(JSON.stringify({error:e.message,stack:e.stack?.slice(0,300)}),{status:500,headers:CORS});
  }
}
