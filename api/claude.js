module.exports = async function handler(req, res) {
  // TEMPORARILY DISABLED — API key being rotated
  return res.status(403).json({ error: 'Service temporarily unavailable' });
};
