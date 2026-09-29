// Template: slim laden van een elektrische auto op de goedkoopste kwartieren.
//
// Werking van de gemaakte blueprint:
// - Elk kwartier (en bij aansluiten / accu-update) wordt opnieuw gerekend.
// - Uit de bekende prijzen tussen nu en de "klaar om"-tijd worden de goedkoopste
//   tijdvakken gekozen. Valt het huidige tijdvak daarin, dan wordt er geladen.
// - Laden/stoppen gebeurt met acties die de gebruiker zelf kiest, zodat het met
//   elke lader werkt (Easee, OCPP, Zaptec, een slimme schakelaar...).

const { input } = require('../yaml');

// Bekende prijsbronnen. "mode: attribute" leest een prijslijst uit attributen van
// een sensor; "mode: action" haalt prijzen op met een actie (officiële Nord Pool).
const SOURCES = {
  entsoe: {
    label: 'ENTSO-E (HACS)',
    mode: 'attribute',
    attrToday: 'prices_today',
    attrTomorrow: 'prices_tomorrow',
    timeKey: 'time',
    priceKey: 'price',
    detect: (e) => e.list_attrs && e.list_attrs.prices_today,
  },
  nordpool_hacs: {
    label: 'Nord Pool (HACS-versie)',
    mode: 'attribute',
    attrToday: 'raw_today',
    attrTomorrow: 'raw_tomorrow',
    timeKey: 'start',
    priceKey: 'value',
    detect: (e) => e.list_attrs && e.list_attrs.raw_today,
  },
  frank: {
    label: 'Frank Energie (HACS)',
    mode: 'attribute',
    attrToday: 'prices',
    attrTomorrow: '',
    timeKey: 'from',
    priceKey: 'price',
    detect: (e) =>
      e.list_attrs && e.list_attrs.prices && e.list_attrs.prices.includes('from'),
  },
  nordpool_core: {
    label: 'Nord Pool (officiële integratie)',
    mode: 'action',
    detect: (e) => e.platform === 'nordpool' && !(e.list_attrs && e.list_attrs.raw_today),
  },
  custom: {
    label: 'Andere sensor met prijslijst in attributen',
    mode: 'attribute',
    attrToday: 'prices_today',
    attrTomorrow: 'prices_tomorrow',
    timeKey: '',
    priceKey: '',
    detect: () => false,
  },
};

const CHARGERS = {
  easee: {
    label: 'Easee',
    connected: ['awaiting_start', 'ready_to_charge', 'charging', 'completed'],
    charging: ['charging'],
  },
  ocpp: {
    label: 'OCPP-lader',
    connected: ['Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing'],
    charging: ['Charging'],
  },
  generic: {
    label: 'Anders (bijv. stekker-sensor aan/uit)',
    connected: ['on'],
    charging: ['on'],
  },
};

const STATE_OPTIONS = [
  'on', 'awaiting_start', 'ready_to_charge', 'charging', 'completed',
  'Preparing', 'Charging', 'SuspendedEV', 'SuspendedEVSE', 'Finishing',
];

function detectSources(ha) {
  const found = {};
  for (const [key, src] of Object.entries(SOURCES)) {
    found[key] = ha.entities.filter(src.detect).map((e) => e.entity_id);
  }
  return found;
}

