// api/cron-daily.js — Daily 9:31am ET
// Uses Polygon news API (no web search) for material news detection
// Cost: ~$0.50-2/day vs $178/day old approach

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

  try {
    const log = [];
    const start = Date.now();

    // 1. Get open positions
    const posResp = await sf(
      `${SUPABASE_URL}/rest/v1/study_picks?status=eq.open&select=id,ticker,strategy_id,entry_price,reasoning`,
      {headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`}}
    );
    const positions = posResp || [];
    log.push(`Open positions: ${positions.length}`);

    // 2. Macro news check — ONE Polygon call covers all positions
    // Filter general news for macro keywords client-side
    const generalNews = await getPolygonNews(null, 50);
    const macroHits = filterMacroNews(generalNews);
    if (macroHits.length > 0) {
      log.push(`Macro events detected: ${macroHits.length} articles`);
      log.push(macroHits.slice(0,3).map(a => a.title).join(' | '));
    }

    // 3. Per-position news check — Polygon news per ticker (free, no web search)
    const triggeredPositions = [];

    for (const pos of positions) {
      // Polygon news for this specific ticker
      const articles = await getPolygonNews(pos.ticker, 10);
      
      // Filter by keyword categories client-side
      const matched = filterNewsByCategory(articles, COMPANY_KEYWORDS);
      const categories = Object.keys(matched);
      
      if (categories.length === 0 && macroHits.length === 0) continue;

      // Build context for Haiku
      const newsContext = [
        ...categories.map(cat => `${cat.toUpperCase()}: ${matched[cat].slice(0,2).join('; ')}`),
        macroHits.length > 0 ? `MACRO: ${macroHits.slice(0,2).map(a=>a.title).join('; ')}` : ''
      ].filter(Boolean).join('\n');

      // Haiku material check — $0.001, cached prompt
      const check = await callHaiku(
        HAIKU_MATERIAL_SYSTEM,
        `Position: ${pos.ticker} (${pos.strategy_id})\nMatched news:\n${newsContext}\n\nRequires full re-analysis?`
      );

      if (check?.startsWith('YES')) {
        triggeredPositions.push({...pos, newsContext, triggerReason: check, matched});
        log.push(`TRIGGERED ${pos.ticker}: ${check}`);
      }
    }

    // 4. Sonnet deep dives on triggered positions — no web search needed
    // Polygon news already provided all context
    const diveResults = [];
    for (const pos of triggeredPositions.slice(0, 5)) {
      const quote = await sf(`https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${FINNHUB}`);
      const currentPrice = quote?.c || pos.entry_price;
      const pnlPct = ((currentPrice - pos.entry_price) / pos.entry_price * 100).toFixed(1);

      const analysis = await callSonnet(
        SONNET_TRIGGERED_SYSTEM,
        `Ticker: ${pos.ticker} | Strategy: ${pos.strategy_id}
Entry: $${pos.entry_price} | Current: $${currentPrice} (${pnlPct}% P&L)
Original thesis: ${pos.reasoning}

Polygon news context:
${pos.newsContext}

Trigger reason: ${pos.triggerReason}

Provide decision.`
      );

      if (analysis) {
        diveResults.push({ticker: pos.ticker, analysis: analysis.slice(0,500)});
        await fetch(`${SUPABASE_URL}/rest/v1/study_notes`, {
          method: 'POST',
          headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
          body: JSON.stringify({
            ticker: pos.ticker, pick_id: pos.id,
            note_type: 'triggered_dive', content: analysis,
            created_at: new Date().toISOString()
          })
        }).catch(() => null);
      }
    }

    // 5. Daily universe scan — Haiku scores 50 random stocks
    const symbolsResp = await sf(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB}`);
    const validSymbols = (symbolsResp || [])
      .filter(s => s.type==='Common Stock' && s.currency==='USD' &&
        s.symbol && !s.symbol.includes('.') && !s.symbol.includes('/') &&
        s.symbol.length<=5 && !/[FKEPHY]$/.test(s.symbol.toUpperCase()) &&
        ['XNAS','XNYS','XASE'].includes(s.mic))
      .map(s => s.symbol)
      .sort(() => Math.random()-0.5)
      .slice(0, 50);

    const quotes = await Promise.all(
      validSymbols.map(sym =>
        sf(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`)
          .then(q => q?.c >= 2 ? {ticker:sym, price:q.c, change:q.dp||0} : null)
          .catch(() => null)
      )
    );
    const validQuotes = quotes.filter(Boolean);

    let newCandidates = [];
    if (validQuotes.length > 0) {
      const list = validQuotes.map(q =>
        `${q.ticker}: $${q.price.toFixed(2)} (${q.change>0?'+':''}${q.change.toFixed(1)}%)`
      ).join('\n');
      const scored = await callHaiku(HAIKU_SCORE_SYSTEM, `Rate these stocks:\n${list}`, 600);
      if (scored) {
        try {
          const parsed = JSON.parse(scored.replace(/```json|```/g,'').trim());
          newCandidates = parsed.filter(s => s.score >= 7).slice(0,10);
        } catch(e) {}
      }
    }

    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    return new Response(JSON.stringify({
      success: true,
      summary: {
        openPositions: positions.length,
        macroEvents: macroHits.length,
        triggered: triggeredPositions.length,
        divesConducted: diveResults.length,
        newCandidates: newCandidates.length,
        webSearchesUsed: 0,
        polygonCallsUsed: positions.length + 1,
        elapsed: `${elapsed}s`
      },
      triggeredTickers: triggeredPositions.map(p=>p.ticker),
      newCandidates,
      macroHeadlines: macroHits.slice(0,5).map(a=>a.title),
      log
    }), {headers:CORS});

  } catch(e) {
    return new Response(JSON.stringify({error:e.message}), {status:500,headers:CORS});
  }
}
