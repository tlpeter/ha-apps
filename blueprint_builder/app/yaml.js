// Minimale YAML-generator met ondersteuning voor de HA-tag !input
// Gebruik: input('naam') -> wordt geschreven als: !input naam

const INPUT = Symbol('input');

function input(name) {
  return { [INPUT]: name };
}

function isInput(v) {
  return v !== null && typeof v === 'object' && INPUT in v;
}

function isScalar(v) {
  return v === null || v === undefined || typeof v !== 'object' || isInput(v);
}

const RESERVED = /^(true|false|yes|no|on|off|null|~|y|n)$/i;

function scalar(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  const s = String(v);
  const needsQuotes =
    s === '' ||
    RESERVED.test(s) ||
    /^[\s\d.+\-]/.test(s) ||
    /\s$/.test(s) ||
    /[:#\[\]{},&*!|>'"%@`\n]/.test(s);
  return needsQuotes ? JSON.stringify(s) : s;
}

function scal(v) {
  return isInput(v) ? `!input ${v[INPUT]}` : scalar(v);
}

function dump(v, ind = 0) {
  const pad = ' '.repeat(ind);
  if (isScalar(v)) return pad + scal(v) + '\n';

  if (Array.isArray(v)) {
    if (!v.length) return pad + '[]\n';
    return v
      .map((item) => {
        if (isScalar(item)) return `${pad}- ${scal(item)}\n`;
        if (Array.isArray(item)) return `${pad}-\n` + dump(item, ind + 2);
        const body = dump(item, ind + 2);
        return pad + '- ' + body.slice(ind + 2);
      })
      .join('');
  }

  const keys = Object.keys(v).filter((k) => v[k] !== undefined);
  if (!keys.length) return pad + '{}\n';
  return keys
    .map((k) => {
      const val = v[k];
      const key = scalar(k);
      if (isScalar(val)) return `${pad}${key}: ${scal(val)}\n`;
      if (Array.isArray(val) && !val.length) return `${pad}${key}: []\n`;
      if (!Array.isArray(val) && !Object.keys(val).length) return `${pad}${key}: {}\n`;
      return `${pad}${key}:\n` + dump(val, ind + 2);
    })
    .join('');
}

module.exports = { input, dump };
