// ============================================================
// EconoSchool Pro — Serverless Function Vercel
// Proxy pour l'API SMS Orange CI (évite le blocage CORS)
// Accessible sur : /api/sms-proxy
// ============================================================

module.exports = async (req, res) => {
  // CORS de base (au cas où)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Méthode non autorisée' });
    return;
  }

  try {
    const { url: targetUrl, method, headers, body } = req.body;

    if (!targetUrl || !targetUrl.startsWith('https://api.orange.com')) {
      res.status(403).json({ error: 'URL non autorisée' });
      return;
    }

    const orangeRes = await fetch(targetUrl, {
      method: method || 'POST',
      headers: headers || {},
      body: body || undefined
    });

    const contentType = orangeRes.headers.get('content-type') || '';
    const data = contentType.includes('application/json')
      ? await orangeRes.json()
      : await orangeRes.text();

    res.status(orangeRes.status).json(
      typeof data === 'string' ? { raw: data } : data
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
