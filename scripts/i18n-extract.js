'use strict';
/*
 * PitWall — gestión y cronometraje de carreras de slot
 * Copyright (C) 2026 Víctor González Gómez <vgonzalezgomez@outlook.es>
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */
// Cosechadora de i18n: convierte los ternarios de idioma en llamadas a `t()` y
// recoge las dos versiones (español e inglés) en los diccionarios.
//
//   <%= lang === 'es' ? 'Manga' : 'Heat' %>   →   <%= t('live.manga') %>
//
// POR QUÉ ASÍ: los ternarios ya llevan las dos traducciones dentro, así que al
// cosecharlas el render en español y en inglés queda idéntico POR CONSTRUCCIÓN.
// Eso es lo que hace verificable un cambio de ~1.900 puntos sin tests que lo
// cubran — ver `scripts/i18n-snapshot.js`.
//
// Uso:
//   node scripts/i18n-extract.js --dry                  (informe, no toca nada)
//   node scripts/i18n-extract.js --apply --glob 'src/views/races/live.ejs'
//
// IMPORTANTE — el análisis de claves es SIEMPRE sobre el conjunto completo de
// ficheros, aunque `--glob` limite los que se reescriben. Si no, una frase que
// aparece en dos vistas recibiría una clave distinta según en qué orden se
// procesaran los ficheros, y las claves dejarían de ser estables.

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const LOCALES = ['es', 'en', 'it'];

// ── Argumentos ────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (n) => argv.includes('--' + n);
const opt  = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

const APLICAR = flag('apply');
const GLOB    = opt('glob', null);
// Solo las conversiones que se evalúan en servidor. Las de cliente necesitan el
// `t()` del navegador (inyección del diccionario), que es otra fase: aplicarlas
// antes rompería el JS de la página y el arnés de instantáneas no lo vería,
// porque solo compara el HTML servido.
const SOLO_SERVIDOR = flag('solo-servidor');

// ── Ficheros objetivo ─────────────────────────────────────────────────────
function recorrer(dir, filtro, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) recorrer(p, filtro, acc);
    else if (filtro(p)) acc.push(p);
  }
  return acc;
}

function listarFicheros() {
  const views   = recorrer(path.join(ROOT, 'src/views'),   p => p.endsWith('.ejs'));
  const jsCli   = recorrer(path.join(ROOT, 'public/js'),   p => p.endsWith('.js'))
                    .filter(p => !/chart\.umd|jsQR/.test(p));   // librerías vendorizadas
  return [...views, ...jsCli].sort();
}

