export const config = { runtime: 'edge' };

const AV_KEY = process.env.AV_KEY || '9D1A2PAECG3F11MG';
const CORS = {'Access-Control-Allow-Origin':'*','Content-Type':'application/json'};

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('', {headers: CORS});

  try {
    const topics = [
      'economy_macro','geopolitics','finance',
      'mergers_and_acquisitions','earnings','ipo',
      'technology','manufacturing','energy_transportation','retail_wholesale'
    ].join(',');

    const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${topics}&limit=50&sort=LATEST&apikey=${AV_KEY}`;
    
    const resp = await fetch(url);
    if (!resp.ok) {
      return new Response(JSON.stringify({
        error: `Alpha Vantage returned ${resp.status}`,
        url: url.replace(AV_KEY, 'REDACTED')
      }), {headers: CORS});
    }
    
    const data = await resp.json();
    
    // Check for API error messages
    if (data.Note || data.Information) {
      return new Response(JSON.stringify({
        apiMessage: data.Note || data.Information,
        raw: data
      }), {headers: CORS});
    }

    const articles = data.feed || [];

    // Parse and summarize
    const byTopic = {};
    const extreme = [];

    for (const a of articles) {
      const score = parseFloat(a.overall_sentiment_score) || 0;
      const topics = (a.topics || []).filter(t => parseFloat(t.relevance_score) > 0.3);
      
      for (const t of topics) {
        if (!byTopic[t.topic]) byTopic[t.topic] = [];
        byTopic[t.topic].push({
          title: a.title,
          sentiment: a.overall_sentiment_label,
          score: score.toFixed(3),
          summary: a.summary?.slice(0, 200) || '',
          time: a.time_published
        });
      }

      if (Math.abs(score) > 0.35) {
        extreme.push({
          title: a.title,
          score: score.toFixed(3),
          label: a.overall_sentiment_label,
          topics: topics.map(t => t.topic),
          summary: a.summary?.slice(0,300) || ''
        });
      }
    }

    // Top 2 per topic
    const topByTopic = {};
    for (const [topic, items] of Object.entries(byTopic)) {
      topByTopic[topic] = items
        .sort((a,b) => Math.abs(parseFloat(b.score)) - Math.abs(parseFloat(a.score)))
        .slice(0, 2);
    }

    return new Response(JSON.stringify({
      success: true,
      summary: {
        totalArticles: articles.length,
        topicsFound: Object.keys(byTopic),
        articlesByTopic: Object.fromEntries(Object.entries(byTopic).map(([k,v]) => [k, v.length])),
        extremeSentimentCount: extreme.length,
        apiCallsUsed: 1,
        note: 'Free tier: 25 calls/day. This used 1.'
      },
      extremeAlerts: extreme.slice(0, 5),
      topByTopic,
      sampleRawArticle: articles[0] || null
    }, null, 2), {headers: CORS});

  } catch(e) {
    return new Response(JSON.stringify({error: e.message}), {status:500, headers:CORS});
  }
}
