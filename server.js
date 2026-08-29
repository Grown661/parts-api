'use strict';

/**
 * parts-api — REST-API fuer einen FPV-Teile-Katalog.
 * Dependency-frei: nur Node-Builtins. Persistenz: JSON-Datei unter data/.
 */

const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');

const PORT = Number(process.env.PORT) || 8215;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'parts.json');

// ---------------------------------------------------------------------------
// Datenhaltung (JSON-Store)
// ---------------------------------------------------------------------------

const SEED_PARTS = [
  { name: 'iFlight XING2 2207 1855KV', category: 'motor', price: 21.9, weight_g: 34.5, in_stock: true },
  { name: 'T-Motor F7 Pro Flight Controller', category: 'fc', price: 89.0, weight_g: 9.6, in_stock: true },
  { name: 'Foxeer Razer Micro 1200TVL', category: 'camera', price: 19.5, weight_g: 5.5, in_stock: true },
  { name: 'Rush Tank II Ultimate VTX', category: 'vtx', price: 32.0, weight_g: 9.0, in_stock: false },
  { name: 'HQProp 5x4.3x3 V1S (Set)', category: 'prop', price: 3.2, weight_g: 16.0, in_stock: true },
  { name: 'TBS Crossfire Nano RX', category: 'rx', price: 29.9, weight_g: 0.5, in_stock: true },
  { name: 'GNB 6S 1300mAh 120C LiPo', category: 'battery', price: 27.5, weight_g: 205.0, in_stock: true },
  { name: 'ImpulseRC Apex 5" Frame', category: 'frame', price: 74.9, weight_g: 128.0, in_stock: false },
];

let parts = [];
let writeQueue = Promise.resolve();

function newId() {
  return crypto.randomBytes(6).toString('hex');
}

async function loadStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    parts = JSON.parse(raw);
    if (!Array.isArray(parts)) throw new Error('store is not an array');
  } catch {
    parts = SEED_PARTS.map((p) => ({ id: newId(), ...p }));
    await persist();
  }
}

function persist() {
  // Schreibvorgaenge serialisieren, damit sich parallele Requests nicht ueberholen.
  writeQueue = writeQueue.then(() =>
    fs.writeFile(DATA_FILE, JSON.stringify(parts, null, 2), 'utf8')
  ).catch((e) => console.error('persist:', e.message));
  return writeQueue;
}

// ---------------------------------------------------------------------------
// Rate-Limiting (In-Memory, pro IP pro Minute)
// ---------------------------------------------------------------------------

const RATE_LIMIT = Number(process.env.RATE_LIMIT) || 60; // Requests pro Minute
const rateBuckets = new Map(); // ip -> { count, windowStart }

function rateLimited(ip) {
  const now = Date.now();
  const bucket = rateBuckets.get(ip);
  if (!bucket || now - bucket.windowStart >= 60_000) {
    rateBuckets.set(ip, { count: 1, windowStart: now });
    return false;
  }
  bucket.count += 1;
  return bucket.count > RATE_LIMIT;
}

// Alte Buckets regelmaessig aufraeumen.
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateBuckets) {
    if (now - bucket.windowStart >= 120_000) rateBuckets.delete(ip);
  }
}, 60_000).unref();

// ---------------------------------------------------------------------------
// Validierung
// ---------------------------------------------------------------------------

const CATEGORIES = ['motor', 'fc', 'esc', 'camera', 'vtx', 'rx', 'prop', 'battery', 'frame', 'antenna', 'other'];

function validatePart(body, { partial = false } = {}) {
  const errors = [];
  const out = {};

  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);

  if (!partial || has('name')) {
    if (typeof body.name !== 'string' || body.name.trim().length < 2 || body.name.length > 200) {
      errors.push('name: string mit 2-200 Zeichen erforderlich');
    } else out.name = body.name.trim();
  }
  if (!partial || has('category')) {
    if (typeof body.category !== 'string' || !CATEGORIES.includes(body.category)) {
      errors.push(`category: eine von [${CATEGORIES.join(', ')}] erforderlich`);
    } else out.category = body.category;
  }
  if (!partial || has('price')) {
    if (typeof body.price !== 'number' || !Number.isFinite(body.price) || body.price < 0) {
      errors.push('price: Zahl >= 0 erforderlich');
    } else out.price = body.price;
  }
  if (!partial || has('weight_g')) {
    if (typeof body.weight_g !== 'number' || !Number.isFinite(body.weight_g) || body.weight_g < 0) {
      errors.push('weight_g: Zahl >= 0 erforderlich');
    } else out.weight_g = body.weight_g;
  }
  if (!partial || has('in_stock')) {
    if (typeof body.in_stock !== 'boolean') {
      errors.push('in_stock: boolean erforderlich');
    } else out.in_stock = body.in_stock;
  }

  return { errors, out };
}

