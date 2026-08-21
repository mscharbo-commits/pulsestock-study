// api/cron-daily.js
// Daily 9:31am ET — lightweight monitoring + keyword news check
// Cost: ~$3-5/day vs $178/day old approach

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB = process.env.FINNHUB_KEY || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';

const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

// Keyword search categories — targeted, not broad
const KEYWORD_CATEGORIES = {
  earnings:   (t) => `${t} earnings guidance revenue Q3 2026`,
  financing:  (t) => `${t} convertible note offering dilution ATM shelf registration`,
  regulatory: (t) => `${t} SEC investigation lawsuit FDA regulation subpoena`,
  ma:         (t) => `${t} merger acquisition buyout takeover DEFM14A`,
  macro:      (sector) => `${sector} tariff regulation Fed rate inflation 2026`
};

// Macro sectors — one search covers all positions in that sector
const MACRO_SECTORS = ['technology','healthcare','energy','financial','consumer'];

async function sf(url, opts={}, timeout=8000) {
  try {
    const ctrl = new AbortController();
    const id = setTimeout(() => ctrl.abort(), timeout);
    const r = await fetch(url, {signal: ctrl.signal, ...opts});
    clearTimeout(id);
    return r.ok ? await r.json() : null;
  } catch(e) { return null; }
}

async function callHaiku(systemPrompt, userPrompt, useCache=true) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'prompt-caching-2024-07-31'
  };
  const system = useCache
    ? [{type:'text', text: systemPrompt, cache_control: {type:'ephemeral'}}]
    : systemPrompt;
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      system,
      messages: [{role:'user', content: userPrompt}]
    })
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.content?.[0]?.text || null;
}

async function callSonnet(systemPrompt, userPrompt, useSearch=true) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ANTHROPIC_KEY,
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'prompt-caching-2024-07-31'
  };
  if (useSearch) headers['anthropic-beta'] += ',web-search-2025-03-05';
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: [{type:'text', text: systemPrompt, cache_control: {type:'ephemeral'}}],
    messages: [{role:'user', content: userPrompt}]
  };
  if (useSearch) body.tools = [{type:'web_search_20250305', name:'web_search', max_results:2}];
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.content?.filter(b => b.type === 'text').map(b => b.text).join('') || null;
}

// Haiku news check system prompt — cached
const HAIKU_NEWS_SYSTEM = `You are a financial news filter. Analyze search results and determine if there is MATERIAL news that would require a full deep dive re-analysis of a stock position.

Material events (answer YES):
- Earnings announcement, guidance change, revenue miss/beat
- New financing: convertible notes, ATM offering, dilution, shelf registration
- SEC investigation, lawsuit, FDA action, regulatory change
- M&A: merger, acquisition, buyout, DEFM14A filing
- Executive departure (CEO/CFO/founder)
- Going concern warning

NOT material (answer NO):
- Analyst price target changes or reiterations  
- Normal price movement without fundamental cause
- Routine press releases, minor product updates
- General market commentary

Respond with ONLY: YES: [one sentence reason] or NO: [one sentence reason]`;

// Haiku scoring system prompt — cached  
const HAIKU_SCORE_SYSTEM = `You are a stock screener. Rate each stock 1-10 for momentum/swing trading opportunity based on technical setup.

Score 8-10: Strong setup — price above key MAs, RSI 40-65, recent volume spike, near 52W high
Score 5-7: Moderate setup — mixed signals, some positive indicators
Score 1-4: Weak setup — downtrend, oversold without catalyst, poor momentum

Respond with ONLY a JSON array: [{"ticker":"AAPL","score":7,"reason":"brief reason"}, ...]`;

