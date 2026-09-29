// Koppeling met Home Assistant.
// Binnen een add-on levert de Supervisor automatisch SUPERVISOR_TOKEN.
// Buiten HA (testen) kun je HA_URL, HA_WS_URL en HA_TOKEN zelf zetten.

const TOKEN = process.env.HA_TOKEN || process.env.SUPERVISOR_TOKEN;
const BASE = process.env.HA_URL || 'http://supervisor/core';
const WS_URL = process.env.HA_WS_URL || 'ws://supervisor/core/websocket';

const CACHE_MS = 60 * 1000;
let cache = null;
let cacheTime = 0;

async function getStates() {
  const res = await fetch(`${BASE}/api/states`, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (!res.ok) throw new Error(`HA REST API gaf status ${res.status}`);
  return res.json();
}

// Voert een reeks WebSocket-commando's uit en geeft de resultaten terug.
function wsCommands(types, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const results = {};
    let id = 0;
    const idToType = {};
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('Timeout op HA WebSocket'));
    }, timeoutMs);

    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('Kan geen verbinding maken met HA WebSocket'));
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'auth_required') {
        ws.send(JSON.stringify({ type: 'auth', access_token: TOKEN }));
      } else if (msg.type === 'auth_invalid') {
        clearTimeout(timer);
        ws.close();
        reject(new Error('HA WebSocket authenticatie mislukt'));
      } else if (msg.type === 'auth_ok') {
        for (const type of types) {
          id += 1;
          idToType[id] = type;
          ws.send(JSON.stringify({ id, type }));
        }
      } else if (msg.type === 'result') {
        results[idToType[msg.id]] = msg.success ? msg.result : [];
        if (Object.keys(results).length === types.length) {
          clearTimeout(timer);
          ws.close();
          resolve(results);
        }
      }
    };
  });
}

// Overzicht: entities met domein, device_class, naam en ruimte.
async function getOverview(force = false) {
  if (!force && cache && Date.now() - cacheTime < CACHE_MS) return cache;

  const states = await getStates();

  let areas = [];
  let entityReg = [];
  let deviceReg = [];
  let wsError = null;
  try {
    const r = await wsCommands([
      'config/area_registry/list',
      'config/entity_registry/list',
      'config/device_registry/list',
    ]);
    areas = r['config/area_registry/list'] || [];
    entityReg = r['config/entity_registry/list'] || [];
    deviceReg = r['config/device_registry/list'] || [];
  } catch (err) {
    wsError = err.message; // ruimtes zijn optioneel; REST-data werkt nog steeds
  }

  const areaName = Object.fromEntries(areas.map((a) => [a.area_id, a.name]));
  const deviceArea = Object.fromEntries(deviceReg.map((d) => [d.id, d.area_id]));
  const entityArea = {};
  const entityPlatform = {};
  for (const e of entityReg) {
    entityArea[e.entity_id] = e.area_id || deviceArea[e.device_id] || null;
    entityPlatform[e.entity_id] = e.platform || null;
  }

  const entities = states.map((s) => {
    const areaId = entityArea[s.entity_id] || null;
    const domain = s.entity_id.split('.')[0];

    // Voor sensoren: welke attributen bevatten een lijst met objecten
    // (zoals prijslijsten), en welke sleutels heeft het eerste item.
    const listAttrs = {};
    if (domain === 'sensor') {
      for (const [k, v] of Object.entries(s.attributes)) {
        if (Array.isArray(v) && v.length && v[0] && typeof v[0] === 'object') {
          listAttrs[k] = Object.keys(v[0]);
        }
      }
    }

    return {
      entity_id: s.entity_id,
      domain,
      name: s.attributes.friendly_name || s.entity_id,
      device_class: s.attributes.device_class || null,
      area: areaId ? areaName[areaId] || null : null,
      platform: entityPlatform[s.entity_id] || null,
      list_attrs: listAttrs,
    };
  });

  cache = { entities, areas: areas.map((a) => a.name), wsError };
  cacheTime = Date.now();
  return cache;
}

module.exports = { getOverview };
