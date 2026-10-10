# Traducciones de PitWall

PitWall habla **español** e **inglés**, y queremos añadir más idiomas. Si te
apetece traducirlo o revisar lo que ya hay, **no hace falta que sepas programar
ni que uses Git**: es rellenar una columna de una hoja de cálculo y mandarnos el
fichero por correo.

Gracias por adelantado.

---

## Qué idiomas hay y cuáles faltan

| Idioma | Estado |
|---|---|
| Español (`es`) | Completo — es el original |
| Inglés (`en`) | Completo |
| Italiano (`it`) | **Pendiente** — lo estamos preparando |
| Otros | Añadibles: francés, portugués, alemán… lo que haga falta |

---

## Cómo colaborar, paso a paso

### 1. Descarga el fichero

Ve a la carpeta [`traducciones/`](.) y abre el CSV del idioma que te interese
(por ejemplo [`pitwall-it.csv`](pitwall-it.csv)).

Arriba a la derecha del contenido verás un botón de descarga
(**Download raw file**, el icono de la flecha hacia abajo). Pulsa ahí.

> ¿Prefieres traducir un idioma que aún no está? Pide el fichero escribiendo a
> **info.pitwall@gmail.com** y te lo mandamos con tu idioma.

### 2. Ábrelo con tu programa de hojas de cálculo

Excel, LibreOffice o Google Sheets. Es un CSV separado por **punto y coma**; si
tu programa te pregunta, elige eso.

Verás una tabla con estas columnas:

| columna | qué es | ¿se toca? |
|---|---|---|
| `clave` | identificador interno del texto | **NO** |
| `es` | el texto en español, que es el original | **NO** |
| `en` | el inglés que ya existía | **NO** |
| `it` (o tu idioma) | **aquí escribes tú** | **SÍ** |
| `contexto` | en qué pantalla de la app sale | **NO** (es para ti) |
| `estado` | marca `revisado` cuando lo tengas | sí, si quieres |

**La columna de tu idioma ya viene rellena con el español**, para que vayas
corrigiendo en vez de traducir de cero. Donde ya esté bien, déjalo.

### 3. Rellena tu columna

Ayúdate de la columna `en`: es la traducción inglesa que ya existe, y muchas
veces aclara el sentido. Y de `contexto`, que te dice en qué pantalla aparece.

Cuando termines una fila, pon `revisado` en `estado`. Si algo no lo tienes claro,
déjalo en blanco y avísanos: **es mejor una duda que una invención.**

### 4. Mándanoslo

Adjunta el fichero (o el enlace de tu Google Sheets) a:

**info.pitwall@gmail.com**

Nosotros lo cargamos, comprobamos que no falte ni sobre nada y lo publicamos.
Te avisamos cuando esté, y si quieres te acreditamos en el CHANGELOG.

---

## Reglas

1. **No toques las columnas `clave`, `es` ni `en`**, ni el orden ni el número de
   filas. Si necesitas añadir una nota, usa la columna `estado`.
2. **No traduzcas lo que va entre `{{` y `}}`** — son huecos que rellena el
   programa después:
   - `Faltan {{n}} vueltas` → `Mancano {{n}} giri` (deja `{{n}}` tal cual)
3. **Deja igual los nombres propios y las siglas**: `PitWall`, `Excel`, `CSV`,
   `HTML`, `QR`, `PDF`, `PIN`, `OK`.
4. **Los textos cortos son de botones y cabeceras de tabla.** Si te queda largo,
   la interfaz se rompe: mejor una palabra corta que una frase exacta.
5. **Los textos largos** (los que acaban en punto) son de ayuda o de avisos: ahí
   sí conviene redactar bien.

---

## Glosario

Esto es lo más importante del documento.

PitWall es un programa de **cronometraje de slot cars**, y algunas palabras
significan aquí algo muy concreto. Los términos de abajo ya están fijados en los
manuales del proyecto, así que **respétalos**: la interfaz y el manual tienen que
decir lo mismo.

### Términos del programa

| español | italiano | ojo con esto |
|---|---|---|
| carrera | **gara** | |
| tanda | **tanda** | se mantiene igual (plural: *tande*) |
| manga | **manche** | cada una de las carreras cortas de una tanda |
| carril | **corsia** | nunca *carril* ni *carrera* |
| vuelta | **giro** | |
| piloto | **pilota** | |
| equipo | **squadra** | |
| coche | **auto** / **vettura** | *vettura* en textos largos |
| descanso | **riposo** | el carril que no corre esa manga |
| clasificación | **classifica** | |
| parrilla | **griglia** | la formación de salida |
| desempate | **spareggio** | |
| neumáticos | **gomme** | |
| semáforo | **semaforo** | |
| bandera | **bandiera** | |
| entrenamiento libre | **allenamento libero** | |
| proyección | **proiezione** | la clasificación estimada |
| consistencia | **consistenza** | |
| media limpia | **media pulita** | |
| categoría | **categoria** | |
| turno | **turno** | el relevo de un piloto por otro |
| resistencia | **endurance** | en títulos; *resistenza* en prosa |

### Dos palabras que se traducen mal si no se sabe

**Coma** → **virgola**. No es el signo de puntuación. En PitWall la *coma* es el
**tiempo de ventaja** que un coche saca a otro por haber cruzado antes la meta
cuando van igualados a vueltas. Se usa para desempatar. El manual en italiano ya
lo llama *virgola*.

**Salida** tiene dos sentidos y en italiano son palabras distintas:

- la **vuelta de salida** desde boxes (una vuelta lenta que no cuenta) → **uscita**
- el **arranque de la carrera** (cuando se da la salida) → **partenza**

Si dudas entre las dos, fíjate en la columna `contexto`.

---

## Preguntas

Cualquier duda, **info.pitwall@gmail.com**. Si algo no se entiende, pregunta
antes de inventarlo: preferimos un texto sin traducir a uno que confunda al
operador en mitad de una carrera.