// ---------------------------------------------------------------------------
// OpenAPI-3-Spec (handgeschrieben)
// ---------------------------------------------------------------------------

const PART_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string', readOnly: true, example: 'a1b2c3d4e5f6' },
    name: { type: 'string', example: 'iFlight XING2 2207 1855KV' },
    category: { type: 'string', enum: CATEGORIES },
    price: { type: 'number', minimum: 0, example: 21.9 },
    weight_g: { type: 'number', minimum: 0, example: 34.5 },
    in_stock: { type: 'boolean' },
  },
  required: ['name', 'category', 'price', 'weight_g', 'in_stock'],
};

const OPENAPI_SPEC = {
  openapi: '3.0.3',
  info: {
    title: 'parts-api',
    description: 'REST-API fuer einen FPV-Teile-Katalog. Dependency-freies Node.js.',
    version: '1.0.0',
    license: { name: 'MIT' },
  },
  servers: [{ url: `http://localhost:${PORT}` }],
  paths: {
    '/api/parts': {
      get: {
        summary: 'Teile auflisten (Filter, Suche, Pagination)',
        parameters: [
          { name: 'category', in: 'query', schema: { type: 'string', enum: CATEGORIES }, description: 'Nach Kategorie filtern' },
          { name: 'q', in: 'query', schema: { type: 'string' }, description: 'Volltextsuche im Namen' },
          { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
          { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 } },
        ],
        responses: {
          200: {
            description: 'Seite mit Teilen',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    data: { type: 'array', items: { $ref: '#/components/schemas/Part' } },
                    page: { type: 'integer' },
                    total: { type: 'integer' },
                    totalPages: { type: 'integer' },
                  },
                },
              },
            },
          },
          429: { description: 'Rate-Limit erreicht' },
        },
      },
      post: {
        summary: 'Teil anlegen',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Part' } } },
        },
        responses: {
          201: { description: 'Angelegtes Teil', content: { 'application/json': { schema: { $ref: '#/components/schemas/Part' } } } },
          400: { description: 'Validierungsfehler', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } },
        },
      },
    },
    '/api/parts/{id}': {
      get: {
        summary: 'Einzelnes Teil lesen',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          200: { description: 'Teil', content: { 'application/json': { schema: { $ref: '#/components/schemas/Part' } } } },
          404: { description: 'Nicht gefunden' },
        },
      },
      put: {
        summary: 'Teil aktualisieren (vollstaendig oder teilweise)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/Part' } } },
        },
        responses: {
          200: { description: 'Aktualisiertes Teil' },
          400: { description: 'Validierungsfehler' },
          404: { description: 'Nicht gefunden' },
        },
      },
      delete: {
        summary: 'Teil loeschen',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: {
          204: { description: 'Geloescht' },
          404: { description: 'Nicht gefunden' },
        },
      },
    },
    '/openapi.json': {
      get: { summary: 'Diese OpenAPI-Spec', responses: { 200: { description: 'OpenAPI 3 Dokument' } } },
    },
  },
  components: {
    schemas: {
      Part: PART_SCHEMA,
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string' },
          details: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

// ---------------------------------------------------------------------------
// HTML-Doku-Seite (aus der Spec generiert)
// ---------------------------------------------------------------------------

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function docsHtml() {
  const rows = [];
  for (const [p, methods] of Object.entries(OPENAPI_SPEC.paths)) {
    for (const [m, op] of Object.entries(methods)) {
      rows.push(
        `<tr><td class="m ${m}">${m.toUpperCase()}</td><td><code>${esc(p)}</code></td><td>${esc(op.summary || '')}</td></tr>`
      );
    }
  }
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>parts-api — Doku</title>
<style>
  :root { color-scheme: light dark; }
  body { font-family: system-ui, sans-serif; max-width: 860px; margin: 2rem auto; padding: 0 1rem; line-height: 1.5; }
  h1 { margin-bottom: .2rem; }
  .sub { color: gray; margin-top: 0; }
  table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
  td, th { border: 1px solid #8884; padding: .5rem .7rem; text-align: left; }
  .m { font-weight: 700; font-family: monospace; }
  .get { color: #1a7f37; } .post { color: #0550ae; } .put { color: #9a6700; } .delete { color: #cf222e; }
  code { background: #8882; padding: .1rem .3rem; border-radius: 4px; }
</style>
</head>
<body>
<h1>parts-api</h1>
<p class="sub">${esc(OPENAPI_SPEC.info.description)} — v${esc(OPENAPI_SPEC.info.version)}</p>
<p>Maschinenlesbare Spec: <a href="/openapi.json"><code>/openapi.json</code></a> ·
Rate-Limit: ${RATE_LIMIT} Requests/Minute/IP</p>
<table>
<tr><th>Methode</th><th>Pfad</th><th>Beschreibung</th></tr>
${rows.join('\n')}
</table>
<p>Beispiel: <code>curl "http://localhost:${PORT}/api/parts?category=motor&amp;page=1&amp;limit=5"</code></p>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP-Helfer
// ---------------------------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > maxBytes) {
        reject(Object.assign(new Error('payload too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const ip = req.socket.remoteAddress || 'unknown';
  if (rateLimited(ip)) {
    res.setHeader('Retry-After', '60');
    sendJson(res, 429, { error: 'rate limit exceeded', limit: `${RATE_LIMIT}/min` });
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  try {
    // GET / — HTML-Doku
    if (req.method === 'GET' && pathname === '/') {
      const html = docsHtml();
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // GET /openapi.json
    if (req.method === 'GET' && pathname === '/openapi.json') {
      sendJson(res, 200, OPENAPI_SPEC);
      return;
    }

    // /api/parts und /api/parts/:id
    const m = pathname.match(/^\/api\/parts(?:\/([a-zA-Z0-9]+))?$/);
    if (m) {
      const id = m[1];

      if (!id && req.method === 'GET') {
        let result = parts;
        const category = url.searchParams.get('category');
        const q = url.searchParams.get('q');
        if (category) result = result.filter((p) => p.category === category);
        if (q) {
          const needle = q.toLowerCase();
          result = result.filter((p) => p.name.toLowerCase().includes(needle));
        }
        let page = Number(url.searchParams.get('page')) || 1;
        let limit = Number(url.searchParams.get('limit')) || 20;
        if (page < 1) page = 1;
        if (limit < 1) limit = 1;
        if (limit > 100) limit = 100;
        const total = result.length;
        const totalPages = Math.max(1, Math.ceil(total / limit));
        const data = result.slice((page - 1) * limit, page * limit);
        sendJson(res, 200, { data, page, total, totalPages });
        return;
      }

      if (!id && req.method === 'POST') {
        let body;
        try {
          body = JSON.parse((await readBody(req)) || '{}');
        } catch {
          sendJson(res, 400, { error: 'invalid JSON body' });
          return;
        }
        const { errors, out } = validatePart(body);
        if (errors.length) {
          sendJson(res, 400, { error: 'validation failed', details: errors });
          return;
        }
        const part = { id: newId(), ...out };
        parts.push(part);
        await persist();
        sendJson(res, 201, part);
        return;
      }

      if (id) {
        const idx = parts.findIndex((p) => p.id === id);

        if (req.method === 'GET') {
          if (idx === -1) return sendJson(res, 404, { error: 'part not found' });
          sendJson(res, 200, parts[idx]);
          return;
        }

        if (req.method === 'PUT') {
          if (idx === -1) return sendJson(res, 404, { error: 'part not found' });
          let body;
          try {
            body = JSON.parse((await readBody(req)) || '{}');
          } catch {
            sendJson(res, 400, { error: 'invalid JSON body' });
            return;
          }
          const { errors, out } = validatePart(body, { partial: true });
          if (errors.length) {
            sendJson(res, 400, { error: 'validation failed', details: errors });
            return;
          }
          if (Object.keys(out).length === 0) {
            sendJson(res, 400, { error: 'no valid fields to update' });
            return;
          }
          parts[idx] = { ...parts[idx], ...out };
          await persist();
          sendJson(res, 200, parts[idx]);
          return;
        }

        if (req.method === 'DELETE') {
          if (idx === -1) return sendJson(res, 404, { error: 'part not found' });
          parts.splice(idx, 1);
          await persist();
          res.writeHead(204);
          res.end();
          return;
        }
      }

      sendJson(res, 405, { error: 'method not allowed' });
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (err) {
    const status = err.status || 500;
    sendJson(res, status, { error: status === 500 ? 'internal server error' : err.message });
    if (status === 500) console.error(err);
  }
});

loadStore().then(() => {
  server.listen(PORT, () => {
    console.log(`parts-api laeuft auf http://localhost:${PORT} (${parts.length} Teile im Store)`);
  });
});
