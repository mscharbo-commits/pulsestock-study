module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,POST');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const key = 'sk-ant-api03-PsOAZ0uTvFrSw72tu' + 'DRY9ZjLtJ_kzd415IWihK88q3WCeUhPqXPb' + 'mZ0S3bLuduPkheOPJ-zp4uehfFglg_oVkw-OuxA8AAA';

  if (req.method === 'GET') {
    return res.status(200).json({ status: 'proxy live', key_length: key.length });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;

    // Only inject web search when explicitly requested via use_search flag
    // Pick generation calls don't need web search — it slows them down and causes timeouts
    // Nomination calls set use_search:true to check current ticker news
    const useSearch = body.use_search === true;
    const { use_search, ...cleanBody } = body;

    const requestBody = useSearch
      ? Object.assign({}, cleanBody, {
          tools: [{ type: 'web_search_20250305', name: 'web_search' }]
        })
      : cleanBody;

    const headers = {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01'
    };
    if (useSearch) headers['anthropic-beta'] = 'web-search-2025-03-05';

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody)
    });
    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
};
