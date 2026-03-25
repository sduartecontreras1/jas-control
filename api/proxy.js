export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.status(200).end();

  const { endpoint, ...params } = req.query;
  if (!endpoint) return res.status(400).json({ error: "Missing endpoint" });

  const qs = new URLSearchParams(params).toString();
  const url = qs ? `https://api.siigo.com/${endpoint}?${qs}` : `https://api.siigo.com/${endpoint}`;

  const headers = {
    "Content-Type": "application/json",
    "Partner-Id": "JASAsesores"
  };
  if (req.headers.authorization) headers["Authorization"] = req.headers.authorization;

  let bodyToSend = undefined;
  if (req.method === "POST") {
    bodyToSend = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  }

  try {
    const r = await fetch(url, {
      method: req.method, headers,
      ...(bodyToSend ? { body: bodyToSend } : {}),
    });
    const responseText = await r.text();
    let data;
    try { data = JSON.parse(responseText); }
    catch { data = { raw: responseText }; }
    return res.status(r.status).json(data);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
