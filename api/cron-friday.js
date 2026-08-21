// api/cron-friday.js — Friday 4:30pm ET
// Full universe discovery — Polygon news + full article fetch on keyword match
// No web search. Real article content. No headline spin.

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB = process.env.FINNHUB_KEY || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
const POLYGON = process.env.POLYGON_API_KEY || '2c90554e-b7d3-485f-a497-b350eb8136f5';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

const COMPANY_KEYWORDS = {
  earnings:     ['earnings','EPS','revenue','guidance','beat','miss','outlook','quarterly','results'],
  financing:    ['convertible','offering','dilution','ATM','shelf','registration','raise','note','shares'],
  regulatory:   ['SEC','investigation','lawsuit','FDA','regulation','subpoena','DOJ','fine','penalty'],
  ma:           ['merger','acquisition','buyout','takeover','DEFM14A','strategic','deal','combines'],
  goingconcern: ['going concern','bankruptcy','Chapter 11','insolvency','liquidity','default']
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

// Fetch full article body from URL — no search fee, just a GET
// Strips HTML tags to get readable text
async function fetchArticleBody(url, maxChars=3000) {
  try {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 8000);
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: {'User-Agent': 'Mozilla/5.0 (compatible; PulseStock/1.0)'}
    });
    if (!r.ok) return null;
    const html = await r.text();
    
    // Strip HTML — extract text content
    // Remove scripts, styles, nav, footer
    let text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    
    // Return first maxChars — enough for Haiku to assess
    return text.slice(0, maxChars) || null;
  } catch(e) {
    return null;
  }
}

// Polygon news for a ticker or general market news
async function getPolygonNews(ticker, limit=10) {
  const url = ticker
    ? `https://api.polygon.io/v2/reference/news?ticker=${ticker}&limit=${limit}&sort=published_utc&order=descending&apiKey=${POLYGON}`
    : `https://api.polygon.io/v2/reference/news?limit=50&sort=published_utc&order=descending&apiKey=${POLYGON}`;
  const data = await sf(url, {}, 8000);
  return data?.results || [];
}

// Step 1: Quick keyword scan on headline + description + tags
// Step 2: If keyword fires, fetch full article body for real content
// Returns articles with full body where keywords matched
async function getNewsWithContent(ticker, limit=10) {
  const articles = await getPolygonNews(ticker, limit);
  const results = [];

  for (const article of articles) {
    const headlineText = `${article.title} ${article.description||''} ${(article.keywords||[]).join(' ')}`.toLowerCase();
    
    // Check which categories this headline matches
    const matchedCats = [];
    for (const [cat, keywords] of Object.entries(COMPANY_KEYWORDS)) {
      if (keywords.some(kw => headlineText.includes(kw.toLowerCase()))) {
        matchedCats.push(cat);
      }
    }

    if (matchedCats.length === 0) {
      // No keyword match — skip article fetch, just include metadata
      results.push({
        title: article.title,
        description: article.description,
        published: article.published_utc,
        sentiment: article.insights?.[0]?.sentiment || 'neutral',
        matchedCategories: [],
        fullBody: null
      });
      continue;
    }

    // Keyword matched — fetch full article body (no search fee)
    const fullBody = await fetchArticleBody(article.article_url);
    
    results.push({
      title: article.title,
      description: article.description,
      published: article.published_utc,
      sentiment: article.insights?.[0]?.sentiment || 'neutral',
      matchedCategories: matchedCats,
      articleUrl: article.article_url,
      fullBody  // real article content, not headline spin
    });
  }

  return results;
}

// Get macro context — one Polygon call, filter + fetch top macro articles
async function getMacroContext() {
  const articles = await getPolygonNews(null, 50);
  const macroArticles = articles.filter(a => {
    const text = `${a.title} ${a.description||''} ${(a.keywords||[]).join(' ')}`.toLowerCase();
    return MACRO_KEYWORDS.some(kw => text.includes(kw.toLowerCase()));
  });

  // Fetch body of top 3 macro articles for real content
  const withBodies = [];
  for (const a of macroArticles.slice(0,3)) {
    const body = await fetchArticleBody(a.article_url, 1500);
    withBodies.push({
      title: a.title,
      body: body || a.description || a.title
    });
  }
  return withBodies;
}

// Build news context string for Claude — real content, not spin
function buildNewsContext(articles) {
  const material = articles.filter(a => a.matchedCategories.length > 0);
  if (material.length === 0) return null;
  
  return material.map(a => {
    const content = a.fullBody
      ? `${a.title}\n[Full article]: ${a.fullBody.slice(0,1500)}`
      : `${a.title}\n[Summary]: ${a.description || 'No summary available'}`;
    return `[${a.matchedCategories.join(',').toUpperCase()}] ${content}`;
  }).join('\n\n---\n\n');
}

