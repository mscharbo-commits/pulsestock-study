export const config = { runtime: 'edge' };
const AV_KEY = process.env.AV_KEY || '9D1A2PAECG3F11MG';
const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', {headers: CORS});

  try {
    // Test 1: Simple single topic, small limit
    const url1 = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=economy_macro&limit=5&sort=LATEST&apikey=${AV_KEY}`;

    // Test 2: No topic filter — just latest news
    const url2 = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&limit=5&sort=LATEST&apikey=${AV_KEY}`;

    // Test 3: Ticker-based (known to work on some tiers)
    const url3 = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=AAPL&limit=5&apikey=${AV_KEY}`;

    const [r1, r2, r3] = await Promise.all([
      fetch(url1).then(r => r.json()).catch(e => ({fetchError: e.message})),
      fetch(url2).then(r => r.json()).catch(e => ({fetchError: e.message})),
      fetch(url3).then(r => r.json()).catch(e => ({fetchError: e.message})),
    ]);

    return new Response(JSON.stringify({
      test1_topics_economy_macro: {
        keys: Object.keys(r1),
        note: r1.Note || r1.Information || r1['Error Message'] || null,
        feedLength: r1.feed?.length ?? 'no feed key',
        raw: JSON.stringify(r1).slice(0, 500)
      },
      test2_no_filter: {
        keys: Object.keys(r2),
        note: r2.Note || r2.Information || r2['Error Message'] || null,
        feedLength: r2.feed?.length ?? 'no feed key',
        raw: JSON.stringify(r2).slice(0, 500)
      },
      test3_ticker_AAPL: {
        keys: Object.keys(r3),
        note: r3.Note || r3.Information || r3['Error Message'] || null,
        feedLength: r3.feed?.length ?? 'no feed key',
        raw: JSON.stringify(r3).slice(0, 500)
      }
    }, null, 2), {headers: CORS});

  } catch(e) {
    return new Response(JSON.stringify({error: e.message}), {status:500, headers:CORS});
  }
}
