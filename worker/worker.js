// Closet search server — a Cloudflare Worker.
// Keeps your API keys off your phone and out of GitHub.
//
// Secrets to set in Cloudflare (Settings → Variables and Secrets):
//   BRAVE_KEY       Brave Search API key
//   ANTHROPIC_KEY   Anthropic API key (for AI autofill)
//   APP_TOKEN       any passcode you make up; you type the same one into the app
// Optional plain variable:
//   ALLOWED_ORIGIN  defaults to https://clmeranus.github.io

const MODEL = 'claude-haiku-5-5';
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const CLAUDE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

export default {
  async fetch(req, env) {
    const origin = env.ALLOWED_ORIGIN || 'https://clmeranus.github.io';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-App-Token',
      'Access-Control-Max-Age': '86400',
      'Vary': 'Origin',
    };
    const json = (data, status = 200) =>
      new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (!env.APP_TOKEN || req.headers.get('X-App-Token') !== env.APP_TOKEN) return json({ error: 'Wrong access code' }, 401);

    const url = new URL(req.url);
    try {
      if (url.pathname === '/ping') return json({ ok: true, search: !!env.BRAVE_KEY, ai: !!env.ANTHROPIC_KEY });
      if (url.pathname === '/search') return json(await search(url.searchParams.get('q'), env));
      if (url.pathname === '/image') return await proxyImage(url.searchParams.get('url'), cors);
      if (url.pathname === '/describe' && req.method === 'POST') return json(await describe(await req.json(), env));
      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e.message || 'Server error' }, e.status || 500);
    }
  },
};

function fail(msg, status = 400) { const e = new Error(msg); e.status = status; return e; }

async function search(q, env) {
  q = (q || '').trim().slice(0, 200);
  if (!q) throw fail('Missing search');
  if (!env.BRAVE_KEY) throw fail('Search key not set on server', 500);
  const api = new URL('https://api.search.brave.com/res/v1/images/search');
  api.searchParams.set('q', q);
  api.searchParams.set('count', '40');
  api.searchParams.set('safesearch', 'strict');
  const r = await fetch(api, { headers: { 'X-Subscription-Token': env.BRAVE_KEY, Accept: 'application/json' } });
  if (!r.ok) throw fail(`Brave search error (${r.status})`, 502);
  const data = await r.json();
  const results = (data.results || [])
    .map(x => ({
      thumb: x.thumbnail?.src || x.properties?.placeholder,
      image: x.properties?.url || x.thumbnail?.src,
      title: x.title || '',
      source: x.source || x.meta_url?.hostname || '',
      page: x.url || '',
      width: x.properties?.width, height: x.properties?.height,
    }))
    .filter(x => x.thumb && x.image);
  return { results };
}

async function fetchImage(target) {
  let u;
  try { u = new URL(target); } catch { throw fail('Bad image URL'); }
  if (!/^https?:$/.test(u.protocol)) throw fail('Bad image URL');
  const r = await fetch(u, {
    headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', Accept: 'image/*' },
    redirect: 'follow',
  });
  if (!r.ok) throw fail(`Image site refused (${r.status})`, 502);
  const type = (r.headers.get('Content-Type') || '').split(';')[0].trim();
  if (!type.startsWith('image/')) throw fail('That link is not an image', 502);
  const buf = await r.arrayBuffer();
  if (buf.byteLength > MAX_IMAGE_BYTES) throw fail('Image too large', 413);
  return { buf, type };
}

async function proxyImage(target, cors) {
  const { buf, type } = await fetchImage(target);
  return new Response(buf, { headers: { ...cors, 'Content-Type': type, 'Cache-Control': 'public, max-age=86400' } });
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf); let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

async function describe(body, env) {
  if (!env.ANTHROPIC_KEY) throw fail('AI key not set on server', 500);
  const { imageUrl, title = '', source = '', query = '', categories = [], colors = [], seasons = [] } = body || {};
  const content = [];
  if (imageUrl) {
    try {
      const { buf, type } = await fetchImage(imageUrl);
      if (CLAUDE_TYPES.includes(type) && buf.byteLength < 4.5 * 1024 * 1024)
        content.push({ type: 'image', source: { type: 'base64', media_type: type, data: toBase64(buf) } });
    } catch { /* fall back to text only */ }
  }
  content.push({ type: 'text', text:
`You are filling in a wardrobe catalogue entry for one garment.
${content.length ? 'The image shows the garment.' : 'No image is available; use the text only.'}
Search the user typed: ${JSON.stringify(String(query).slice(0, 200))}
Product page title: ${JSON.stringify(String(title).slice(0, 300))}
Website: ${JSON.stringify(String(source).slice(0, 100))}

Return ONLY a JSON object, no other text, with these keys:
"name": short descriptive garment name in sentence case, without the brand (e.g. "Cream cable-knit sweater"), max 6 words.
"brand": the brand if the title, website or search makes it clear, otherwise "". A retailer that sells many brands is not the brand unless it is clearly its own label.
"category": exactly one of ${JSON.stringify(categories)}.
"colors": 1 to 3 values from ${JSON.stringify(colors)} that best match the garment.
"seasons": 1 to 4 values from ${JSON.stringify(seasons)} the garment suits.
"tags": 0 to 4 short lowercase style or material tags (e.g. "wool", "cropped", "workwear").` });

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 400, messages: [{ role: 'user', content }] }),
  });
  if (!r.ok) throw fail(`AI error (${r.status})`, 502);
  const data = await r.json();
  const text = (data.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw fail('AI gave no details', 502);
  return JSON.parse(m[0]);
}