// Haiku with prompt caching
async function callHaiku(systemPrompt, userPrompt, maxTokens=300) {
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

// Sonnet with prompt caching — NO web search (full article body from Polygon URLs)
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
const HAIKU_MATERIAL_SYSTEM = `You are a financial analyst assessing whether news warrants a full position review.
You are reading REAL article content — not just headlines. Assess the actual substance.

TRIGGER FULL REVIEW (respond YES):
- Earnings: actual miss/beat with numbers, guidance cut/raise
- Financing: dilution confirmed, convertible notes issued, ATM program active  
- Regulatory: active investigation, fine imposed, FDA rejection
- M&A: definitive agreement announced, offer price stated
- Going concern: auditor flagged, liquidity crisis confirmed

DO NOT TRIGGER (respond NO):
- Analyst upgrades/downgrades with no new fundamental data
- Speculative rumors without confirmation
- Marketing announcements, product launches (unless massive)
- Normal operations

Respond ONLY: YES: [specific reason citing article content] or NO: [reason]`;

const HAIKU_SCORE_SYSTEM = `You are a stock screener. Rate each stock 1-10 for momentum/swing trading opportunity.
Score 8-10: Strong — uptrend, RSI 40-65, volume surge, near 52W high, positive momentum
Score 5-7: Moderate — some positive signals, mixed picture  
Score 1-4: Weak — downtrend, no catalyst, poor technicals

Respond ONLY with valid JSON array: [{"ticker":"X","score":8,"reason":"brief reason"}]`;

const SONNET_TRIGGERED_SYSTEM = `You are a senior portfolio manager reviewing a triggered position.
You have the FULL article content — read it carefully, not just the headline.
Headlines are marketing. The article body contains the real information.

Decide: HOLD, ADD, REDUCE, or EXIT.
- HOLD: thesis intact, news confirms or is neutral
- ADD: news materially strengthens the position
- REDUCE: some thesis degradation, reduce exposure  
- EXIT: thesis broken, exit immediately

Provide:
DECISION: [one of four]
CONFIDENCE: High/Medium/Low
REASON: [cite specific facts from the article, not the headline]
NEW STOP: $[price]
NEW TARGET: $[price]`;

const SONNET_DISCOVERY_SYSTEM = `You are a senior institutional analyst conducting Friday discovery analysis.
You have FULL article content from Polygon news — read it carefully.
Headlines are marketing. Base your analysis on actual article substance.

Write exactly 4 sections:
1. SETUP — Technical picture, key levels, momentum quality
2. CATALYST — What does the actual article content reveal? Cite specific facts.
3. THESIS — Bull case in 2-3 sentences based on real fundamentals.
4. TRADE PLAN — Entry zone, stop loss, target 1, target 2, position size (1-5%), horizon

Be specific. No disclaimers. Cite actual numbers from the articles.`;

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', {headers: CORS});

  const secret = new URL(req.url).searchParams.get('secret');
  if (secret !== 'pulsestock2026' && req.headers.get('x-vercel-cron') !== '1') {
    return new Response(JSON.stringify({error:'Unauthorized'}), {status:401,headers:CORS});
  }

  try {
    const log = [];
    const start = Date.now();

    // STEP 1: Macro context — fetch full article bodies
    log.push('Fetching macro context...');
    const macroArticles = await getMacroContext();
    const macroContext = macroArticles.map(a =>
      `${a.title}\n${a.body.slice(0,600)}`
    ).join('\n---\n');
    log.push(`Macro: ${macroArticles.length} articles`);

    // STEP 2: Full universe
    log.push('Fetching universe...');
    const symbolsResp = await sf(
      `https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB}`, {}, 30000
    );
    const allSymbols = (symbolsResp || []).filter(s =>
      s.type==='Common Stock' && s.currency==='USD' &&
      s.symbol && !s.symbol.includes('.') && !s.symbol.includes('/') &&
      s.symbol.length<=5 && !/[FKEPHY]$/.test(s.symbol.toUpperCase()) &&
      ['XNAS','XNYS','XASE'].includes(s.mic)
    ).map(s=>s.symbol);
    log.push(`Universe: ${allSymbols.length} symbols`);

    // STEP 3: Price + volume filter on sample of 500
    const passing = [];
    for (let i=0; i<Math.min(allSymbols.length,500); i+=20) {
      const batch = allSymbols.slice(i,i+20);
      const results = await Promise.all(
        batch.map(sym =>
          sf(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`)
            .then(q => {
              if (!q || q.c < 2) return null;
              if (q.v > 0 && (q.c*q.v) < 500000) return null;
              return {ticker:sym,price:q.c,change:q.dp||0,volume:q.v||0,dollarVol:q.c*(q.v||0)};
            })
            .catch(()=>null)
        )
      );
      passing.push(...results.filter(Boolean));
      if (i+20 < allSymbols.length) await new Promise(r=>setTimeout(r,300));
    }
    log.push(`Passing filters: ${passing.length}`);

    // STEP 4: Sort by momentum, top 200 to Haiku
    const sorted = passing
      .sort((a,b)=>(Math.abs(b.change)*(b.dollarVol||1))-(Math.abs(a.change)*(a.dollarVol||1)))
      .slice(0,200);

    // STEP 5: Haiku scores
    log.push('Haiku scoring...');
    const haikuScored = [];
    for (let i=0; i<sorted.length; i+=50) {
      const batch = sorted.slice(i,i+50);
      const list = batch.map(q =>
        `${q.ticker}: $${q.price.toFixed(2)} (${q.change>0?'+':''}${q.change.toFixed(1)}%)`
      ).join('\n');
      const scored = await callHaiku(HAIKU_SCORE_SYSTEM, `Rate:\n${list}`, 800);
      if (scored) {
        try { haikuScored.push(...JSON.parse(scored.replace(/```json|```/g,'').trim())); }
        catch(e) {}
      }
      await new Promise(r=>setTimeout(r,500));
    }
    const top50 = haikuScored.filter(s=>s.score>=6).sort((a,b)=>b.score-a.score).slice(0,50);
    log.push(`Top 50 (score 6+): ${top50.length}`);

    // STEP 6: Polygon news + FULL ARTICLE FETCH for keyword matches
    // This replaces web search entirely — real content, no spin
    log.push('Fetching news + article bodies for top candidates...');
    const withContent = [];

    for (const s of top50) {
      // Get news with full article bodies where keywords match
      const articles = await getNewsWithContent(s.ticker, 5);
      
      const material = articles.filter(a => a.matchedCategories.length > 0);
      const redFlags = material.some(a =>
        a.matchedCategories.includes('financing') ||
        a.matchedCategories.includes('goingconcern')
      );

      // Build rich context from real article bodies
      const newsContext = buildNewsContext(articles);
      const sentiment = articles[0]?.sentiment || 'neutral';

      withContent.push({
        ...s,
        redFlags,
        newsContext: newsContext || 'No material news',
        articlesFetched: material.length,
        sentiment
      });

      await new Promise(r=>setTimeout(r,150));
    }

    // Filter red flags
    const clean = withContent.filter(s => !s.redFlags);
    log.push(`Clean (no red flags): ${clean.length}`);

    // STEP 7: Sonnet deep dives — real article content provided
    // No web search — Polygon + article fetch covers everything
    log.push('Sonnet deep dives...');
    const deepDives = [];

    for (const s of clean) {
      const quoteData = passing.find(p=>p.ticker===s.ticker);
      if (!quoteData) continue;

      const analysis = await callSonnet(
        SONNET_DISCOVERY_SYSTEM,
        `Ticker: ${s.ticker}
Price: $${quoteData.price.toFixed(2)} (${quoteData.change>0?'+':''}${quoteData.change.toFixed(1)}% today)
Volume: ${quoteData.dollarVol?(quoteData.dollarVol/1e6).toFixed(1)+'M':'N/A'}
Haiku score: ${s.score}/10 — ${s.reason}
Sentiment: ${s.sentiment}
Articles with full content fetched: ${s.articlesFetched}

${s.newsContext}

Macro context:
${macroContext.slice(0,600) || 'No significant macro events'}

Conduct full Friday discovery analysis.`,
        1500
      );

      if (analysis) {
        deepDives.push({
          ticker: s.ticker, score: s.score,
          price: quoteData.price, change: quoteData.change,
          sentiment: s.sentiment, analysis
        });

        await fetch(`${SUPABASE_URL}/rest/v1/study_candidates`, {
          method: 'POST',
          headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json','Prefer':'return=minimal'},
          body: JSON.stringify({
            ticker: s.ticker,
            scan_date: new Date().toISOString().split('T')[0],
            haiku_score: s.score, haiku_reason: s.reason,
            price: quoteData.price, change_pct: quoteData.change,
            analysis, news_context: s.newsContext,
            sentiment: s.sentiment, status: 'candidate',
            created_at: new Date().toISOString()
          })
        }).catch(()=>null);
      }
      await new Promise(r=>setTimeout(r,200));
    }

    const elapsed = ((Date.now()-start)/1000).toFixed(1);
    const cost = (deepDives.length * 0.037).toFixed(2);

    return new Response(JSON.stringify({
      success: true,
      summary: {
        universeSize: allSymbols.length,
        passingFilters: passing.length,
        haikuScored: haikuScored.length,
        top50: top50.length,
        cleanAfterRedFlags: clean.length,
        sonnetDives: deepDives.length,
        webSearchesUsed: 0,
        approach: 'Polygon news + full article fetch on keyword match — no headline spin',
        estimatedCost: `$${cost} (Sonnet only)`,
        elapsed: `${elapsed}s`
      },
      macroHeadlines: macroArticles.map(a=>a.title),
      topCandidates: deepDives.slice(0,10).map(d=>
        `${d.ticker} $$${d.price?.toFixed(2)} (${d.change>0?'+':''}${d.change?.toFixed(1)}%) score:${d.score}/10`
      ),
      log
    }), {headers:CORS});

  } catch(e) {
    return new Response(JSON.stringify({error:e.message,stack:e.stack?.slice(0,300)}),{status:500,headers:CORS});
  }
}