// ── Máscaras: dónde hay código de verdad ──────────────────────────────────
//
// Hace falta saber en cada posición si estamos dentro de código JavaScript (y no
// dentro de una cadena o un comentario) y si ese código es de cliente (dentro de
// un <script>) o de servidor. Sin esto, una regex suelta muerde dentro de
// atributos o de textos y rompe la plantilla.
function analizar(src, esEjs) {
  const n = src.length;
  const enJs      = new Uint8Array(n);
  const enCliente = new Uint8Array(n);
  const enCodigo  = new Uint8Array(n).fill(1);

  // Zonas de código, cada una INDEPENDIENTE de las demás.
  //
  // Esto es la clave de las plantillas EJS: una etiqueta `<% %>` se evalúa en
  // servidor aunque esté dentro de una cadena de JavaScript del `<script>` —
  // `${'<%= lang === "es" ? "A" : "B" %>'}` es una cadena para el navegador,
  // pero el servidor la sustituye igual. Si se escanea el fichero entero de
  // una tirada, esa etiqueta queda «dentro de una cadena» y se pierde.
  const zonasServidor = [];   // <% … %>
  const zonasScript   = [];   // <script>…</script> sin src

  if (esEjs) {
    const reScript = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = reScript.exec(src))) {
      if (/\bsrc\s*=/.test(m[1])) continue;                 // <script src=…>: no hay JS dentro
      const ini = m.index + m[0].indexOf('>') + 1;
      zonasScript.push([ini, ini + m[2].length]);
    }
    let i = 0;
    for (;;) {
      const a = src.indexOf('<%', i);
      if (a === -1) break;
      const b = src.indexOf('%>', a);
      if (b === -1) break;
      zonasServidor.push([a + 2, b]);
      i = b + 2;
    }
  } else {
    zonasScript.push([0, n]);
  }

  // Las zonas se SOLAPAN a propósito: un `<% %>` va casi siempre dentro de un
  // <script>, y no se puede recortar sin romper el JavaScript de alrededor —
  // `const LANG = "<%= lang %>";` se queda con la comilla sin cerrar y el
  // escáner se traga el resto del fichero.
  //
  // En vez de recortar, las zonas de servidor van AL FINAL y resetean lo que
  // hayan dicho las de cliente. Y las cadenas del <script> saltan por encima de
  // las etiquetas (ver `saltarEtiqueta`), que es como las ve el navegador: la
  // etiqueta ya se habrá sustituido antes de que él mire.
  const zonas = [];   // [ini, fin, esCliente] — las de servidor, las últimas
  for (const z of zonasScript)   zonas.push([z[0], z[1], true]);
  for (const z of zonasServidor) zonas.push([z[0], z[1], false]);

  for (const [ini, fin] of zonas) for (let k = ini; k < fin; k++) enJs[k] = 1;

  // Dentro del código, marcar cadenas y comentarios como NO código.
  //
  // OJO con las plantillas `…`: el texto de fuera es literal, pero lo que va
  // dentro de ${ … } SÍ es código — y ahí hay muchos ternarios (solo en live.js,
  // 21). Tratar toda la plantilla como texto dejaba fuera un tercio del trabajo.
  let i = 0, zFin = 0;                      // i: posición actual · zFin: fin de la zona en curso

  // Una etiqueta `<% … %>` dentro de una cadena de JavaScript no la cierra: el
  // servidor la sustituye antes de que el navegador parsee. Si no se salta, la
  // comilla de apertura se queda buscando pareja y se traga medio fichero.
  function saltarEtiqueta() {
    if (!esEjs || src[i] !== '<' || src[i + 1] !== '%') return false;
    const b = src.indexOf('%>', i);
    if (b === -1 || b >= zFin) return false;
    for (let k = i; k < b + 2; k++) enCodigo[k] = 0;
    i = b + 2;
    return true;
  }

  function cadena(q) {                       // consume '…' o "…"
    enCodigo[i] = 0; i++;
    while (i < zFin) {
      if (saltarEtiqueta()) continue;
      if (src[i] === '\\') { enCodigo[i] = 0; enCodigo[i + 1] = 0; i += 2; continue; }
      const fin = src[i] === q;
      enCodigo[i] = 0; i++;
      if (fin) break;
    }
  }

  function plantilla() {                     // consume `…`, entrando en ${ }
    enCodigo[i] = 0; i++;
    while (i < zFin) {
      if (src[i] === '\\') { enCodigo[i] = 0; enCodigo[i + 1] = 0; i += 2; continue; }
      if (src[i] === '`') { enCodigo[i] = 0; i++; return; }
      if (src[i] === '$' && src[i + 1] === '{') {
        enCodigo[i] = enCodigo[i + 1] = 0; i += 2;
        let prof = 1;
        while (i < zFin && prof > 0) {
          const d = src[i];
          if (d === '{') { prof++; enCodigo[i] = 1; i++; continue; }
          if (d === '}') { prof--; enCodigo[i] = prof === 0 ? 0 : 1; i++; continue; }
          if (d === '"' || d === "'") { cadena(d); continue; }
          if (d === '`') { plantilla(); continue; }
          // Los regex también aparecen aquí: `${name.replace(/"/g,'&quot;')}`.
          // Sin esto, la comilla de dentro del regex abre una cadena que se traga
          // lo que queda de fichero.
          if (d === '/' && pareceRegex(i)) { regex(); continue; }
          enCodigo[i] = 1; i++;
        }
        continue;
      }
      enCodigo[i] = 0; i++;
    }
  }

  // Cada zona se escanea por su cuenta, con el estado de cadena/comentario a
  // cero al empezar: así una comilla sin cerrar en un <script> no se lleva por
  // delante las etiquetas EJS que vengan después.
  for (const [zIni, zEnd, esCliente] of zonas) {
    i = zIni; zFin = zEnd;
    // Reset: una zona posterior (las de servidor van al final) manda sobre lo
    // que haya marcado otra que la solape.
    for (let k = zIni; k < zEnd; k++) { enCodigo[k] = 1; enCliente[k] = esCliente ? 1 : 0; }
    while (i < zFin) {
      const c = src[i], c2 = src[i + 1];
      if (c === '/' && c2 === '/') {
        while (i < zFin && src[i] !== '\n') { enCodigo[i] = 0; i++; }
        continue;
      }
      if (c === '/' && c2 === '*') {
        enCodigo[i] = enCodigo[i + 1] = 0; i += 2;
        while (i < zFin && !(src[i] === '*' && src[i + 1] === '/')) { enCodigo[i] = 0; i++; }
        if (i < zFin) { enCodigo[i] = enCodigo[i + 1] = 0; i += 2; }
        continue;
      }
      if (c === '"' || c === "'") { cadena(c); continue; }
      if (c === '`')              { plantilla(); continue; }
      if (c === '/' && pareceRegex(i)) { regex(); continue; }
      i++;
    }
  }
  return { enJs, enCliente, enCodigo };

  // ¿El `/` de esta posición abre un literal regex o es una división? No hay
  // forma de saberlo sin analizar; el truco estándar es mirar el carácter
  // anterior: si es un operador o un paréntesis, no puede ser una división.
  //
  // Importa mucho: `.replace(/"/g, '&quot;')` es habitual en estas vistas, y sin
  // esto la comilla de dentro del regex se lee como apertura de cadena y TODO lo
  // que viene detrás del fichero queda marcado como texto — que es justo el
  // fallo que dejaba 107 ternarios sin convertir.
  function pareceRegex(pos) {
    let j = pos - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (j < 0) return true;
    return !/[A-Za-z0-9_$)\]]/.test(src[j]);
  }

  function regex() {
    enCodigo[i] = 0; i++;
    let enClase = false;
    while (i < zFin) {
      if (src[i] === '\\') { enCodigo[i] = enCodigo[i + 1] = 0; i += 2; continue; }
      if (src[i] === '\n') return;                       // un regex no cruza de línea
      if (src[i] === '[') enClase = true;
      else if (src[i] === ']') enClase = false;
      else if (src[i] === '/' && !enClase) { enCodigo[i] = 0; i++; break; }
      enCodigo[i] = 0; i++;
    }
    while (i < zFin && /[a-z]/i.test(src[i])) { enCodigo[i] = 0; i++; }   // sufijos
  }
}

