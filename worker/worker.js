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
      if (url.pathname === '/product' && req.method === 'POST') return json(await product(await req.json(), env));
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
  const { imageUrl, title = '', source = '', query = '', extra = '', categories = [], colors = [], seasons = [] } = body || {};
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
${extra ? 'Details from the product page:\n' + String(extra).slice(0, 1200) + '\n' : ''}
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

// ---------- Product link import ----------
const PAGE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};
const decode = t => String(t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x2F;/g, '/').replace(/&nbsp;/g, ' ');
const stripTags = t => decode(String(t || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
const SIZE_RE = /^(size|sizes|taille|größe|talla|us size|uk size|eu size|waist|length|inseam)$/i;
const COLOR_RE = /^(colou?r|colou?rs|shade|wash)$/i;

function slugQuery(u) {
  const parts = u.pathname.split('/').filter(Boolean).filter(p => !/^(products?|p|item|dp|shop|en|us|en-us|[a-z]{2}-[a-z]{2}|\d+|.*\.html?)$/i.test(p) || /[a-z]{3,}-[a-z]{3,}/i.test(p));
  const slug = (parts.sort((a, b) => b.length - a.length)[0] || '').replace(/\.html?$/i, '').replace(/[-_+]+/g, ' ').replace(/\b[a-z]{0,2}\d{5,}\b/gi, '').replace(/\s+/g, ' ').trim();
  return `${u.hostname.replace(/^www\./, '').split('.')[0]} ${slug}`.trim();
}

function metaAll(html, key) {
  const out = [];
  const re = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key.replace(/[.:]/g, '\\$&')}["'][^>]*>`, 'gi');
  for (const tag of html.match(re) || []) { const m = tag.match(/content=["']([^"']*)["']/i); if (m) out.push(decode(m[1]).trim()); }
  // content-before-property order
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name|itemprop)=["']${key.replace(/[.:]/g, '\\$&')}["'][^>]*>`, 'gi');
  let m; while ((m = re2.exec(html))) out.push(decode(m[1]).trim());
  return out.filter(Boolean);
}

function findProducts(node, acc = []) {
  if (!node || typeof node !== 'object') return acc;
  if (Array.isArray(node)) { node.forEach(n => findProducts(n, acc)); return acc; }
  const t = [].concat(node['@type'] || []).join(' ');
  if (/Product/i.test(t)) acc.push(node);
  for (const k of ['@graph', 'mainEntity', 'itemListElement', 'item']) if (node[k]) findProducts(node[k], acc);
  return acc;
}
const imgList = v => [].concat(v || []).map(x => typeof x === 'string' ? x : (x && (x.contentUrl || x.url))).filter(Boolean);
const brandName = b => typeof b === 'string' ? b : (b && b.name) || '';

function mergeOffer(out, offers) {
  for (const o of [].concat(offers || [])) {
    if (!o || typeof o !== 'object') continue;
    const price = parseFloat(o.price ?? o.lowPrice ?? o.priceSpecification?.price);
    if (out.price == null && Number.isFinite(price)) { out.price = price; out.currency = o.priceCurrency || o.priceSpecification?.priceCurrency || out.currency; }
    if (o.size) out.sizes.push(String(o.size));
    if (o.offers) mergeOffer(out, o.offers);
  }
}

function parseHtml(html, base, out) {
  const abs = x => { try { return new URL(decode(x), base).href; } catch { return null; } };
  // JSON-LD
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data; try { data = JSON.parse(m[1].trim().replace(/^<!--|-->$/g, '')); } catch { continue; }
    for (const p of findProducts(data)) {
      out.name ||= stripTags(p.name);
      out.brand ||= stripTags(brandName(p.brand) || brandName(p.manufacturer));
      out.color ||= stripTags(p.color);
      out.description ||= stripTags(p.description).slice(0, 800);
      out.images.push(...imgList(p.image).map(abs));
      mergeOffer(out, p.offers);
      if (p.size) out.sizes.push(...[].concat(p.size).map(String));
      for (const v of [].concat(p.hasVariant || [])) {
        if (v.size) out.sizes.push(String(typeof v.size === 'object' ? v.size.name : v.size));
        out.images.push(...imgList(v.image).map(abs));
        mergeOffer(out, v.offers);
      }
    }
  }
  // OpenGraph / product meta
  out.name ||= stripTags(metaAll(html, 'og:title')[0] || (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]);
  out.brand ||= metaAll(html, 'product:brand')[0] || metaAll(html, 'og:brand')[0] || metaAll(html, 'brand')[0] || '';
  out.color ||= metaAll(html, 'product:color')[0] || '';
  out.description ||= (metaAll(html, 'og:description')[0] || metaAll(html, 'description')[0] || '').slice(0, 800);
  if (out.price == null) {
    const pr = parseFloat((metaAll(html, 'product:price:amount')[0] || metaAll(html, 'og:price:amount')[0] || metaAll(html, 'price')[0] || '').replace(/[^0-9.]/g, ''));
    if (Number.isFinite(pr)) { out.price = pr; out.currency ||= metaAll(html, 'product:price:currency')[0] || metaAll(html, 'og:price:currency')[0] || metaAll(html, 'priceCurrency')[0] || ''; }
  }
  out.images.push(...metaAll(html, 'og:image').concat(metaAll(html, 'og:image:secure_url'), metaAll(html, 'twitter:image')).map(abs));
}

async function shopify(u, out) {
  const m = u.pathname.match(/^(.*?\/products\/[^/?#.]+)/);
  if (!m) return;
  const r = await fetch(u.origin + m[1] + '.js', { headers: { ...PAGE_HEADERS, Accept: 'application/json' } });
  if (!r.ok || !(r.headers.get('Content-Type') || '').includes('json')) return;
  const p = await r.json();
  out.name ||= stripTags(p.title);
  out.brand ||= stripTags(p.vendor);
  out.description ||= stripTags(p.description).slice(0, 800);
  const opts = (p.options || []).map((o, i) => ({ name: typeof o === 'string' ? o : o.name, values: o.values || [], i }));
  const sizeOpt = opts.find(o => SIZE_RE.test(o.name)), colorOpt = opts.find(o => COLOR_RE.test(o.name));
  const variants = p.variants || [];
  const chosen = variants.find(v => String(v.id) === u.searchParams.get('variant')) || variants[0];
  if (out.price == null && (chosen?.price ?? p.price) != null) { out.price = (chosen?.price ?? p.price) / 100; out.currency ||= ''; }
  if (sizeOpt) {
    // sizes for the selected colour only, when the product has colours
    const pool = colorOpt && chosen ? variants.filter(v => v[`option${colorOpt.i + 1}`] === chosen[`option${colorOpt.i + 1}`]) : variants;
    out.sizes.push(...(pool.length ? pool.map(v => v[`option${sizeOpt.i + 1}`]) : sizeOpt.values));
  }
  if (colorOpt && chosen) out.color ||= chosen[`option${colorOpt.i + 1}`] || '';
  const img = x => (x && (x.startsWith('//') ? 'https:' + x : x));
  if (chosen?.featured_image?.src) out.images.push(img(chosen.featured_image.src));
  out.images.push(...(p.images || []).map(img));
}

async function product(body, env) {
  const { url: target, categories = [], colors = [], seasons = [] } = body || {};
  let u; try { u = new URL(String(target || '').trim()); } catch { throw fail('That doesn’t look like a link'); }
  if (!/^https?:$/.test(u.protocol)) throw fail('That doesn’t look like a link');
  const out = { url: u.href, source: u.hostname.replace(/^www\./, ''), name: '', brand: '', price: null, currency: '', color: '', description: '', images: [], sizes: [], blocked: false, imagesFromSearch: false };

  try { await shopify(u, out); } catch { /* not Shopify */ }
  if (!out.images.length || out.price == null || !out.name) {
    try {
      const r = await fetch(u.href, { headers: PAGE_HEADERS, redirect: 'follow' });
      if (r.ok) parseHtml((await r.text()).slice(0, 3_000_000), r.url || u.href, out);
      else out.blocked = true;
    } catch { out.blocked = true; }
  }
  out.images = [...new Set(out.images.filter(x => x && /^https?:/.test(x)))].slice(0, 12);
  out.sizes = [...new Set(out.sizes.map(x => stripTags(x)).filter(x => x && x.length <= 20 && !/default title/i.test(x)))].slice(0, 30);
  if (out.price != null) out.price = Math.round(out.price * 100) / 100;

  // Store blocked us or showed no photos: find photos by search instead
  let thumbs = out.images;
  if (!out.images.length && env.BRAVE_KEY) {
    try {
      const q = out.name ? `${out.brand} ${out.name}`.trim() : slugQuery(u);
      const s = await search(q, env, 12);
      out.images = s.results.map(x => x.image); thumbs = s.results.map(x => x.thumb); out.imagesFromSearch = true;
    } catch { /* ignore */ }
  }
  out.thumbs = thumbs;

  if (env.ANTHROPIC_KEY) {
    try {
      out.ai = await describe({
        imageUrl: thumbs[0] || out.images[0], title: out.name || slugQuery(u), source: out.source, query: u.href,
        extra: [out.brand && `Brand: ${out.brand}`, out.color && `Colour: ${out.color}`, out.description && `Description: ${out.description}`].filter(Boolean).join('\n'),
        categories, colors, seasons,
      }, env);
    } catch (e) { out.aiError = e.message; }
  }
  return out;
}
