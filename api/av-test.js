export const config = { runtime: 'edge' };
const AV_KEY = process.env.AV_KEY || '9D1A2PAECG3F11MG';
const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', {headers: CORS});

  try {
    const results = {};

    // Test 1: Topics filter — sequential with 1.5s gap
    const url1 = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=economy_macro,geopolitics,earnings&limit=10&sort=LATEST&apikey=${AV_KEY}`;
    const r1 = await fetch(url1).then(r => r.json()).catch(e => ({fetchError: e.message}));
    results.test1_topics = {
      note: r1.Note || r1.Information || r1['Error Message'] || null,
      feedLength: r1.feed?.length ?? 'no feed key',
      topicsAvailable: !!r1.feed,
      sample: r1.feed?.slice(0,2).map(a => ({
        title: a.title,
        sentiment: a.overall_sentiment_label,
        score: a.overall_sentiment_score,
        topics: a.topics?.slice(0,3),
        summary: a.summary?.slice(0,200)
      })) || []
    };

    // Wait 1.5s between calls
    await new Promise(r => setTimeout(r, 1500));

    // Test 2: Ticker-based — confirmed working
    const url2 = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=AAPL,MSFT,NVDA,TSLA&limit=5&apikey=${AV_KEY}`;
    const r2 = await fetch(url2).then(r => r.json()).catch(e => ({fetchError: e.message}));
    results.test2_multi_ticker = {
      note: r2.Note || r2.Information || null,
      feedLength: r2.feed?.length ?? 'no feed key',
      sample: r2.feed?.slice(0,2).map(a => ({
        title: a.title,
        sentiment: a.overall_sentiment_label,
        score: a.overall_sentiment_score,
        tickers: a.ticker_sentiment?.map(t => `${t.ticker}:${t.ticker_sentiment_label}`),
        summary: a.summary?.slice(0,200)
      })) || []
    };

    return new Response(JSON.stringify({
      success: true,
      callsUsed: 2,
      freeCallsRemaining: '~23 of 25 today',
      results
    }, null, 2), {headers: CORS});

  } catch(e) {
    return new Response(JSON.stringify({error: e.message}), {status:500, headers:CORS});
  }
}