// ── Alias booleanos de "¿es español?" ─────────────────────────────────────
//
// Además de `lang === 'es'`, hay variables ya calculadas que se usan como
// `es ? 'ES' : 'EN'`. Se detectan por su declaración en el propio fichero, en
// vez de por una lista fija: así no se cuela una variable homónima que
// signifique otra cosa.
function aliasDeIdioma(src) {
  const alias = new Map();   // nombre → true si es «español»
  const re = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g;
  let m;
  while ((m = re.exec(src))) {
    const nombre = m[1], expr = m[2];
    if (/[=!]==\s*['"]es['"]/.test(expr))      alias.set(nombre, true);
    else if (/[=!]==\s*['"]en['"]/.test(expr)) alias.set(nombre, false);
  }
  return alias;
}

// ── Claves ────────────────────────────────────────────────────────────────
function dominioDe(fichero) {
  const rel = path.relative(ROOT, fichero);
  if (rel.startsWith('public/js/')) return 'js';        // se refina abajo
  const base = path.basename(fichero, path.extname(fichero));
  const dir  = path.basename(path.dirname(fichero));
  if (dir === 'partials') return 'common';
  if (base === 'index') return dir;
  // Los pasos del asistente comparten dominio: new-step1..4 → wizard
  if (/^new-step\d/.test(base)) return 'wizard';
  return base;
}

// Las claves son para siempre (el traductor trabaja sobre ellas), así que el
// troceado tiene que dar algo legible: si hay que cortar, se corta en palabra y
// no a mitad — `…esta_protegida_int` queda feo y confunde al revisar.
function aSlug(texto) {
  let s = String(texto)
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')   // quita acentos
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

  if (s.length > 48) {
    const recorte = s.slice(0, 48);
    const ultimo = recorte.lastIndexOf('_');
    s = ultimo > 24 ? recorte.slice(0, ultimo) : recorte;
  }
  s = s.replace(/_+$/, '');
  return s || 'txt';
}

// El literal de origen puede traer escapes (`'PC\'s'`), y al diccionario tiene
// que ir el TEXTO, no el literal: si se cuela el backslash, la página acaba
// pintando `PC\&#39;s`. Ya pasó y se vio en el arnés de instantáneas.
function desescapar(s) {
  return String(s).replace(/\\(.)/g, (_, c) => ({
    n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`',
  }[c] ?? c));
}

// Pares que NO son texto de interfaz y no deben entrar al diccionario.
function esTecnico(a, b) {
  // Códigos de idioma: 'es-ES' / 'en-US'.
  const loc = /^[a-z]{2}(-[A-Za-z]{2,4})?$/;
  if (loc.test(a) && loc.test(b)) return true;
  // Ternarios que eligen una clase CSS, no texto: `… ? 'btn--active' : ''`.
  // Traducirlos borra la clase y descuadra el diseño — pasó en el pie y en el
  // EULA, y se vio como 104 páginas distintas en el arnés.
  if (a === '' || b === '') return true;
  return false;
}

// ── Análisis ──────────────────────────────────────────────────────────────
function analizarFichero(fichero) {
  const src = fs.readFileSync(fichero, 'utf8');
  const esEjs = fichero.endsWith('.ejs');
  const { enJs, enCliente, enCodigo } = analizar(src, esEjs);
  const alias = aliasDeIdioma(src);
  const dominio = dominioDe(fichero);

  const hallazgos = [];
  const descartes = {};
  const ejemplos = {};   // motivo → [líneas], para poder mirarlos

  // Forma con comparación: lang === 'es' ? A : B   (y !== 'en', === 'en'…)
  const reComp = /\b([A-Za-z_$][\w$]*)\s*(===|!==)\s*(['"])(es|en)\3\s*\?\s*(['"])((?:\\.|(?!\5)[^\\])*?)\5\s*:\s*(['"])((?:\\.|(?!\7)[^\\])*?)\7/g;
  // Forma con alias booleano: es ? A : B
  const reBool = /\b([A-Za-z_$][\w$]*)\s*\?\s*(['"])((?:\\.|(?!\2)[^\\])*?)\2\s*:\s*(['"])((?:\\.|(?!\4)[^\\])*?)\4/g;

  const intentar = (m, ramaA, ramaB, aEsEspañol) => {
    const ini = m.index, fin = m.index + m[0].length;
    const no = (motivo) => {
      descartes[motivo] = (descartes[motivo] || 0) + 1;
      const e = (ejemplos[motivo] = ejemplos[motivo] || []);
      if (e.length < 3) {
        const linea = src.slice(0, ini).split('\n').length;
        let extra = '';
        if (motivo.startsWith('dentro de una cadena')) {
          // Retroceder hasta dónde empezó el «texto» que se ha tragado la posición:
          // sin esto no hay forma de saber qué constructo despistó al escáner.
          let k = ini;
          while (k > 0 && enCodigo[k - 1] === 0) k--;
          extra = `\n                     abrió en: …${src.slice(Math.max(0, k - 50), k + 8).replace(/\n/g, '⏎')}`;
        }
        e.push(`${path.relative(ROOT, fichero)}:${linea}  ${m[0].replace(/\s+/g, ' ').slice(0, 80)}${extra}`);
      }
    };
    if (!enJs[ini])      return no('fuera de un bloque JS (HTML)');
    if (!enCodigo[ini])  return no('dentro de una cadena o comentario');
    for (let k = ini; k < fin; k++) if (!enJs[k]) return no('cruza fuera del bloque JS');
    if (m[0].includes('\n')) return no('multilínea');

    const esBruto = aEsEspañol ? ramaA : ramaB;
    const enBruto = aEsEspañol ? ramaB : ramaA;
    if (!esBruto || !enBruto) return no('rama no literal');
    const es = desescapar(esBruto);
    const en = desescapar(enBruto);
    if (esTecnico(es, en)) return no('códigos de idioma');

    hallazgos.push({
      ini, fin, es, en,
      cliente: !!enCliente[ini],
      dominio,
      linea: src.slice(0, ini).split('\n').length,
    });
  };

  let m;
  reComp.lastIndex = 0;
  while ((m = reComp.exec(src))) {
    // === 'es' y !== 'en' → la primera rama es español; === 'en' y !== 'es' → inglés
    const esPrimero = (m[2] === '===' && m[4] === 'es') || (m[2] === '!==' && m[4] === 'en');
    intentar(m, m[6], m[8], esPrimero);
  }
  reBool.lastIndex = 0;
  while ((m = reBool.exec(src))) {
    if (!alias.has(m[1])) continue;                           // no es un alias conocido
    intentar(m, m[3], m[5], alias.get(m[1]));
  }

  // ¿El fichero declara su propio `t`? En las vistas `t` es el traductor, así que
  // una variable local con ese nombre lo sombrea y `t('clave')` acaba llamando a
  // la variable. Ya pasó una vez (`tandas.forEach(t => …)` en results.ejs) y el
  // síntoma fue un 500 al renderizar, no un fallo obvio.
  const sombras = [];
  {
    const re = /(?:const|let|var)\s+t\s*=|\(\s*t\s*[,)]|(?<![\w$.])t\s*=>/g;
    let m2, zona;
    while ((m2 = re.exec(src))) {
      if (!enCodigo[m2.index]) continue;
      zona = enCliente[m2.index] ? 'cliente' : 'servidor';
      sombras.push(`${path.relative(ROOT, fichero)}:${src.slice(0, m2.index).split('\n').length} (${zona})`);
    }
  }

  hallazgos.sort((x, y) => x.ini - y.ini);
  return { fichero, src, hallazgos, descartes, ejemplos, sombras };
}

// ── Diccionarios ──────────────────────────────────────────────────────────
function leerDict(lang) {
  const p = path.join(ROOT, 'src/locales', lang + '.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {};
}

function ponerClave(dict, clave, valor) {
  const partes = clave.split('.');
  let o = dict;
  for (let i = 0; i < partes.length - 1; i++) {
    if (typeof o[partes[i]] !== 'object' || o[partes[i]] === null) o[partes[i]] = {};
    o = o[partes[i]];
  }
  if (typeof o[partes[partes.length - 1]] !== 'string') o[partes[partes.length - 1]] = valor;
}

function clavesExistentes(dict, prefijo = '', acc = new Set()) {
  for (const [k, v] of Object.entries(dict)) {
    const ruta = prefijo ? prefijo + '.' + k : k;
    if (typeof v === 'string') acc.add(ruta); else clavesExistentes(v, ruta, acc);
  }
  return acc;
}

// ── Main ──────────────────────────────────────────────────────────────────
function main() {
  const ficheros = listarFicheros();
  const analisis = ficheros.map(analizarFichero);

  // 1) Recolectar pares y en qué dominios aparecen (SIEMPRE sobre todo el
  //    conjunto, para que las claves no dependan del --glob).
  const pares = new Map();   // "es\u0000en" → { es, en, dominios:Set, cliente:bool }
  for (const a of analisis) {
    for (const h of a.hallazgos) {
      const k = h.es + '\u0000' + h.en;
      if (!pares.has(k)) pares.set(k, { es: h.es, en: h.en, dominios: new Set(), cliente: false });
      const p = pares.get(k);
      p.dominios.add(h.dominio);
      if (h.cliente) p.cliente = true;
    }
  }

  // 2) Asignar claves: un solo dominio → ese dominio; varios → `common`.
  const esDict = leerDict('es');
  const enDict = leerDict('en');
  const usadas = clavesExistentes(esDict);
  const claveDe = new Map();

  // Claves que YA existen, indexadas por su par (es,en). Sin esto, un texto que
  // sale en servidor y en cliente recibiría dos claves distintas según la pasada:
  // la de servidor ya estaría puesta en su sitio y la de cliente sacaría un `_2`
  // con el mismo contenido — y el traductor lo traduciría dos veces.
  const valorEn = (o, clave) => clave.split('.').reduce((x, k) => x?.[k], o);
  const claveExistente = new Map();
  for (const k of usadas) {
    const e = valorEn(esDict, k), i = valorEn(enDict, k);
    if (typeof e === 'string' && typeof i === 'string') {
      const par = e + '\u0000' + i;
      if (!claveExistente.has(par)) claveExistente.set(par, k);
    }
  }

  for (const k of [...pares.keys()].sort()) {
    const p = pares.get(k);
    const yaTiene = claveExistente.get(k);
    if (yaTiene) { claveDe.set(k, yaTiene); continue; }   // mismo par ya dado de alta
    const grupo = p.dominios.size > 1 ? 'common' : [...p.dominios][0];
    const prefijo = p.cliente ? 'client.' : '';
    let base = `${prefijo}${grupo}.${aSlug(p.es)}`;
    let clave = base, i = 2;
    // Se desambigua SIEMPRE, sin mirar si el español coincide: la app traduce la
    // misma frase de varias formas según el sitio (`En curso` es «In progress» en
    // el inicio y «Active» en la lista de carreras), y reutilizar la clave por
    // coincidir el español se comía una de las dos traducciones.
    // Como `pares` ya viene deduplicado por el par (es,en), una misma frase no se
    // procesa dos veces y no se sufija de más.
    while (usadas.has(clave)) clave = `${base}_${i++}`;
    usadas.add(clave);
    claveDe.set(k, clave);
    ponerClave(esDict, clave, p.es);
    ponerClave(enDict, clave, p.en);
  }

  // 3) Reescribir (de atrás hacia delante para que los índices no se muevan).
  const seleccion = GLOB
    ? analisis.filter(a => {
        const rel = path.relative(ROOT, a.fichero);
        const re = new RegExp('^' + GLOB.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        return re.test(rel) || re.test(path.basename(rel));
      })
    : analisis;

  let cambiados = 0, reemplazos = 0, sinCambio = 0;
  const porDominio = {};

  for (const a of seleccion) {
    const lista = SOLO_SERVIDOR ? a.hallazgos.filter(h => !h.cliente) : a.hallazgos;
    if (!lista.length) { sinCambio++; continue; }
    let out = a.src;
    for (let i = lista.length - 1; i >= 0; i--) {
      const h = lista[i];
      const clave = claveDe.get(h.es + '\u0000' + h.en);
      if (!clave) continue;
      // En el navegador el ayudante es `I18N.t`, no `t`: el JS de cliente ya usa
      // `t` como variable en una docena de sitios y llamarlo `t()` los rompería.
      const llamada = h.cliente ? `I18N.t('${clave}')` : `t('${clave}')`;
      out = out.slice(0, h.ini) + llamada + out.slice(h.fin);
      reemplazos++;
      porDominio[h.dominio] = (porDominio[h.dominio] || 0) + 1;
    }
    if (out !== a.src) {
      cambiados++;
      if (APLICAR) fs.writeFileSync(a.fichero, out);
    }
  }

  // 4) Diccionarios: es/en se escriben; it SOLO se completa (nunca se pisa lo
  //    que ya haya traducido el traductor).
  if (APLICAR) {
    const ordenar = (o) => Object.fromEntries(Object.keys(o).sort().map(k =>
      [k, (o[k] && typeof o[k] === 'object') ? ordenar(o[k]) : o[k]]));
    fs.writeFileSync(path.join(ROOT, 'src/locales/es.json'), JSON.stringify(ordenar(esDict), null, 2) + '\n');
    fs.writeFileSync(path.join(ROOT, 'src/locales/en.json'), JSON.stringify(ordenar(enDict), null, 2) + '\n');

    const itDict = leerDict('it');
    const itTiene = clavesExistentes(itDict);
    let añadidas = 0;
    for (const [k, p] of pares) {
      const clave = claveDe.get(k);
      if (!itTiene.has(clave)) { ponerClave(itDict, clave, p.es); añadidas++; }
    }
    fs.writeFileSync(path.join(ROOT, 'src/locales/it.json'), JSON.stringify(ordenar(itDict), null, 2) + '\n');
    console.log(`it.json: +${añadidas} claves nuevas (las existentes no se tocan)`);
  }

  // 5) Informe
  const totalHallazgos = analisis.reduce((s, a) => s + a.hallazgos.length, 0);
  console.log(`ficheros analizados : ${ficheros.length}`);
  console.log(`ternarios encontrados: ${totalHallazgos}`);
  console.log(`pares (es,en) únicos : ${pares.size}`);
  console.log(`ficheros a reescribir: ${cambiados}` + (GLOB ? '  (los del --glob)' : ''));
  console.log(`reemplazos           : ${reemplazos}`);
  if (!APLICAR) console.log('\n(modo informe: no se ha tocado nada. Añade --apply para escribir)');
  else console.log('\nescrito.');

  if (totalHallazgos) {
    const top = Object.entries(porDominio).sort((a, b) => b[1] - a[1]).slice(0, 8);
    if (top.length) console.log('\npor dominio: ' + top.map(([d, n]) => `${d} ${n}`).join(', '));
  }

  // Choques de nombre: sitios donde el fichero se declara su propio `t`.
  const choques = [];
  for (const a of analisis) for (const s of a.sombras) choques.push(s);
  if (choques.length) {
    console.log(`\nOJO — ${choques.length} sitios declaran un \`t\` propio, que sombrea al traductor:`);
    choques.slice(0, 12).forEach(c => console.log('  ' + c));
    if (choques.length > 12) console.log(`  … y ${choques.length - 12} más`);
    console.log('  (en las vistas de servidor hay que renombrarlos; en cliente, ver el helper del diccionario)');
  }

  // Lo que se queda fuera, por motivo: es la lista de trabajo a mano.
  const motivos = {};
  for (const a of analisis) {
    for (const [k, n] of Object.entries(a.descartes)) motivos[k] = (motivos[k] || 0) + n;
  }
  const totalDescartes = Object.values(motivos).reduce((s, n) => s + n, 0);
  if (totalDescartes) {
    console.log(`\n${totalDescartes} ternarios NO convertidos, por motivo:`);
    for (const [k, n] of Object.entries(motivos).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(4)}  ${k}`);
      const ej = [];
      for (const a of analisis) if (a.ejemplos[k]) ej.push(...a.ejemplos[k]);
      ej.slice(0, 3).forEach(e => console.log(`          ${e}`));
    }
  }
}

main();
