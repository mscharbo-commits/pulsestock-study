// api/cron-scan.js — runs daily at 8am ET via Vercel cron
// Scans full universe and saves ranked candidates to Supabase
module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.headers['x-vercel-cron'] !== '1') {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const FINNHUB = process.env.FINNHUB_KEY;
  const POLYGON = process.env.POLYGON_API_KEY;
  const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
  const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
  const TICKER_URL = 'https://raw.githubusercontent.com/mscharbo-commits/pulsestock-study-data/main/ticker_universe.json';

  // Call the scan endpoint in batches
  const baseUrl = `https://${req.headers.host}`;
  const today = new Date().toISOString().split('T')[0];
  const future14 = new Date(Date.now() + 14*86400000).toISOString().split('T')[0];

  try {
    // Get universe
    const uniResp = await fetch(TICKER_URL);
    const uni = await uniResp.json();
    const tickers = uni?.all || [];

    // Get earnings calendar for catalyst
    let earningsTickers = '';
    if (FINNHUB) {
      const calResp = await fetch(`https://finnhub.io/api/v1/calendar/earnings?from=${today}&to=${future14}&token=${FINNHUB}`);
      const cal = await calResp.json();
      earningsTickers = (cal?.earningsCalendar || []).map(e => e.symbol).filter(Boolean).join(',');
    }

    // Process in batches of 15
    const BATCH = 15;
    const results = { momentum: [], compounder: [], catalyst: [] };

    for (let i = 0; i < tickers.length; i += BATCH) {
      const batch = tickers.slice(i, i + BATCH).join(',');
      let url = `${baseUrl}/api/scan?batch=${batch}&date=${today}`;
      if (earningsTickers) url += `&earningsTickers=${encodeURIComponent(earningsTickers.substring(0, 2000))}`;
      
      try {
        const r = await fetch(url);
        const data = await r.json();
        ['momentum', 'compounder', 'catalyst'].forEach(s => {
          if (data[s]) results[s] = results[s].concat(data[s]);
        });
      } catch(e) {}

      // Small delay between batches
      await new Promise(r => setTimeout(r, 100));
    }

    // Save top 100 per strategy
    const saved = {};
    for (const strat of ['momentum', 'compounder', 'catalyst']) {
      const scored = results[strat].sort((a, b) => b.score - a.score).slice(0, 100);
      saved[strat] = scored.length;

      // Delete old
      await fetch(`${SUPABASE_URL}/rest/v1/pre_screened_candidates?strategy_id=eq.${strat}&trading_date=eq.${today}`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });

      // Insert new
      for (let i = 0; i < scored.length; i++) {
        const c = scored[i];
        const tier = c.score >= 90 ? 'STRONG_BUY' : c.score >= 85 ? 'BUY' : 'WATCH';
        await fetch(`${SUPABASE_URL}/rest/v1/pre_screened_candidates`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json', 'Prefer': 'return=minimal'
          },
          body: JSON.stringify({
            strategy_id: strat, ticker: c.ticker, rank: i + 1,
            screen_score: c.score,
            screen_reason: `${tier} RSI:${c.rsi} Range:${c.rangePos}% R6m:${c.r6m}%`,
            price: c.price, rsi: c.rsi, range_position: c.rangePos, trading_date: today
          })
        });
      }
    }

    console.log('[Cron Scan] Complete:', saved);
    res.status(200).json({ success: true, date: today, saved });
  } catch(e) {
    console.error('[Cron Scan] Error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
