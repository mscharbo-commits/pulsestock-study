// Auto stop/target monitor — runs on Vercel cron schedule
// Checks all open positions across all three strategies, closes any that hit stop/target

const SUPABASE_URL = 'https://ttcprqkoibiztibhpsrp.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InR0Y3BycWtvaWJpenRpYmhwc3JwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAzNTk5NjcsImV4cCI6MjA5NTkzNTk2N30.kO-a0NYLQ0rrAV1V7Aj4O8Mwm7KFq2NPfIQl2uY5sDY';
const FHK = 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';

async function sbFetch(method, table, data, params) {
  const url = SUPABASE_URL + '/rest/v1/' + table + (params || '');
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: 'Bearer ' + SUPABASE_KEY,
    'Content-Type': 'application/json',
    Prefer: 'return=representation'
  };
  const opts = { method, headers };
  if (data) opts.body = JSON.stringify(data);
  const r = await fetch(url, opts);
  const body = await r.text();
  return body ? JSON.parse(body) : [];
}

async function getQuote(ticker) {
  try {
    const r = await fetch('https://finnhub.io/api/v1/quote?symbol=' + ticker + '&token=' + FHK);
    if (!r.ok) return null;
    const d = await r.json();
    if (!d || !d.c) return null;
    return {
      current: d.c > 0 ? d.c : d.pc,  // live price (real-time during market hours)
      open:    d.o || d.c,              // today's open price
      high:    d.h || d.c,              // today's high
      low:     d.l || d.c,              // today's low
      prev:    d.pc                     // previous close
    };
  } catch (e) { return null; }
}

function isMarketHours() {
  const now = new Date();
  const et = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short'
  }).formatToParts(now);
  const day  = et.find(p => p.type === 'weekday')?.value;
  const hour = parseInt(et.find(p => p.type === 'hour')?.value);
  const min  = parseInt(et.find(p => p.type === 'minute')?.value);
  if (['Sat','Sun'].includes(day)) return false;
  return (hour > 9 || (hour === 9 && min >= 30)) && hour < 16;
}

export default async function handler(req, res) {
  // Verify this is being called by Vercel cron (or allow manual trigger with secret)
  const authHeader = req.headers.authorization;
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    // Allow manual testing without secret for now
  }

  // Only run during market hours
  if (!isMarketHours()) {
    return res.status(200).json({ skipped: 'outside market hours' });
  }
  const results = { checked: 0, closed: [], errors: [] };

  try {
    // Get all open positions across all strategies
    const openPicks = await sbFetch('GET', 'study_picks', null, '?status=eq.open&select=*');

    for (const pick of openPicks) {
      results.checked++;
      const quote = await getQuote(pick.ticker);
      if (!quote) continue;

      const stop   = parseFloat(pick.stop_loss)   || 0;
      const target = parseFloat(pick.target_price) || 0;

      let exitReason = null;
      let exitPrice  = null;

      // Stop loss: triggered if today's LOW crosses below stop
      // Exit price = today's OPEN if it gapped below stop (worst case fill)
      //            = stop price if it crossed intraday (best case fill at stop)
      if (stop && quote.low <= stop) {
        exitReason = 'stop_hit';
        // If opened below stop — fill at open (gap down, no chance to exit at stop)
        // If opened above stop — fill at stop (crossed intraday, could exit at stop)
        exitPrice = quote.open <= stop ? quote.open : stop;
      }
      // Target: triggered if today's HIGH crosses above target
      // Exit price = today's OPEN if it gapped above target
      //            = target price if it crossed intraday
      else if (target && quote.high >= target) {
        exitReason = 'target_hit';
        exitPrice = quote.open >= target ? quote.open : target;
      }

      if (exitReason) {
        const entry = parseFloat(pick.entry_price) || 0;
        const returnPct = entry ? ((exitPrice - entry) / entry * 100) : 0;

        // Close the position
        await sbFetch('PATCH', 'study_picks', {
          status: 'closed',
          exit_price: exitPrice,
          return_pct: parseFloat(returnPct.toFixed(2)),
          exit_reason: exitReason,
          exit_date: new Date().toISOString()
        }, '?id=eq.' + pick.id);

        // Log to closed_trades for Critic
        await sbFetch('POST', 'closed_trades', {
          strategy_id: pick.strategy_id,
          ticker: pick.ticker,
          entry_price: entry,
          exit_price: exitPrice,
          return_pct: parseFloat(returnPct.toFixed(2)),
          exit_reason: exitReason,
          portfolio: pick.strategy_id,
          sector: pick.sector || '',
          gen_number: pick.gen_number
        });

        results.closed.push({
          ticker: pick.ticker,
          strategy: pick.strategy_id,
          exit_price: exitPrice,
          return_pct: returnPct.toFixed(2),
          reason: exitReason
        });
      }
    }
  } catch (e) {
    results.errors.push(e.message);
  }

  return res.status(200).json(results);
}