// Het Jinja-template dat elk kwartier het laadbesluit neemt
function planTemplate(a, src) {
  const soc = a.need_mode === 'soc';
  const L = [];
  L.push("{%- set ns = namespace(raw=[], slots=[]) -%}");

  if (src.mode === 'action') {
    L.push("{#- Prijzen uit de Nord Pool-actie (per gebied een lijst) -#}");
    L.push("{%- for resp in [np_today | default({}), np_tomorrow | default({})] -%}");
    L.push("  {%- for lst in resp.values() if lst is list -%}");
    L.push("    {%- set ns.raw = ns.raw + lst -%}");
    L.push("  {%- endfor -%}");
    L.push("{%- endfor -%}");
  } else {
    L.push("{#- Prijzen uit de attributen van de prijssensor -#}");
    L.push("{%- set t1 = state_attr(price_entity, attr_today) if attr_today else none -%}");
    L.push("{%- set t2 = state_attr(price_entity, attr_tomorrow) if attr_tomorrow else none -%}");
    L.push("{%- set ns.raw = (t1 if t1 is list else []) + (t2 if t2 is list else []) -%}");
  }

  L.push("{#- Elk item omzetten naar {ts, price}; sleutelnamen worden zo nodig automatisch gezocht -#}");
  L.push("{%- set tkeys = ([time_key] if time_key else []) + ['start', 'time', 'from', 'startsAt', 'start_time', 'datetime'] -%}");
  L.push("{%- set pkeys = ([price_key] if price_key else []) + ['price', 'value', 'total', 'electricity_price', 'per_kwh'] -%}");
  L.push("{%- for i in ns.raw if i is mapping -%}");
  L.push("  {%- set tk = tkeys | select('in', i) | first | default(none) -%}");
  L.push("  {%- set pk = pkeys | select('in', i) | first | default(none) -%}");
  L.push("  {%- if tk is not none and pk is not none -%}");
  L.push("    {%- set t = i[tk] -%}");
  L.push("    {%- set dt = t if t is datetime else as_datetime(t | string, none) -%}");
  L.push("    {%- set p = i[pk] | float(none) -%}");
  L.push("    {%- if dt is not none and p is not none -%}");
  L.push("      {%- set ns.slots = ns.slots + [{'ts': as_timestamp(dt), 'price': p / price_divisor}] -%}");
  L.push("    {%- endif -%}");
  L.push("  {%- endif -%}");
  L.push("{%- endfor -%}");
  L.push("{%- set slots = ns.slots | unique(attribute='ts') | sort(attribute='ts') | list -%}");
  L.push("{%- set len_s = (slots[1].ts - slots[0].ts) if slots | count > 1 else 3600 -%}");
  L.push("{%- set now_ts = as_timestamp(now()) -%}");
  L.push("{%- set cur = slots | selectattr('ts', 'le', now_ts) | selectattr('ts', 'gt', now_ts - len_s) | first | default(none) -%}");
  L.push("{#- Eerstvolgende 'klaar om'-moment -#}");
  L.push("{%- set dl = today_at(deadline) -%}");
  L.push("{%- set dl = dl + timedelta(days=1) if dl <= now() else dl -%}");
  L.push("{%- set dl_ts = as_timestamp(dl) -%}");

  if (soc) {
    L.push("{#- Benodigde tijdvakken op basis van het accupercentage -#}");
    L.push("{%- set soc = states(soc_entity) | float(none) -%}");
    L.push("{%- if soc is none -%}");
    L.push("  {%- set need = 0 -%}");
    L.push("{%- else -%}");
    L.push("  {%- set kwh = ([target_soc - soc, 0] | max) / 100 * battery_kwh * (1 + charge_loss / 100) -%}");
    L.push("  {%- set need = (kwh / charge_kw * 3600 / len_s) | round(0, 'ceil') | int -%}");
    L.push("{%- endif -%}");
    L.push("{%- set cands = slots | selectattr('ts', 'gt', now_ts - len_s) | selectattr('ts', 'lt', dl_ts) | list -%}");
  } else {
    L.push("{#- Vaste laadtijd binnen het venster [start, klaar om] -#}");
    L.push("{%- set ws = today_at(window_start) -%}");
    L.push("{%- set ws = ws - timedelta(days=1) if ws > dl else ws -%}");
    L.push("{%- set ws = ws + timedelta(days=1) if dl - ws > timedelta(days=1) else ws -%}");
    L.push("{%- set need = (charge_hours * 3600 / len_s) | round(0, 'ceil') | int -%}");
    L.push("{%- set ws_ts = as_timestamp(ws) -%}");
    L.push("{%- set cands = slots | selectattr('ts', 'ge', ws_ts) | selectattr('ts', 'lt', dl_ts) | list -%}");
  }

  L.push("{#- Zijn de prijzen al bekend tot aan de 'klaar om'-tijd? Zo niet: wachten, tenzij de tijd te krap wordt -#}");
  L.push("{%- set last_end = ((slots | last).ts + len_s) if slots | count > 0 else 0 -%}");
  L.push("{%- set remaining = ((dl_ts - (cur.ts if cur is not none else now_ts)) / len_s) | round(0, 'ceil') | int -%}");
  L.push("{%- set chosen = (cands | sort(attribute='price') | list)[:need] | map(attribute='ts') | list -%}");
  L.push("{#- Het besluit, met reden (zichtbaar in de trace) -#}");
  const branches = [];
  branches.push(["cur is none", "fallback_charge", "'geen prijs voor het huidige moment'"]);
  if (soc) {
    branches.push(["soc is none", "fallback_charge", "'accupercentage onbekend'"]);
    branches.push(["soc >= target_soc", "false", "'doel-percentage bereikt'"]);
    if (a.use_min_soc) branches.push(["soc < min_soc", "true", "'onder minimum-percentage'"]);
  } else {
    branches.push(["now_ts < ws_ts", "false", "'laadvenster nog niet begonnen'"]);
  }
  if (a.use_threshold) branches.push(["cur.price <= price_always", "true", "'prijs onder de grens'"]);
  branches.push(["last_end < dl_ts and need < remaining", "false", "'wachten tot de prijzen tot aan klaar-om-tijd bekend zijn'"]);
  branches.push(["last_end < dl_ts", "true", "'te weinig tijd, laden zonder volledige prijsdata'"]);
  branches.push(["cur.ts in chosen", "true", "'goedkoop tijdvak'"]);

  branches.forEach(([cond, val, reason], idx) => {
    L.push(`{%- ${idx === 0 ? 'if' : 'elif'} ${cond} -%}`);
    L.push(`  {%- set charge, reason = ${val}, ${reason} -%}`);
  });
  L.push("{%- else -%}");
  L.push("  {%- set charge, reason = false, 'wachten op goedkoper tijdvak' -%}");
  L.push("{%- endif -%}");
  L.push("{{ {");
  L.push("  'charge': charge,");
  L.push("  'reason': reason,");
  L.push("  'price_now': cur.price if cur is not none else none,");
  L.push("  'slots_needed': need,");
  L.push("  'slots_known': slots | count,");
  L.push("  'chosen': chosen | map('timestamp_local') | list");
  L.push("} }}");
  return L.join('\n');
}

