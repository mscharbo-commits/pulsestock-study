const fs = require('fs');
let html = fs.readFileSync('index.html', 'utf8');
html = html
  .replace(/__GH_TOKEN__/g, process.env.GH_TOKEN || '')
  .replace(/__ANT_KEY__/g, process.env.ANT_KEY || '')
  .replace(/__FINNHUB_KEY__/g, process.env.FINNHUB_KEY || '');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', html);
console.log('Build complete. Env vars injected.');
