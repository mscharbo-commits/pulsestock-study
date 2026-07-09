export const config = { runtime: 'edge' };

export default async function handler(req) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });

  const url = new URL(req.url);
  const endpoint = url.searchParams.get('endpoint');
  if (!endpoint) return new Response(JSON.stringify({ error: 'No endpoint' }), { status: 400, headers: cors });

  const FHK = process.env.FINNHUB_KEY || 'd95c889r01qihq3l33k0d95c889r01qihq3l33kg';
  const fhUrl = `https://finnhub.io/api/v1/${endpoint}&token=${FHK}`;

  try {
    const r = await fetch(fhUrl);
    const data = await r.json();
    return new Response(JSON.stringify(data), {
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' }
    });
  } catch(e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: cors });
  }
}
