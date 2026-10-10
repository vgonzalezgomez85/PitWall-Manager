# Traducción al italiano — lo que queda

Documento de trabajo. Estado a **2026-10-10**, tras las versiones v1.51.0 a
v1.52.3.

> **Actualización v1.54.0 (2026-10-10): los bloques A–E están HECHOS.**
> Todo el texto visible sale del diccionario (2.266 claves en `es`/`en`/`it`). Las
> dos decisiones de abajo se tomaron así: **(1)** el inglés de los textos nuevos lo
> tradujo el asistente (opción b, que revise un nativo); **(2)** el diagnóstico y el
> visor de tramas **entran**. Verificado: 0 claves sin resolver, 528 scripts
> compilan, el texto visible en español idéntico al de antes, 536 tests.
>
> Lo que queda:
> - **Traducir el italiano**: 1.629 claves siguen en español provisional. Kit
>   regenerado en `traducciones/pitwall-it.csv`; hay que avisar al traductor.
> - **Revisión nativa** del resumen del EULA en italiano y del inglés nuevo.
> - «Tanda» en inglés no es uniforme en las claves antiguas (Heat / Round / Group).
> - El kit marca 551 claves «sin uso»: muchas se montan en tiempo de ejecución
>   (`_admin.layout_` + id, `drivers.categories.` + cat…); antes de borrar ninguna,
>   comprobarla a mano.
> - Prueba a mano en los tres idiomas.

El objetivo es que **todo el texto visible de PitWall salga del diccionario** de
`src/locales/`, para poder traducir la app. El italiano es el primer idioma nuevo;
el kit para quien traduzca está en [`../traducciones/`](../traducciones/).

---

## Lo que ya está hecho

Los **ternarios de idioma**, que eran el grueso: 1.914 sitios donde el texto se
elegía a mano con `lang === 'es' ? 'Manga' : 'Heat'`. Ese sistema no admitía un
tercer idioma —con `?lang=it` unas ramas caían a inglés y otras a español— y era
la razón de que la app no se pudiera traducir.

Convertidos y verificados:

| | |
|---|---|
| Servidor (vistas) | 1.771 |
| Cliente (dentro de `<script>`) | 297 |
| Multilínea | 96 |
| Controllers y servicios | 110 |
| Con números dentro (huecos `{{n}}`) | 52 |

El diccionario pasa de **98 claves a ~1.500**, y hay tres idiomas dados de alta
(`es`, `en`, `it`; el italiano todavía muestra español).

**Verificado en cada paso**: las 148 pantallas del arnés salen con el HTML
idéntico, los scripts del navegador compilan y los 485 tests pasan.

---

## Lo que queda: ~484 sitios

| Bloque | Sitios | Dónde | Dificultad |
|---|---|---|---|
| **A** · Ternarios difíciles | 23 | 15 ficheros | Media |
| **B** · Texto a pelo en plantillas | 328 | 42 vistas | Alta |
| **C** · Cadenas de UI en `<script>` | 61 | Vistas con JS | Media |
| **D** · Cadenas en controllers/services | 42 | ~15 ficheros | Media |
| **E** · `confirm()` y `alert()` | 30 | Vistas | Baja |

No cuentan —y no deben contarse— los comentarios del código, los `console.log`
(hay ~32) ni los identificadores técnicos.

### El bloque B está muy concentrado

10 ficheros tienen 258 de los 328 (el 79%). No son 42 ficheros: son **10 unidades
grandes y una cola de 32 ficheros con 1-8 textos cada uno**.

```
  61  license/eula.ejs          el EULA entero (ya tiene español e inglés dentro)
  47  diagnostico/index.ejs     la pantalla entera, sin traducir nunca
  42  lap/team.ejs              Lap web entero, sin traducir nunca
  20  races/sim-confirm.ejs     carrera simulada
  15  import/tanda.ejs
  15  live-stats/show.ejs
  14  settings/index.ejs
  13  diagnostico/tramas.ejs
  13  races/sim-panel.ejs
  12  races/sim-new.ejs
      ── 258 ──
```

---

## Orden propuesto

### A. Los 23 ternarios que quedan

Son los que la cosechadora no puede hacer porque sus ramas no son texto plano:

- **concatenación**: `lang === 'es' ? 'Manga ' + n : 'Heat ' + n`
  → `t('clave', { n })` con el texto `Manga {{n}}`
- **selección de campo**: `lang === 'es' ? c.label_es : c.label_en`
  → lo correcto es que la categoría traiga una `label_key` y usar `t(c.label_key)`
- **anidados** y algunos partidos de forma rara

Se hacen a mano, uno a uno. **Va primero porque cierra la etapa de los
ternarios**: después de esto la cosechadora pasa a ser herramienta de
mantenimiento y no hay nada más que mecanizar.

### B, C, D, E

Ver la tabla de arriba. Orden sugerido por relación esfuerzo/visibilidad:

1. **E (30)** — el más pequeño y el que más canta: hoy los `confirm()` están en
   español **aunque uses la app en inglés**.
