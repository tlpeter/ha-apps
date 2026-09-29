// Blueprint Builder - webserver (geen externe packages nodig)

const http = require('http');
const fs = require('fs');
const path = require('path');
const { dump } = require('./yaml');
const { getOverview } = require('./ha');

const PORT = Number(process.env.PORT || 8099);

// Alle templates uit de map templates/ laden
const templates = {};
for (const file of fs.readdirSync(path.join(__dirname, 'templates'))) {
  if (!file.endsWith('.js')) continue;
  const t = require(path.join(__dirname, 'templates', file));
  templates[t.id] = t;
}
console.log(`Templates geladen: ${Object.keys(templates).join(', ')}`);

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) reject(new Error('Body te groot'));
    });
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
  });
}

async function haSafe() {
  try {
    return await getOverview();
  } catch (err) {
    console.error('HA niet bereikbaar:', err.message);
    return { entities: [], areas: [], error: err.message };
  }
}

// Vragen met ingevulde opties (die mogen afhangen van HA-data)
function resolveQuestions(t, ha) {
  return t.questions.map((q) => ({
    ...q,
    options: typeof q.options === 'function' ? q.options(ha) : q.options,
  }));
}

// Antwoorden controleren en omzetten naar het juiste type
function normalize(t, raw) {
  const answers = {};
  const errors = [];
  for (const q of t.questions) {
    let v = raw[q.key];
    if (v === undefined || v === null || v === '') v = q.default;
    if (q.type === 'number') {
      v = Number(v);
      if (Number.isNaN(v)) errors.push(`${q.label}: geen geldig getal`);
      else if (q.min !== undefined && v < q.min) errors.push(`${q.label}: minimaal ${q.min}`);
      else if (q.max !== undefined && v > q.max) errors.push(`${q.label}: maximaal ${q.max}`);
    } else if (q.type === 'boolean') {
      v = v === true || v === 'true';
    } else {
      v = v === undefined || v === null ? '' : String(v).trim();
    }
    if (q.required && (v === '' || v === undefined)) errors.push(`${q.label}: verplicht`);
    answers[q.key] = v;
  }
  return { answers, errors };
}

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'blueprint';
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  try {
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      return send(res, 200, fs.readFileSync(path.join(__dirname, 'public', 'index.html')), 'text/html; charset=utf-8');
    }

    if (req.method === 'GET' && p === '/api/templates') {
      return send(res, 200, Object.values(templates).map((t) => ({
        id: t.id, name: t.name, description: t.description,
      })));
    }

    if (req.method === 'GET' && p === '/api/ha/overview') {
      const ha = await haSafe();
      const domains = {};
      for (const e of ha.entities) domains[e.domain] = (domains[e.domain] || 0) + 1;
      return send(res, 200, {
        entity_count: ha.entities.length,
        area_count: ha.areas.length,
        domains,
        error: ha.error || null,
        ws_error: ha.wsError || null,
      });
    }

    let m = p.match(/^\/api\/templates\/([\w-]+)\/questions$/);
    if (req.method === 'GET' && m) {
      const t = templates[m[1]];
      if (!t) return send(res, 404, { error: 'Template niet gevonden' });
      const ha = await haSafe();
      return send(res, 200, { id: t.id, name: t.name, questions: resolveQuestions(t, ha) });
    }

    m = p.match(/^\/api\/templates\/([\w-]+)\/build$/);
    if (req.method === 'POST' && m) {
      const t = templates[m[1]];
      if (!t) return send(res, 404, { error: 'Template niet gevonden' });
      const raw = await readBody(req);
      const { answers, errors } = normalize(t, raw);
      if (errors.length) return send(res, 400, { errors });
      const yaml = dump(t.build(answers));
      return send(res, 200, { yaml, filename: `${slugify(answers.name)}.yaml` });
    }

    send(res, 404, { error: 'Niet gevonden' });
  } catch (err) {
    console.error(err);
    send(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Blueprint Builder luistert op poort ${PORT}`));
