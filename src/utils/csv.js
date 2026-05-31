// Utilidades compartidas para los importadores CSV (pilotos, coches, equipos).

function stripBom(s) {
  return (s && s.charCodeAt(0) === 0xFEFF) ? s.slice(1) : s;
}

function detectSeparator(line) {
  return (line.split(';').length > line.split(',').length) ? ';' : ',';
}

// Parser CSV mínimo con soporte de comillas (subset RFC 4180).
//   - Separador parametrizable (',' o ';').
//   - Campo entre " " preserva el separador dentro: "foo, bar"
//   - "" dentro de un campo entrecomillado → " literal.
function parseCsvLine(line, sep) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = false;
      } else cur += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
  }
  out.push(cur);
  return out;
}

// Normaliza un string para comparaciones case + accent insensitive.
//   normalize("Juan García") === normalize("juan garcia")  ✓
function normalize(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, ''); // quita marcas combinantes (tildes/diéresis)
}

// Parsea raw CSV completo a objeto { sep, header, dataLines }.
// Devuelve dataLines como array de string (sin parsear las columnas todavía).
function parseCsvRaw(raw) {
  let s = stripBom(raw || '').trim();
  if (!s) return { sep: ',', header: [], dataLines: [] };
  const lines = s.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return { sep: ',', header: [], dataLines: [] };
  const sep = detectSeparator(lines[0]);
  const header = parseCsvLine(lines[0], sep).map(c => c.trim().toLowerCase());
  return { sep, header, dataLines: lines.slice(1) };
}

module.exports = { stripBom, detectSeparator, parseCsvLine, normalize, parseCsvRaw };