// Sonnet deep dive system prompt — cached
const SONNET_DEEP_SYSTEM = `You are a senior portfolio manager conducting a triggered deep dive analysis. Material news was detected for this position. Analyze whether to:
1. HOLD — thesis intact, news is noise
2. ADD — news strengthens the position  
3. REDUCE — partial exit warranted
4. EXIT — thesis broken, exit immediately

Provide: Decision, Confidence (High/Medium/Low), Key Reason, Updated Stop Loss, Updated Target.
Be decisive. No hedging.`;

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', {headers: CORS});

  try {
    const log = [];
    const start = Date.now();

    // 1. Get open positions from Supabase
    const posResp = await sf(
      `${SUPABASE_URL}/rest/v1/study_picks?status=eq.open&select=id,ticker,strategy_id,entry_price,reasoning,sector`,
      {headers: {'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`}}
    );
    const positions = posResp || [];
    log.push(`Open positions: ${positions.length}`);

    // 2. Keyword searches on open positions (4 categories — skip product for daily)
    // Run: earnings, financing, regulatory, M&A
    // Skip: product/market share (weekly only)
    const triggeredPositions = [];
    
    for (const pos of positions) {
      const ticker = pos.ticker;
      const searches = await Promise.all([
        fetch(`https://finnhub.io/api/v1/news?category=company&symbol=${ticker}&token=${FINNHUB}`).then(r => r.ok ? r.json() : []).catch(() => []),
      ]);
      
      const news = searches[0] || [];
      const recentNews = news.slice(0, 5).map(n => n.headline || '').join('. ');
      
      if (!recentNews) continue;

      // Haiku material check — $0.001 per stock
      const haikuResult = await callHaiku(
        HAIKU_NEWS_SYSTEM,
        `Stock: ${ticker}\nRecent news: ${recentNews}\n\nIs this material news requiring re-analysis?`
      );

      if (haikuResult?.startsWith('YES')) {
        triggeredPositions.push({...pos, newsReason: haikuResult, recentNews});
        log.push(`TRIGGERED ${ticker}: ${haikuResult}`);
      }
    }

    // 3. Macro searches — one per sector, shared across all positions
    const macroAlerts = [];
    for (const sector of MACRO_SECTORS) {
      const macroNews = await sf(
        `https://finnhub.io/api/v1/news?category=general&token=${FINNHUB}`
      );
      // Just fetch general news once — Haiku filters it
      break; // One call covers all sectors from general news
    }

    // 4. Sonnet deep dives on triggered positions only
    const diveResults = [];
    for (const pos of triggeredPositions.slice(0, 5)) { // Max 5 per day
      const quote = await sf(`https://finnhub.io/api/v1/quote?symbol=${pos.ticker}&token=${FINNHUB}`);
      const currentPrice = quote?.c || pos.entry_price;
      const pnl = ((currentPrice - pos.entry_price) / pos.entry_price * 100).toFixed(1);

      const analysis = await callSonnet(
        SONNET_DEEP_SYSTEM,
        `Ticker: ${pos.ticker}\nStrategy: ${pos.strategy_id}\nEntry: $${pos.entry_price}\nCurrent: $${currentPrice} (${pnl}% P&L)\nOriginal thesis: ${pos.reasoning}\nMaterial news detected: ${pos.newsReason}\n\nConduct triggered deep dive.`
      );

      if (analysis) {
        diveResults.push({ticker: pos.ticker, analysis: analysis.slice(0, 500)});
        
        // Save to Supabase
        await fetch(`${SUPABASE_URL}/rest/v1/study_notes`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            ticker: pos.ticker,
            pick_id: pos.id,
            note_type: 'triggered_dive',
            content: analysis,
            created_at: new Date().toISOString()
          })
        });
      }
    }

    // 5. Finnhub screen universe top 50 — Haiku scores
    // Get symbols and basic quote data
    const symbolsResp = await sf(`https://finnhub.io/api/v1/stock/symbol?exchange=US&token=${FINNHUB}`);
    const validSymbols = (symbolsResp || [])
      .filter(s => s.type === 'Common Stock' && s.currency === 'USD' &&
        s.symbol && !s.symbol.includes('.') && !s.symbol.includes('/') &&
        s.symbol.length <= 5 && ['XNAS','XNYS','XASE'].includes(s.mic))
      .map(s => s.symbol);

    // Shuffle and take 50 for daily scan
    const shuffled = validSymbols.sort(() => Math.random() - 0.5).slice(0, 50);
    
    // Get quotes for 50 stocks
    const quotes = await Promise.all(
      shuffled.map(sym =>
        sf(`https://finnhub.io/api/v1/quote?symbol=${sym}&token=${FINNHUB}`)
          .then(q => q?.c >= 2 ? {ticker:sym, price:q.c, change:q.dp||0, high52:q.h||0, low52:q.l||0} : null)
      )
    );
    const validQuotes = quotes.filter(Boolean).slice(0, 30);

    // Haiku scores the top candidates — cached prompt, cheap
    let newCandidates = [];
    if (validQuotes.length > 0) {
      const stockList = validQuotes.map(q => 
        `${q.ticker}: $$${q.price.toFixed(2)} (${q.change>0?'+':''}${q.change.toFixed(1)}%)`
      ).join('\n');
      
      const scored = await callHaiku(
        HAIKU_SCORE_SYSTEM,
        `Rate these stocks for momentum/swing opportunity:\n${stockList}`
      );

      if (scored) {
        try {
          const parsed = JSON.parse(scored.replace(/```json|```/g,'').trim());
          newCandidates = parsed.filter(s => s.score >= 7).slice(0, 10);
          log.push(`New candidates scored 7+: ${newCandidates.length}`);
        } catch(e) {
          log.push(`Score parse error: ${e.message}`);
        }
      }
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    log.push(`Completed in ${elapsed}s`);

    return new Response(JSON.stringify({
      success: true,
      summary: {
        openPositions: positions.length,
        triggered: triggeredPositions.length,
        divesConducted: diveResults.length,
        newCandidates: newCandidates.length,
        elapsed: `${elapsed}s`
      },
      triggeredTickers: triggeredPositions.map(p => p.ticker),
      newCandidates,
      log
    }), {headers: CORS});

  } catch(e) {
    return new Response(JSON.stringify({error: e.message}), {status:500, headers: CORS});
  }
}