module.exports = {
  id: 'smart-charging',
  name: 'Slim laden',
  description: 'Laad de auto op de goedkoopste tijdvakken vóór een ingestelde tijd.',

  questions: [
    {
      key: 'name',
      type: 'text',
      label: 'Naam van de blueprint',
      default: 'Slim laden',
      required: true,
    },
    {
      key: 'description',
      type: 'text',
      label: 'Omschrijving',
      default: 'Laadt de auto op de goedkoopste tijdvakken vóór de ingestelde tijd.',
    },
    {
      key: 'price_source',
      type: 'select',
      label: 'Waar komen de energieprijzen vandaan?',
      help: 'Herkend op basis van de integraties in jouw Home Assistant.',
      options: (ha) => {
        const found = detectSources(ha);
        return Object.entries(SOURCES).map(([key, src]) => {
          const f = found[key];
          let suffix = '';
          if (key !== 'custom') {
            suffix = f.length
              ? ` (gevonden: ${f.slice(0, 2).join(', ')}${f.length > 2 ? ', …' : ''})`
              : ' (niet gevonden)';
          }
          return { value: key, label: src.label + suffix };
        });
      },
      default: (ha) => {
        const found = detectSources(ha);
        return Object.keys(SOURCES).find((k) => found[k].length) || 'custom';
      },
    },
    {
      key: 'charger',
      type: 'select',
      label: 'Welke lader?',
      help: 'Bepaalt alleen de standaardwaarden voor "aangesloten" en "laadt".',
      options: Object.entries(CHARGERS).map(([value, c]) => ({ value, label: c.label })),
      default: 'easee',
    },
    {
      key: 'use_charging_entity',
      type: 'boolean',
      label: 'Laadstatus van de lader gebruiken? (aanbevolen: voorkomt dat start/stop elk kwartier opnieuw wordt gestuurd)',
      default: true,
    },
    {
      key: 'need_mode',
      type: 'select',
      label: 'Hoe wordt bepaald hoeveel er geladen moet worden?',
      options: [
        { value: 'soc', label: 'Op basis van accupercentage van de auto (aanbevolen)' },
        { value: 'fixed', label: 'Vaste laadtijd binnen een tijdvenster' },
      ],
      default: 'soc',
    },
    {
      key: 'use_min_soc',
      type: 'boolean',
      label: 'Altijd direct laden onder een minimum-percentage?',
      default: true,
      showIf: { need_mode: 'soc' },
    },
    {
      key: 'use_threshold',
      type: 'boolean',
      label: 'Altijd laden als de prijs onder een grens komt (bijv. negatieve prijzen)?',
      default: true,
    },
    {
      key: 'fallback_charge',
      type: 'boolean',
      label: 'Gewoon laden als er geen prijsdata is? (veilige keuze)',
      default: true,
    },
  ],

  build(a) {
    const src = SOURCES[a.price_source] || SOURCES.custom;
    const chg = CHARGERS[a.charger] || CHARGERS.generic;
    const soc = a.need_mode === 'soc';
    const stateSelector = {
      select: { options: STATE_OPTIONS, multiple: true, custom_value: true },
    };

    // ---------- Invoer, in inklapbare secties ----------
    const charger = {
      charger_connected: {
        name: 'Aangesloten-entiteit',
        description: 'Entiteit die aangeeft of de auto aangesloten is (bijv. de status-sensor van de lader of een stekker-sensor van de auto).',
        selector: { entity: {} },
      },
      connected_states: {
        name: 'Waarden voor "aangesloten"',
        description: 'Bij deze waarden van de aangesloten-entiteit is de auto aangesloten.',
        default: chg.connected,
        selector: stateSelector,
      },
    };
    if (a.use_charging_entity) {
      charger.charging_entity = {
        name: 'Laadstatus-entiteit',
        description: 'Entiteit waaraan te zien is dat er geladen wordt (vaak dezelfde status-sensor).',
        selector: { entity: {} },
      };
      charger.charging_states = {
        name: 'Waarden voor "laadt"',
        default: chg.charging,
        selector: stateSelector,
      };
    }
    charger.start_actions = {
      name: 'Acties: laden starten',
      description: 'Bijv. voor Easee: actie easee.action_command met action_command "start" (of "resume").',
      default: [],
      selector: { action: {} },
    };
    charger.stop_actions = {
      name: 'Acties: laden stoppen',
      description: 'Bijv. voor Easee: actie easee.action_command met action_command "stop" (of "pause").',
      default: [],
      selector: { action: {} },
    };

    const price = {};
    if (src.mode === 'action') {
      price.nordpool_entry = {
        name: 'Nord Pool-integratie',
        selector: { config_entry: { integration: 'nordpool' } },
      };
    } else {
      price.price_entity = {
        name: 'Prijssensor',
        description: 'Sensor met de prijslijst in de attributen.',
        selector: { entity: { filter: [{ domain: 'sensor' }] } },
      };
      price.attr_today = {
        name: 'Attribuut met prijzen (vandaag)',
        default: src.attrToday,
        selector: { text: {} },
      };
      price.attr_tomorrow = {
        name: 'Attribuut met prijzen (morgen)',
        description: 'Leeg laten als het attribuut hierboven al vandaag én morgen bevat.',
        default: src.attrTomorrow,
        selector: { text: {} },
      };
      price.time_key = {
        name: 'Sleutel voor de starttijd',
        description: 'Leeg = automatisch zoeken.',
        default: src.timeKey,
        selector: { text: {} },
      };
      price.price_key = {
        name: 'Sleutel voor de prijs',
        description: 'Leeg = automatisch zoeken.',
        default: src.priceKey,
        selector: { text: {} },
      };
    }
    if (a.use_threshold) {
      price.price_always = {
        name: 'Altijd laden onder deze prijs',
        description: src.mode === 'action'
          ? 'In €/kWh. Let op: Nord Pool levert kale marktprijzen (zonder btw en toeslagen).'
          : 'In dezelfde eenheid als de prijssensor (meestal €/kWh).',
        default: 0,
        selector: { number: { min: -1, max: 2, step: 0.01, mode: 'box', unit_of_measurement: '€/kWh' } },
      };
    }

    const need = {};
    if (soc) {
      need.soc_entity = {
        name: 'Accupercentage van de auto',
        selector: { entity: { filter: [{ domain: 'sensor', device_class: 'battery' }] } },
      };
      need.target_soc = {
        name: 'Doel-percentage',
        default: 80,
        selector: { number: { min: 10, max: 100, step: 5, unit_of_measurement: '%' } },
      };
      if (a.use_min_soc) {
        need.min_soc = {
          name: 'Minimum-percentage',
          description: 'Hieronder wordt altijd direct geladen, ongeacht de prijs.',
          default: 20,
          selector: { number: { min: 0, max: 100, step: 5, unit_of_measurement: '%' } },
        };
      }
      need.battery_kwh = {
        name: 'Bruikbare accucapaciteit',
        default: 60,
        selector: { number: { min: 5, max: 200, step: 1, mode: 'box', unit_of_measurement: 'kWh' } },
      };
      need.charge_kw = {
        name: 'Laadvermogen',
        description: 'Wat de auto in de praktijk laadt (bijv. 11 kW driefase, 7,4 kW eenfase).',
        default: 11,
        selector: { number: { min: 1, max: 22, step: 0.1, mode: 'box', unit_of_measurement: 'kW' } },
      };
      need.charge_loss = {
        name: 'Laadverlies',
        description: 'Extra marge voor verliezen tijdens het laden.',
        default: 10,
        selector: { number: { min: 0, max: 30, step: 1, unit_of_measurement: '%' } },
      };
    } else {
      need.charge_hours = {
        name: 'Laadtijd',
        default: 3,
        selector: { number: { min: 0.25, max: 24, step: 0.25, mode: 'box', unit_of_measurement: 'uur' } },
      };
      need.window_start = {
        name: 'Vroegste starttijd',
        description: 'Er wordt gezocht tussen deze tijd en de "klaar om"-tijd.',
        default: '17:00:00',
        selector: { time: {} },
      };
    }
    need.deadline = {
      name: 'Klaar om',
      default: '07:00:00',
      selector: { time: {} },
    };

    const inputs = {
      charger_section: {
        name: 'Lader',
        icon: 'mdi:ev-station',
        input: charger,
      },
      price_section: {
        name: 'Energieprijs',
        icon: 'mdi:currency-eur',
        input: price,
      },
      need_section: {
        name: 'Laadbehoefte en planning',
        icon: 'mdi:calendar-clock',
        input: need,
      },
    };

    // ---------- Variabelen ----------
    const variables = {
      connected_states: input('connected_states'),
      charger_connected: input('charger_connected'),
      deadline: input('deadline'),
      fallback_charge: a.fallback_charge,
      price_divisor: src.mode === 'action' ? 1000 : 1,
    };
    if (a.use_charging_entity) {
      variables.charging_entity = input('charging_entity');
      variables.charging_states = input('charging_states');
    }
    if (src.mode === 'action') {
      variables.time_key = 'start';
      variables.price_key = 'price';
    } else {
      variables.price_entity = input('price_entity');
      variables.attr_today = input('attr_today');
      variables.attr_tomorrow = input('attr_tomorrow');
      variables.time_key = input('time_key');
      variables.price_key = input('price_key');
    }
    if (a.use_threshold) variables.price_always = input('price_always');
    if (soc) {
      Object.assign(variables, {
        soc_entity: input('soc_entity'),
        target_soc: input('target_soc'),
        battery_kwh: input('battery_kwh'),
        charge_kw: input('charge_kw'),
        charge_loss: input('charge_loss'),
      });
      if (a.use_min_soc) variables.min_soc = input('min_soc');
    } else {
      variables.charge_hours = input('charge_hours');
      variables.window_start = input('window_start');
    }

    // ---------- Triggers ----------
    const triggers = [
      { trigger: 'time_pattern', minutes: '/15', seconds: 5 },
      { trigger: 'state', entity_id: input('charger_connected') },
      { trigger: 'homeassistant', event: 'start' },
    ];
    if (soc) triggers.push({ trigger: 'state', entity_id: input('soc_entity') });

    // ---------- Acties ----------
    const actions = [
      {
        alias: 'Alleen doorgaan als de auto aangesloten is',
        condition: 'template',
        value_template: '{{ states(charger_connected) in connected_states }}',
      },
    ];
    if (src.mode === 'action') {
      actions.push(
        {
          alias: 'Prijzen van vandaag ophalen',
          action: 'nordpool.get_price_indices_for_date',
          data: {
            config_entry: input('nordpool_entry'),
            date: '{{ now().date() | string }}',
            resolution: 15,
          },
          response_variable: 'np_today',
          continue_on_error: true,
        },
        {
          alias: 'Prijzen van morgen ophalen (lukt pas na publicatie, rond 13:00)',
          action: 'nordpool.get_price_indices_for_date',
          data: {
            config_entry: input('nordpool_entry'),
            date: '{{ (now() + timedelta(days=1)).date() | string }}',
            resolution: 15,
          },
          response_variable: 'np_tomorrow',
          continue_on_error: true,
        }
      );
    }
    actions.push({
      alias: 'Laadplan berekenen',
      variables: {
        plan: planTemplate(a, src),
        is_charging: a.use_charging_entity
          ? '{{ states(charging_entity) in charging_states }}'
          : false,
      },
    });

    const startCond = a.use_charging_entity ? '{{ plan.charge and not is_charging }}' : '{{ plan.charge }}';
    const stopCond = a.use_charging_entity ? '{{ not plan.charge and is_charging }}' : '{{ not plan.charge }}';
    actions.push({
      choose: [
        {
          alias: 'Starten',
          conditions: [{ condition: 'template', value_template: startCond }],
          sequence: input('start_actions'),
        },
        {
          alias: 'Stoppen',
          conditions: [{ condition: 'template', value_template: stopCond }],
          sequence: input('stop_actions'),
        },
      ],
    });

    return {
      blueprint: {
        name: a.name,
        description: a.description || undefined,
        domain: 'automation',
        homeassistant: { min_version: '2024.10.0' },
        input: inputs,
      },
      mode: 'single',
      max_exceeded: 'silent',
      variables,
      triggers,
      actions,
    };
  },
};