2. **D (42)** — los avisos del servidor. Varios errores ya llevan un código
   (`RaceArchiveError('bad_file', …)`), así que conviene traducir **por código y
   no por frase**: si mañana cambia el texto español, la traducción no se rompe.
3. **C (61)** — el JS del navegador, mecánico con `I18N.t`.
4. **B (328)** — el tramo largo, vista por vista.

### Cierre

- Regenerar el kit con el diccionario completo y **avisar al traductor**.
- Prueba a mano en los tres idiomas: es lo único que valida que la traducción se
  ve bien de verdad.
- Actualizar `AGENTS.md`, `README.md` y `CHANGELOG.md`.

---

## Dos decisiones pendientes

### 1. El inglés de estos textos no existe

Los ternarios traían **español e inglés**. Los 328 textos a pelo **solo tienen
español**, así que al meterlos en el diccionario el inglés se queda en español
hasta que alguien lo traduzca. Opciones:

- **(a)** meterlos en español y que **el traductor haga también el inglés** — más
  trabajo para él, pero con criterio nativo;
- **(b)** traducirlos al inglés en el mismo paso y que el voluntario **revise**;
- **(c)** dejarlo así a propósito, aceptando huecos en español en la versión
  inglesa (es lo que ya pasa hoy en `/diagnostico`).

### 2. ¿Entran las pantallas de diagnóstico?

Son 60 sitios: `diagnostico/index` (47) y `diagnostico/tramas` (13). Son
herramientas de desarrollador, no de club, y el visor de tramas ya está declarado
fuera de alcance en `AGENTS.md`.

---

## Cómo se verifica (y por qué así)

La suite **no renderiza vistas** —salvo un test— así que el refactor va a ciegas
sin las herramientas de abajo. Las tres se quedan en el repo.

```bash
# 1. Instantáneas HTML: el HTML servido tiene que salir IDÉNTICO
node scripts/i18n-snapshot.js capture --out .tmp/i18n/antes
#   ...hacer el cambio...
node scripts/i18n-snapshot.js capture --out .tmp/i18n/despues
node scripts/i18n-snapshot.js compare --a .tmp/i18n/antes --b .tmp/i18n/despues

# 2. Cosechadora: qué queda y qué no puede convertir (informe, no toca nada)
node scripts/i18n-extract.js --dry
node scripts/i18n-extract.js --apply --glob 'src/views/lo-que-sea.ejs'

# 3. Kit del traductor
node scripts/i18n-kit.js export --lang it --out traducciones --sin-guia
node scripts/i18n-kit.js check
```

Además, tras cada bloque:

- **Sintaxis de los scripts embebidos**: el arnés no ejecuta JavaScript. Extraer
  los `<script>` de las capturas y pasarles `node --check` caza errores que el
  HTML no muestra. (Ojo: los `<script type="application/json">` son datos, no
  código; hay que saltarlos.)
- **Claves sin resolver**: que ninguna llamada `t(...)`/`req.t(...)`/`I18N.t(...)`
  pida una clave que no esté en el diccionario. Si falta, en pantalla sale la
  clave cruda.
- **`npm test`** (485).

---

## Trampas que ya costaron tiempo

Van aquí para no repetirlas. Todas se descubrieron a base de golpes.

**`t` está pillado.** En las vistas `t` es el traductor, así que una variable
local con ese nombre lo sombrea: `tandas.forEach(t => …)` hizo que `t('clave')`
llamara al bucle, y salía un 500 al renderizar. Y en el **JS de cliente hay una
docena** de sitios con su propio `t`, por eso el ayudante del navegador se llama
**`I18N.t`** y no `t`.

**La cosechadora se salta cosas EN SILENCIO.** Solo mira ramas entre comillas.
Los ternarios con plantilla (`` ? `${n} coches` : … ``) no los convierte **ni los
reporta**. Llegué a dar por hecho que no quedaba ninguno cuando quedaban 99.
**Cuando dudes, cuenta a mano en vez de fiarte del informe de la herramienta.**

**Las comillas escapadas.** `'PC\'s'` metía el backslash en el diccionario y se
pintaba `PC\&#39;s`. Hay que desescapar al cosechar.

**La misma frase en español puede tener dos ingleses.** `En curso` es «In
progress» en el inicio y «Active» en la lista de carreras. Deduplicar por el
texto español se come una de las dos.

**Las clases CSS no son texto.** `lang === 'es' ? 'btn--active' : ''` elige una
clase, no una traducción. Traducirlo borra la clase y descuadra el diseño.

**Los códigos de idioma tampoco.** `? 'es-ES' : 'en-US'` es un locale: va por
`src/utils/locale.js`, no por el diccionario.

**Un PTY abierto con `fs.openSync` se come bytes.** No es de este trabajo, pero
está relacionado: deja el terminal en modo cocinado y la disciplina de línea
elimina `0x0F` (VDISCARD) y `0x16` (VLNEXT). Usar `serialport`.

---

## Glosario

En [`../traducciones/README.md`](../traducciones/README.md). Lo importante:
«manga» → *manche*, «carril» → *corsia*, y sobre todo **«coma» → *virgola***, que
en PitWall no es puntuación sino el **tiempo de ventaja** para desempatar.
