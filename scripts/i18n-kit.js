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
// Kit para traductores: saca el diccionario a una hoja de cálculo y lo vuelve a
// meter. Pensado para que alguien que no programa pueda traducir o revisar un
// idioma sin tocar JSON ni Git.
//
//   node scripts/i18n-kit.js export --lang it --out .tmp/kit     (saca el CSV)
//   node scripts/i18n-kit.js import --lang it --csv kit.csv      (lo vuelve a meter)
//   node scripts/i18n-kit.js check                               (qué falta / sobra)
//
// El CSV lleva una columna por idioma y una de CONTEXTO, que dice en qué
// pantallas sale cada texto. Sin eso, traducir una palabra suelta como «Tanda» o
// «Coma» es adivinar: en este dominio significan cosas muy concretas.

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIR_LOCALES = path.join(ROOT, 'src/locales');

const argv = process.argv.slice(2);
const cmd  = argv[0];
const opt  = (n, d) => { const i = argv.indexOf('--' + n); return i === -1 ? d : argv[i + 1]; };

// ── Diccionario aplanado ──────────────────────────────────────────────────
function aplanar(o, prefijo = '', acc = {}) {
  for (const [k, v] of Object.entries(o)) {
    const ruta = prefijo ? prefijo + '.' + k : k;
    if (typeof v === 'string') acc[ruta] = v;
    else if (v && typeof v === 'object') aplanar(v, ruta, acc);
  }
  return acc;
}

function anidar(plano) {
  const out = {};
  for (const [clave, valor] of Object.entries(plano)) {
    const partes = clave.split('.');
    let o = out;
    for (let i = 0; i < partes.length - 1; i++) {
      if (typeof o[partes[i]] !== 'object' || o[partes[i]] === null) o[partes[i]] = {};
      o = o[partes[i]];
    }
    o[partes[partes.length - 1]] = valor;
  }
  const ordenar = (o) => Object.fromEntries(Object.keys(o).sort().map(k =>
    [k, (o[k] && typeof o[k] === 'object') ? ordenar(o[k]) : o[k]]));
  return ordenar(out);
}

function leerLang(lang) {
  const p = path.join(DIR_LOCALES, lang + '.json');
  return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : null;
}

function idiomas() {
  return fs.readdirSync(DIR_LOCALES).filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', '')).sort();
}

