// Template: licht aan bij beweging, uit na X seconden geen beweging.
// Een template = vragen (voor de wizard) + build() die het blueprint-object maakt.

const { input } = require('../yaml');

module.exports = {
  id: 'motion-light',
  name: 'Bewegingslicht',
  description: 'Licht aan bij beweging, uit na een instelbare tijd zonder beweging.',

  // Vragen die de wizard stelt. "options" mag een functie zijn die HA-data gebruikt.
  questions: [
    {
      key: 'name',
      type: 'text',
      label: 'Naam van de blueprint',
      default: 'Bewegingslicht',
      required: true,
    },
    {
      key: 'description',
      type: 'text',
      label: 'Omschrijving',
      default: 'Zet licht aan bij beweging en weer uit na een ingestelde tijd.',
    },
    {
      key: 'sensor_class',
      type: 'select',
      label: 'Welk soort sensor mag gekozen worden?',
      help: 'Gebaseerd op de binary sensors in jouw Home Assistant.',
      options: (ha) => {
        const counts = {};
        for (const e of ha.entities) {
          if (e.domain !== 'binary_sensor' || !e.device_class) continue;
          counts[e.device_class] = (counts[e.device_class] || 0) + 1;
        }
        if (!counts.motion) counts.motion = 0;
        const opts = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([dc, n]) => ({ value: dc, label: `${dc} (${n} in jouw HA)` }));
        opts.push({ value: '', label: 'Alle binary sensors (geen filter)' });
        return opts;
      },
      default: 'motion',
    },
    {
      key: 'delay',
      type: 'number',
      label: 'Standaard wachttijd na laatste beweging (seconden)',
      default: 120,
      min: 0,
      max: 3600,
    },
    {
      key: 'use_brightness',
      type: 'boolean',
      label: 'Helderheid instelbaar maken?',
      default: true,
    },
    {
      key: 'brightness_default',
      type: 'number',
      label: 'Standaard helderheid (%)',
      default: 80,
      min: 1,
      max: 100,
      showIf: { use_brightness: true },
    },
    {
      key: 'use_lux',
      type: 'boolean',
      label: 'Alleen aan als het donker genoeg is (lux-sensor)?',
      default: false,
    },
    {
      key: 'lux_default',
      type: 'number',
      label: 'Standaard lux-drempel',
      default: 20,
      min: 0,
      max: 10000,
      showIf: { use_lux: true },
    },
    {
      key: 'use_time',
      type: 'boolean',
      label: 'Alleen binnen een tijdvenster?',
      default: false,
    },
  ],

  build(a) {
    const inputs = {
      motion_entity: {
        name: 'Sensor',
        selector: {
          entity: {
            filter: a.sensor_class
              ? [{ domain: 'binary_sensor', device_class: a.sensor_class }]
              : [{ domain: 'binary_sensor' }],
          },
        },
      },
      light_target: {
        name: 'Lampen',
        selector: { target: { entity: [{ domain: 'light' }] } },
      },
      no_motion_wait: {
        name: 'Wachttijd',
        description: 'Tijd na de laatste beweging voordat het licht uitgaat.',
        default: a.delay,
        selector: { number: { min: 0, max: 3600, unit_of_measurement: 'seconds' } },
      },
    };

    if (a.use_brightness) {
      inputs.brightness = {
        name: 'Helderheid',
        default: a.brightness_default,
        selector: { number: { min: 1, max: 100, unit_of_measurement: '%' } },
      };
    }

    const conditions = [];
    if (a.use_lux) {
      inputs.lux_sensor = {
        name: 'Lux-sensor',
        selector: {
          entity: { filter: [{ domain: 'sensor', device_class: 'illuminance' }] },
        },
      };
      inputs.lux_threshold = {
        name: 'Lux-drempel',
        description: 'Licht gaat alleen aan onder deze waarde.',
        default: a.lux_default,
        selector: { number: { min: 0, max: 10000, unit_of_measurement: 'lx' } },
      };
      conditions.push({
        condition: 'numeric_state',
        entity_id: input('lux_sensor'),
        below: input('lux_threshold'),
      });
    }
    if (a.use_time) {
      inputs.time_after = { name: 'Vanaf', default: '18:00:00', selector: { time: {} } };
      inputs.time_before = { name: 'Tot', default: '07:00:00', selector: { time: {} } };
      conditions.push({
        condition: 'time',
        after: input('time_after'),
        before: input('time_before'),
      });
    }

    const turnOn = {
      alias: 'Licht aan',
      action: 'light.turn_on',
      target: input('light_target'),
    };
    if (a.use_brightness) turnOn.data = { brightness_pct: input('brightness') };

    return {
      blueprint: {
        name: a.name,
        description: a.description || undefined,
        domain: 'automation',
        homeassistant: { min_version: '2024.10.0' },
        input: inputs,
      },
      mode: 'restart',
      max_exceeded: 'silent',
      triggers: [
        {
          trigger: 'state',
          entity_id: input('motion_entity'),
          from: 'off',
          to: 'on',
        },
      ],
      conditions: conditions.length ? conditions : undefined,
      actions: [
        turnOn,
        {
          alias: 'Wachten tot er geen beweging meer is',
          wait_for_trigger: [
            {
              trigger: 'state',
              entity_id: input('motion_entity'),
              from: 'on',
              to: 'off',
            },
          ],
        },
        { alias: 'Wachttijd', delay: input('no_motion_wait') },
        { alias: 'Licht uit', action: 'light.turn_off', target: input('light_target') },
      ],
    };
  },
};
