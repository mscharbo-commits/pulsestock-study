// api/cron-postmortem.js  
// Post-mortem learning loop
// Triggered when positions close — Haiku per trade, Sonnet Critic every 10

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const FINNHUB = process.env.FINNHUB_KEY || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

async function sf(url, opts={}) {
  try {
    const r = await fetch(url, opts);
    return r.ok ? await r.json() : null;
  } catch(e) { return null; }
}

const HAIKU_POSTMORTEM_SYSTEM = `You are a trading coach. Analyze this closed trade and extract structured lessons.
Respond ONLY with valid JSON: {"entry_correct":true/false,"exit_optimal":true/false,"main_error":"string or null","key_lesson":"one sentence","signals_worked":["list"],"signals_failed":["list"]}`;

const SONNET_CRITIC_SYSTEM = `You are a portfolio manager and strategy critic. You have reviewed 10+ closed trades from this strategy. 

Analyze the patterns across all trades and provide:
1. MISTAKE CLUSTERS — recurring errors (entry timing, position sizing, sector bias, etc.)
2. WHAT WORKS — signals that consistently predicted winning trades
3. RULE CHANGES — specific rule modifications for the next generation (be precise)
4. CONFIDENCE — overall strategy confidence score 1-10 with explanation

Be harsh. The goal is to improve the strategy, not to protect feelings. Specific is better than general.`;

async function callHaiku(system, user) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31'},
    body: JSON.stringify({
      model:'claude-haiku-4-5-20251001', max_tokens:400,
      system:[{type:'text',text:system,cache_control:{type:'ephemeral'}}],
      messages:[{role:'user',content:user}]
    })
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.content?.[0]?.text || null;
}

async function callSonnet(system, user) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method:'POST',
    headers:{'Content-Type':'application/json','x-api-key':ANTHROPIC_KEY,'anthropic-version':'2023-06-01','anthropic-beta':'prompt-caching-2024-07-31'},
    body: JSON.stringify({
      model:'claude-sonnet-4-6', max_tokens:2000,
      system:[{type:'text',text:system,cache_control:{type:'ephemeral'}}],
      messages:[{role:'user',content:user}]
    })
  });
  if (!resp.ok) return null;
  const d = await resp.json();
  return d.content?.[0]?.text || null;
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', {headers: CORS});

  try {
    // Get recently closed positions without post-mortem
    const closedResp = await sf(
      `${SUPABASE_URL}/rest/v1/study_picks?status=eq.closed&postmortem_done=eq.false&select=*&limit=20`,
      {headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`}}
    );
    const closed = closedResp || [];

    const postmortems = [];

    for (const trade of closed) {
      const returnPct = trade.exit_price && trade.entry_price
        ? ((trade.exit_price - trade.entry_price) / trade.entry_price * 100).toFixed(2)
        : 0;

      const pm = await callHaiku(
        HAIKU_POSTMORTEM_SYSTEM,
        `Ticker: ${trade.ticker}
Strategy: ${trade.strategy_id}
Entry: $${trade.entry_price} on ${trade.entry_date}
Exit: $${trade.exit_price} on ${trade.exit_date}  
Return: ${returnPct}%
Exit reason: ${trade.exit_reason || 'unknown'}
Original thesis: ${trade.reasoning || 'none'}
Result: ${parseFloat(returnPct) > 0 ? 'WIN' : 'LOSS'}`
      );

      if (pm) {
        try {
          const parsed = JSON.parse(pm.replace(/```json|```/g,'').trim());
          postmortems.push({ticker: trade.ticker, returnPct, ...parsed});

          // Save post-mortem to Supabase
          await fetch(`${SUPABASE_URL}/rest/v1/study_picks?id=eq.${trade.id}`, {
            method: 'PATCH',
            headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
            body: JSON.stringify({
              postmortem_done: true,
              postmortem: JSON.stringify(parsed),
              return_pct: parseFloat(returnPct)
            })
          });
        } catch(e) {}
      }
    }

    // Run Critic if we have 10+ closed trades without critic review
    let criticResult = null;
    const allClosed = await sf(
      `${SUPABASE_URL}/rest/v1/study_picks?status=eq.closed&postmortem_done=eq.true&select=ticker,strategy_id,return_pct,postmortem,entry_date,exit_date&limit=50`,
      {headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`}}
    );

    if ((allClosed?.length || 0) >= 10) {
      const tradesSummary = (allClosed || []).map(t => {
        const pm = t.postmortem ? JSON.parse(t.postmortem) : {};
        return `${t.ticker} (${t.strategy_id}): ${t.return_pct > 0 ? '+' : ''}${t.return_pct?.toFixed(1)}% | Entry correct: ${pm.entry_correct} | Lesson: ${pm.key_lesson || 'N/A'}`;
      }).join('\n');

      const winRate = allClosed.filter(t => t.return_pct > 0).length / allClosed.length;
      const avgReturn = allClosed.reduce((s,t) => s + (t.return_pct||0), 0) / allClosed.length;

      criticResult = await callSonnet(
        SONNET_CRITIC_SYSTEM,
        `${allClosed.length} closed trades to analyze:
Win rate: ${(winRate*100).toFixed(1)}%
Avg return: ${avgReturn.toFixed(2)}%

Trade breakdown:
${tradesSummary}

Conduct full strategy critique.`
      );

      if (criticResult) {
        await fetch(`${SUPABASE_URL}/rest/v1/study_critiques`, {
          method: 'POST',
          headers:{'apikey':SUPABASE_KEY,'Authorization':`Bearer ${SUPABASE_KEY}`,'Content-Type':'application/json'},
          body: JSON.stringify({
            trade_count: allClosed.length,
            win_rate: winRate,
            avg_return: avgReturn,
            critique: criticResult,
            created_at: new Date().toISOString()
          })
        }).catch(() => null);
      }
    }

    return new Response(JSON.stringify({
      success: true,
      postmortemsCompleted: postmortems.length,
      criticRun: !!criticResult,
      postmortems: postmortems.slice(0, 5),
      criticPreview: criticResult?.slice(0, 300)
    }), {headers: CORS});

  } catch(e) {
    return new Response(JSON.stringify({error: e.message}), {status:500, headers:CORS});
  }
}