// ── Dónde se usa cada clave ───────────────────────────────────────────────
//
// El contexto es lo que hace traducible el kit. Se saca buscando `t('clave')` en
// las vistas y en el JS de cliente, y resumiendo en qué pantallas sale.
function recolectarContexto() {
  const ctx = {};
  const recorrer = (dir, filtro, acc = []) => {
    if (!fs.existsSync(dir)) return acc;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) recorrer(p, filtro, acc);
      else if (filtro(p)) acc.push(p);
    }
    return acc;
  };
  const ficheros = [
    ...recorrer(path.join(ROOT, 'src/views'), p => p.endsWith('.ejs')),
    ...recorrer(path.join(ROOT, 'public/js'), p => p.endsWith('.js')),
    ...recorrer(path.join(ROOT, 'src/controllers'), p => p.endsWith('.js')),
    ...recorrer(path.join(ROOT, 'src/services'), p => p.endsWith('.js')),
  ];
  const re = /\bt\(\s*'([\w.]+)'/g;
  for (const f of ficheros) {
    const rel = path.relative(ROOT, f);
    let m;
    const src = fs.readFileSync(f, 'utf8');
    while ((m = re.exec(src))) {
      (ctx[m[1]] = ctx[m[1]] || []).push(rel);
    }
  }
  for (const k of Object.keys(ctx)) {
    ctx[k] = [...new Set(ctx[k])].map(r => r.replace(/^src\/views\//, '').replace(/\.ejs$/, '')).join(' ');
  }
  return ctx;
}

// ── CSV ───────────────────────────────────────────────────────────────────
//
// Separador `;` porque es lo que espera Excel en español e italiano al abrir un
// CSV con doble clic, que es justo lo que va a hacer el traductor. Todo va entre
// comillas, así que da igual lo que lleven los textos.
const SEP = ';';
const cita = (s) => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';

function aCsv(filas, cabecera) {
  return [cabecera.map(cita).join(SEP), ...filas.map(f => f.map(cita).join(SEP))].join('\r\n') + '\r\n';
}

function deCsv(texto) {
  const filas = [];
  let campo = '', fila = [], entreComillas = false;
  const t = texto.replace(/^﻿/, '');          // BOM que mete Excel
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (entreComillas) {
      if (c === '"' && t[i + 1] === '"') { campo += '"'; i++; }
      else if (c === '"') entreComillas = false;
      else campo += c;
    } else if (c === '"') entreComillas = true;
    else if (c === SEP) { fila.push(campo); campo = ''; }
    else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
    else if (c !== '\r') campo += c;
  }
  if (campo !== '' || fila.length) { fila.push(campo); filas.push(fila); }
  return filas.filter(f => f.some(x => x !== ''));
}

// ── Guía para quien traduce ───────────────────────────────────────────────
//
// Sin el glosario esto no sirve: en slot racing, «Tanda», «Manga» y «Coma»
// significan cosas muy concretas y una traducción literal destroza la interfaz.
// Los términos de abajo ya están asentados en los manuales en italiano del
// proyecto, así que la interfaz y el manual deben decir lo mismo.
function guia(lang, total, sinContexto) {
  return `# Traducir PitWall al ${lang === 'it' ? 'italiano' : lang}

Gracias por echarnos una mano. No hace falta saber programar: es rellenar una
columna de una hoja de cálculo.

## Qué te enviamos

- **\`pitwall-${lang}.csv\`** — el fichero de trabajo. ${total} filas.
  Ábrelo con Excel, LibreOffice o Google Sheets (separador: punto y coma).

| columna | qué es |
|---|---|
| \`clave\` | el identificador interno. **No se toca.** |
| \`es\` | el texto en español, que es el original. **No se toca.** |
| \`en\` | el inglés que ya había. Sirve de referencia para desambiguar. **No se toca.** |
| \`${lang}\` | **aquí escribes tú.** Viene con el español como punto de partida: corrígelo. |
| \`contexto\` | en qué pantalla sale. Úsalo para saber de qué va. |
| \`estado\` | pon \`revisado\` cuando lo tengas. Déjalo vacío si tienes dudas. |

## Reglas

1. **No toques las columnas \`clave\`, \`es\` ni \`en\`**, ni el orden de las filas.
   Ni añadas ni borres filas.
2. **No traduzcas lo que va entre \`{{\` y \`}}\`** — son huecos que rellena el
   programa. \`"Faltan {{n}} vueltas"\` → traduce la frase y deja \`{{n}}\` tal cual.
3. **Donde pone \`OK\`, \`PitWall\`, \`Excel\`, \`CSV\`, \`HTML\`, \`QR\`, \`PDF\`, \`PIN\`**,
   déjalo igual: son nombres propios o siglas.
4. **Los textos cortos son de botones o cabeceras de tabla.** Si te queda largo,
   la interfaz se rompe: mejor una palabra corta que una frase exacta.
5. **Los textos largos** (los que acaban en punto) son de ayuda o de avisos:
   ahí sí conviene una frase bien redactada.
6. **Si algo no se entiende**, déjalo en blanco y pon una nota. Es mejor una
   duda que una invención.

## Glosario

Términos ya fijados en el manual en italiano del proyecto. **Respétalos**, para
que la interfaz y el manual digan lo mismo.

| español | italiano | ojo |
|---|---|---|
| carrera | gara | |
| tanda | tanda | se mantiene igual (plural: *tande*) |
| manga | manche | |
| carril | corsia | nunca *carril* ni *carrera* |
| vuelta | giro | |
| piloto | pilota | |
| equipo | squadra | |
| coche | auto / vettura | *vettura* en textos largos |
| descanso | riposo | |
| salida | uscita | cuando es la vuelta lenta de salida |
| salida / arranque | partenza | cuando es el pistoletazo de salida |
| clasificación | classifica | |
| parrilla | griglia | la formación de salida |
| desempate | spareggio | |
| coma | virgola | **el tiempo de ventaja**, no el signo de puntuación |
| neumáticos | gomme | |
| semáforo | semaforo | |
| bandera | bandiera | |
| entrenamiento libre | allenamento libero | |
| vuelta fantasma | giro fantasma | vuelta inválida por debajo del mínimo |
| vuelta de bandera | giro di bandiera | la última, al caer la bandera |
| proyección | proiezione | la clasificación estimada |
| consistencia | consistenza | |
| media limpia | media pulita | |
| categoría | categoria | |
| turno | turno | turno de piloto (relevo) |
| resistencia | endurance | en títulos; *resistenza* en prosa |
| área / zona restringida | area riservata | |

Nota sobre **\`coma\`**: en PitWall no es puntuación. Es el tiempo que un coche
saca de ventaja a otro por haber cruzado antes la meta; se usa para desempatar.
En italiano el manual lo llama **virgola**.

## Cómo devolvérnoslo

Mándanos el mismo CSV con la columna rellena a **info.pitwall@gmail.com**.
Nosotros lo cargamos, comprobamos que no falte ni sobre nada y lo publicamos.
Si prefieres trabajar con Git, dímelo y te paso el fichero JSON directo.

${sinContexto ? `> Hay ${sinContexto} textos sin columna de \`contexto\`: son de pantallas que\n> todavía no están enlazadas. Si alguno no se entiende, pregúntanos.\n` : ''}`;
}

// ── Comandos ──────────────────────────────────────────────────────────────
function exportar() {
  const lang = opt('lang', 'it');
  const out  = path.resolve(ROOT, opt('out', path.join('.tmp', 'kit')));
  fs.mkdirSync(out, { recursive: true });

  const es = aplanar(leerLang('es') || {});
  const en = aplanar(leerLang('en') || {});
  const destino = aplanar(leerLang(lang) || {});
  const ctx = recolectarContexto();

  const claves = Object.keys(es).sort();
  const filas = claves.map(k => [
    k,
    es[k],
    en[k] || '',
    destino[k] || '',
    ctx[k] || '',
    '',                                  // estado: lo rellena el traductor
  ]);

  const csv = aCsv(filas, ['clave', 'es', 'en', lang, 'contexto', 'estado']);
  const fCsv = path.join(out, `pitwall-${lang}.csv`);
  fs.writeFileSync(fCsv, '﻿' + csv);          // BOM: Excel lo abre en UTF-8

  // La guía se genera junto al CSV para el envío por correo. En la carpeta del
  // repo NO, porque allí manda `traducciones/README.md` y serían dos documentos
  // diciendo lo mismo (y divergiendo).
  if (!argv.includes('--sin-guia')) {
    const fGuia = path.join(out, 'LEEME.md');
    fs.writeFileSync(fGuia, guia(lang, claves.length, filas.filter(f => !f[4]).length));
    console.log(`Guía   : ${path.relative(ROOT, fGuia)}`);
  }
  console.log(`CSV    : ${path.relative(ROOT, fCsv)}  (${claves.length} claves)`);
  console.log(`sin traducir (${lang} vacío o igual al español): ` +
    filas.filter(f => !f[3] || f[3] === f[1]).length);
  console.log(`sin contexto: ${filas.filter(f => !f[4]).length}`);
  return fCsv;
}

function importar() {
  const lang = opt('lang', 'it');
  const csv  = opt('csv');
  if (!csv) { console.error('Falta --csv <fichero>'); process.exit(2); }

  const filas = deCsv(fs.readFileSync(path.resolve(ROOT, csv), 'utf8'));
  const cab = filas[0].map(s => s.trim().toLowerCase());
  const iClave = cab.indexOf('clave');
  const iLang  = cab.indexOf(lang);
  if (iClave === -1 || iLang === -1) {
    console.error(`El CSV tiene que traer las columnas "clave" y "${lang}". Encontradas: ${cab.join(', ')}`);
    process.exit(2);
  }

  const actual = aplanar(leerLang(lang) || {});
  const es = aplanar(leerLang('es') || {});
  let puestas = 0, vacias = 0, desconocidas = [];

  for (const f of filas.slice(1)) {
    const clave = f[iClave];
    const valor = (f[iLang] || '').trim();
    if (!clave) continue;
    if (!(clave in es)) { desconocidas.push(clave); continue; }
    if (!valor) { vacias++; continue; }
    if (actual[clave] !== valor) { actual[clave] = valor; puestas++; }
  }

  fs.writeFileSync(path.join(DIR_LOCALES, lang + '.json'), JSON.stringify(anidar(actual), null, 2) + '\n');
  console.log(`${lang}.json escrito: ${puestas} valores cambiados, ${vacias} en blanco (se dejan como estaban)`);
  if (desconocidas.length) {
    console.log(`OJO: ${desconocidas.length} claves del CSV no existen en el diccionario (¿de una versión distinta?):`);
    desconocidas.slice(0, 10).forEach(k => console.log('   ' + k));
  }
  console.log('Revisa el resultado con:  node scripts/i18n-kit.js check --lang ' + lang);
}

function comprobar() {
  const base = aplanar(leerLang('es') || {});
  const claves = Object.keys(base);
  console.log(`es.json: ${claves.length} claves\n`);
  for (const lang of idiomas().filter(l => l !== 'es')) {
    const d = aplanar(leerLang(lang) || {});
    const faltan = claves.filter(k => !(k in d));
    const sobra  = Object.keys(d).filter(k => !(k in base));
    const iguales = claves.filter(k => d[k] === base[k]);
    console.log(`${lang}.json: ${Object.keys(d).length} claves · faltan ${faltan.length} · sobran ${sobra.length} · sin traducir (igual que español) ${iguales.length}`);
    if (sobra.length) sobra.slice(0, 5).forEach(k => console.log(`     sobra: ${k}`));
  }
  const ctx = recolectarContexto();
  const sinUso = claves.filter(k => !ctx[k]);
  console.log(`\nclaves que ninguna vista usa: ${sinUso.length}`);
  if (sinUso.length) sinUso.slice(0, 8).forEach(k => console.log('   ' + k));
}

if (cmd === 'export')      exportar();
else if (cmd === 'import') importar();
else if (cmd === 'check')  comprobar();
else {
  console.log('Uso:');
  console.log('  node scripts/i18n-kit.js export [--lang it] [--out DIR]');
  console.log('  node scripts/i18n-kit.js import --lang it --csv <fichero>');
  console.log('  node scripts/i18n-kit.js check  [--lang it]');
  process.exit(2);
}
