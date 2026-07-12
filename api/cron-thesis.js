// api/cron-thesis.js — runs daily at 4pm ET via Vercel cron
// Checks thesis integrity for all long-term compounder picks
module.exports = async function handler(req, res) {
  const FINNHUB = process.env.FINNHUB_KEY;
  const ANT_KEY = process.env.ANT_KEY;
  const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';

  try {
    // Get all open compounder picks (long-term holds need thesis monitoring)
    const picksResp = await fetch(
      `${SUPABASE_URL}/rest/v1/study_picks?status=eq.open&strategy_id=eq.compounder&select=id,ticker,entry_price,reasoning,date`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    const picks = await picksResp.json();
    if (!picks?.length) return res.status(200).json({ message: 'No open compounder picks to check' });

    const warnings = [];

    for (const pick of picks) {
      // Get recent news
      const weekAgo = new Date(Date.now() - 7*86400000).toISOString().split('T')[0];
      const today = new Date().toISOString().split('T')[0];
      const newsResp = await fetch(`https://finnhub.io/api/v1/company-news?symbol=${pick.ticker}&from=${weekAgo}&to=${today}&token=${FINNHUB}`);
      const news = await newsResp.json();
      const headlines = Array.isArray(news) ? news.slice(0, 5).map(n => n.headline).join(' | ') : 'No recent news';

      // Get current price
      const quoteResp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${pick.ticker}&token=${FINNHUB}`);
      const quote = await quoteResp.json();
      const currentPrice = quote?.c || 0;
      const returnPct = pick.entry_price > 0 ? ((currentPrice - pick.entry_price) / pick.entry_price * 100).toFixed(1) : 0;

      // Ask Sonnet if thesis is intact
      if (ANT_KEY) {
        const check = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': ANT_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 200,
            messages: [{
              role: 'user',
              content: `Thesis check for ${pick.ticker}. Original thesis: ${pick.reasoning?.substring(0, 200)}. Current return: ${returnPct}%. Recent news: ${headlines}. Is the original thesis INTACT or BROKEN? Reply JSON only: {"status":"INTACT"|"WARNING"|"BROKEN","reason":"one sentence"}`
            }]
          })
        });
        const checkData = await check.json();
        const text = checkData?.content?.[0]?.text || '';
        try {
          const result = JSON.parse(text.substring(text.indexOf('{'), text.lastIndexOf('}') + 1));
          if (result.status !== 'INTACT') {
            warnings.push({ ticker: pick.ticker, status: result.status, reason: result.reason, returnPct });
            
            // Save warning to Supabase
            await fetch(`${SUPABASE_URL}/rest/v1/study_picks?id=eq.${pick.id}`, {
              method: 'PATCH',
              headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ key_risk: `⚠️ THESIS ${result.status}: ${result.reason}` })
            });
          }
        } catch(e) {}
      }
    }

    res.status(200).json({ checked: picks.length, warnings });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
};
