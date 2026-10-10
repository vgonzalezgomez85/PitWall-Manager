# Protocolos de cuentavueltas que entiende TicTacSlot

Especificación para implementar los decodificadores en PitWall. Cubre los cinco
sistemas del desplegable "Cuentavueltas" de TicTacSlot:

| Opción en TicTacSlot | Código interno | Transporte |
|---|---|---|
| TicTac-USB | 115 | USB HID (VID `0x04D8`, PID `0x0001`) |
| DS-300 | 300 | Puerto serie |
| DS-200 | 200 | Puerto serie |
| DS-030 | 30 | Puerto serie |
| DS-080 | 80 | Puerto serie |

## De dónde sale esto y cuánto fiarse

Todo se ha sacado desensamblando `TicTacSlot.exe` (Visual Basic 6 nativo, versión
de 2016) el 10-oct-2026. El exe es el programa del fabricante del TicTac-USB.
La trama TicTac-USB también se contrastó con informes HID capturados del
aparato real.

Cada dato lleva un nivel de confianza:

- **[código]**: el exe lo comprueba o lo usa de forma explícita.
- **[deducido]**: se infiere del código, pero el exe no lo usa directamente.
  Hay que validarlo con un aparato o con una captura.

Los cuatro DS **no** se han probado contra un aparato real.

---

## 1. Familia DS (DS-300, DS-200, DS-030, DS-080)

### 1.1 Puerto serie

- 8 bits, sin paridad, 1 bit de parada (8N1).
- Velocidad configurable. Según la ayuda del programa, el DS-300 va a 56000
  baudios y el resto de modelos DS a 4800. Conviene que PitWall deje elegirla.

### 1.2 Framing [código]

Trama de **21 bytes**:

```
[0]  = 0xE0   inicio
[20] = 0xEB   fin
```

Algoritmo de TicTacSlot sobre el buffer de recepción:

1. Avanzar hasta encontrar `0xE0` con al menos 20 bytes detrás.
2. Si `buf[p+20] != 0xEB`, descartar ese `0xE0` y seguir buscando.
3. Validar el checksum (1.3). Si falla, descartar la trama.
4. **Filtro de duplicados:** si `[1]` es igual al `[1]` de la última trama
   aceptada de ese circuito, ignorarla. El DS repite tramas.

### 1.3 Checksum [código]

```
checksum = (suma de [1]..[17] + [19]) & 0xFF      → debe ser igual a [18]
```

No entran `[0]` (`0xE0`), `[18]` (el propio checksum) ni `[20]` (`0xEB`).

### 1.4 Campos

| Byte | Contenido | Confianza |
|---|---|---|
| `[0]` | `0xE0` | código |
| `[1]` | secuencia (para el filtro de duplicados) | código |
| `[2..6]` | identificador del aparato; en un DS-300 real `15 03 00 04 4C` (PitWall lo usa para distinguir circuitos). TicTacSlot no lo comprueba | captura real (PitWall) |
| `[4]` | **solo DS-080: circuito** (`2` = circuito 2; otro valor = circuito 1) | código |
| `[7]` | **tipo**: `0x1B` = cruce; otro valor = evento (ver 1.6) | código |
| `[8]` | **código de evento** (solo si `[7] != 0x1B`) | código |
| `[9..11]` | datos del evento `0xA1` (ver 1.6) | código |
| `[10]` | **carril** en tramas de cruce (ver 1.5) | código |
| `[11]` | vueltas, centenas, en BCD (TicTacSlot lo suma). En un DS-300 real vale siempre `00`: el contador da la vuelta a 100 | código + captura real |
| `[12]` | vueltas, unidades (0..99), en BCD → `vueltas = bcd([11])*100 + bcd([12])`. Confirmado en captura real: pasa de `09` a `10` | código + captura real |
| `[13]` | `0x00` | deducido |
| `[14]` | tiempo de vuelta: minutos, en BCD | deducido |
| `[15]` | tiempo de vuelta: segundos, en BCD | deducido |
| `[16]` | tiempo de vuelta: centésimas, en BCD | deducido |
| `[17]` | tiempo de vuelta: nibble alto = milésimas, nibble bajo = diezmilésimas (`… + bcd([17]) * 0.1` ms) | deducido + DS300-protocolo.md |
| `[18]` | checksum | código |
| `[19]` | `0x00` en un DS-300 real (el simulador de TicTacSlot pone `0xCE`; entra en su checksum) | captura real (PitWall) |
| `[20]` | `0xEB` | código |

`bcd(x) = (x >> 4) * 10 + (x & 0x0F)`

**Primer cruce:** `[14..17]` = `AA AB AA AA` (nibbles no BCD) = no hay tiempo de vuelta todavía. Lo documenta PitWall con capturas reales y es también la plantilla que usa TicTacSlot.

**Sobre `[14..17]`:** TicTacSlot **no lee estos bytes**. Cuando le llega una
trama de cruce, calcula el tiempo de vuelta con `GetTickCount()` del PC
(diferencia entre dos tramas aceptadas del mismo carril, en ms). El formato de
la tabla sale de la función con la que el propio fabricante convierte la trama
USB a una trama DS-300, así que es su idea de cómo va el tiempo en un DS-300.
Recomendación para PitWall: decodificar `[14..17]` y, si el valor es razonable,
usarlo en vez de la hora de llegada. Validarlo con un DS real antes de fiarse.

### 1.5 Carril según el modelo [código]

| Modelo | `[10]` → carril |
|---|---|
| DS-300, DS-030, DS-080 | máscara de bits: `0x80`→1, `0x40`→2, `0x20`→3, `0x10`→4, `0x08`→5, `0x04`→6, `0x02`→7, `0x01`→8. `0xAC` también se trata como carril 1. Otro valor: TicTacSlot registra "Pista incorrecta" y descarta la trama. |
| DS-200 (2 carriles) | `0x00` o `0x01`→1, `0x02`→2. Otro valor: "DS-200: Pista incorrecta". |

**Dos circuitos:** TicTacSlot maneja dos circuitos, cada uno con su puerto
COM, salvo el DS-080, que lleva los dos por un solo puerto usando `[4]`. Los
carriles del circuito 2 se numeran a continuación de los del circuito 1:
`carril_global = carril + nº de carriles del circuito 1`.

### 1.6 Eventos (`[7] != 0x1B`) [código]

| `[8]` | Evento | Texto que escribe TicTacSlot en su registro |
|---|---|---|
| `0xA1` | **Arranque de manga por tiempo** | (arranca el crono de la manga) |
| `0xA3` | **Inicio** | "INICIO DE MANGA" / "Inicio del Parcial" / "Final de PAUSA" |
| `0xA4` | **Final** | "FINAL" del parcial / "Carrera Finalizada" |
| `0xA5` | **Pausa** | "Inicio de PAUSA" |
| `0xA7` | **Stop** | "Tecla STOP" |

Además, según las capturas reales de PitWall (`DS300-protocolo.md`), el DS-300 manda `0xA2` (confirmación tras el GO), `0xA6` (fin de pausa) y `0xC0` (estado periódico, `[14]` = minutos transcurridos). **TicTacSlot ignora los tres**: para él, la reanudación tras una pausa es `0xA3`.

`0xA1` lleva la duración de la manga en BCD. El formato depende de `[7]`
(nibbles: `H` = nibble alto, `L` = nibble bajo):

| `[7]` | Duración en segundos | Resolución |
|---|---|---|
| `0x3A` | `H([9])*3600 + L([9])*600 + H([10])*60 + L([10])*10` | 10 s |
| `0x3E` | `L([9])*3600 + H([10])*600 + L([10])*60 + H([11])*10` | 10 s |
| otro | 0 (sin duración) | — |

**⚠ Discrepancia con PitWall.** PitWall calcula `mins = bcd([9])*100 + bcd([10])` tanto para `0x3E` como para `0x3A`. Para mangas de menos de 60 min con `0x3E` sale lo mismo. Pero:

- **`0x3A`**: su trama de club `3A A1 00 60` da **60 min** con PitWall y **6 min** con TicTacSlot (`H([10])*60 + L([10])*10` = 360 s). Hay que mirar cuánto duró de verdad esa manga.
- **`0x3E` de 60 min o más**: TicTacSlot lee `[9]` como horas; PitWall, como centenas de minuto.

Leído como dígitos: con `0x3A`, `[9][10]` = `H MM S` (hora, minutos y decenas de
segundo); con `0x3E`, `[9]` = `_H`, `[10]` = `MM` y `[11]` = `S_`.

### 1.7 Ejemplos (checksum correcto)

```
Cruce DS-300, carril 3, vuelta 12, tiempo 0:12.845
E0 05 15 00 00 00 00 1B 00 00 20 00 12 00 00 12 84 50 1B CE EB

Cruce DS-200, carril 2, vuelta 105, tiempo 0:13.012
E0 06 15 00 00 00 00 1B 00 00 02 01 05 00 00 13 01 20 40 CE EB

Cruce DS-080, circuito 2, carril 1, vuelta 3
E0 07 15 00 02 00 00 1B 00 00 80 00 03 00 00 09 87 60 7A CE EB

INICIO   E0 08 15 00 00 00 00 00 A3 00 00 00 00 00 00 00 00 00 8E CE EB
PAUSA    E0 09 15 00 00 00 00 00 A5 00 00 00 00 00 00 00 00 00 91 CE EB
FINAL    E0 0A 15 00 00 00 00 00 A4 00 00 00 00 00 00 00 00 00 91 CE EB
STOP     E0 0B 15 00 00 00 00 00 A7 00 00 00 00 00 00 00 00 00 95 CE EB

Arranque por tiempo, 1 h 05 min (formato 0x3E)
E0 0C 15 00 00 00 00 3E A1 01 05 00 00 00 00 00 00 00 D4 CE EB
```

Los ejemplos están construidos a partir de esta especificación, no capturados
de un aparato.

---

## 2. TicTac-USB (código 115)

### 2.1 Transporte

- Dispositivo **USB HID**, no puerto serie: clase 3, página de uso `0xFFA0`
  propietaria, VID `0x04D8` (1240), PID `0x0001`. El sistema operativo no le
  crea ningún `/dev/tty*` ni `COMx`.
- Informes de entrada de **16 bytes**, uno por trama. En Windows la API HID
  antepone un byte de ID de informe `0x00`; `hidapi`/`node-hid` lo quitan. Los
  índices de abajo van **sin** ese byte.
- Las tramas llegan ya separadas (una por informe). Si se pasan por un puerto
  serie virtual, como hace el puente de este repo, hay que volver a trocearlas:
  buscar `0xC0` y comprobar que `[2]` es un tipo conocido (`extraerTrama` en
  `protocol.js`).

### 2.2 Cabecera [código]

| Byte | Contenido |
|---|---|
| `[0]` | `0xC0` sincronismo (TicTacSlot no lo comprueba) |
| `[1]` | secuencia, +1 por trama |
| `[2]` | **tipo**: `0x1B` cruce, `0x1C` evento |

### 2.3 Tipo `0x1B`: cruce [código]

| Byte | Contenido |
|---|---|
| `[3]` | `0x00` |
| `[4]` | carril (1..8) |
| `[5..6]` | nº de vuelta del carril, uint16 big-endian (TicTacSlot la limita a 9999) |
| `[7..8]` | reloj: minutos, uint16 big-endian |
| `[9..10]` | reloj: milisegundos dentro del minuto (0..59999), uint16 big-endian |
| `[11]` | reloj: décimas de milisegundo (0..9) |
| `[12..15]` | `0x00` |

```
reloj_ms = min * 60000 + ms + decimas / 10
```

- **El reloj NO es un contador lineal de ms.** Leer `[8..10]` como 24 bits da
  un salto falso de 5536 ms en cada cambio de minuto. Comprobado con una captura
  real de 20 cruces: con esta fórmula los tiempos de vuelta cuadran con la hora
  de llegada al PC a ±2 ms.
- El reloj es libre: lo que importa es la diferencia entre cruces.
  `tiempo_vuelta = reloj(cruce n) − reloj(cruce n−1) del MISMO carril`, módulo
  65536 × 60000 ms.
- TicTacSlot hace esa resta con el reloj del aparato para construir la trama
  DS equivalente, y luego (igual que con los DS) usa la hora de llegada al PC.
  PitWall debería usar el reloj del aparato, que es más preciso.

### 2.4 Tipo `0x1C`: evento [código]

| `[3]` | Evento | Datos |
|---|---|---|
| `0xA1` | Arranque por tiempo | `[4]` = minutos, `[5]` = horas de duración (binario, no BCD) |
| `0xA3` | Inicio (o fin de pausa) | — |
| `0xA4` | Final | — |
| `0xA5` | Pausa | — |
| `0xA7` | Stop | — |

Mismos códigos que `[8]` en los DS: TicTacSlot traduce el evento USB a la
trama DS correspondiente, con `[7] = 0x3E` en el caso de `0xA1`.

### 2.5 PC → aparato [código, sin uso confirmado]

Informe de salida `00 BB <carril>` (`00` es el ID de informe; el resto del
informe va a `0xFF`). **Observado** con TicTacSlot conectado al emulador:
lo manda en el **primer paso de cada carril** tras arrancar la manga, una vez
por carril. Puede que sirva para que el aparato reinicie la cuenta de ese
carril (eso encajaría con que en la captura real cada carril empezara en 1 en
un momento distinto), pero no está confirmado. Una vez se vio también un
informe `E0 FF FF …` justo después de un INICIO, sin poder reproducirlo.
PitWall no necesita mandar nada para leer.

### 2.6 Ejemplos

```
Cruce: carril 3, vuelta 12, reloj 754321,5 ms (12 min 34321 ms 5 décimas)
C0 05 1B 00 03 00 0C 00 0C 86 11 05 00 00 00 00

PAUSA
C0 06 1C A5 00 00 00 00 00 00 00 00 00 00 00 00

Arranque por tiempo, 30 min
C0 07 1C A1 1E 00 00 00 00 00 00 00 00 00 00 00
```

Implementación de referencia en JavaScript: `protocol.js` de este repo
(`decodificar`, `extraerTrama`, `deltaReloj`).

---

## 3. Modelo común de eventos para PitWall

Las dos familias se pueden normalizar al mismo modelo:

```
Cruce   { circuito, carril, vuelta, tiempoVueltaMs?, relojAparatoMs? }
Evento  { tipo: 'arranque_tiempo' | 'inicio' | 'final' | 'pausa' | 'stop',
          duracionS? }      // duracionS solo en arranque_tiempo
```

| Campo | DS | TicTac-USB |
|---|---|---|
| carril | `[10]` según modelo (1.5) | `[4]` |
| vuelta | BCD `[11..12]` | uint16 BE `[5..6]` |
| tiempo de vuelta | BCD `[14..17]` [deducido] o la hora de llegada | resta de relojes del mismo carril |
| evento | `[8]` si `[7] != 0x1B` | `[3]` si `[2] == 0x1C` |

## 4. Pendiente de confirmar con aparatos reales

0. Quién tiene razón con la duración del GO `0x3A` (ver 1.6).
1. El formato de `[14..17]` en los DS.
2. La velocidad real del DS-300 (56000 según la ayuda; puede que sea 57600).
3. Qué hace el aparato con su contador de vueltas en INICIO, PAUSA y STOP.
4. Para qué sirve el comando USB `BB <carril>` (se manda en el primer paso de
   cada carril) y el `E0 …` visto una vez.

## 5. Banco de pruebas con el TicTacSlot real

`tools/mchid-falso/` en este repo contiene una `mcHID.dll` falsa que conecta
una copia de TicTacSlot al emulador sin hardware (ver su `LEEME.md`).
Comprobado el 10-oct-2026: TicTacSlot cuenta las vueltas y los tiempos de las
tramas de cruce del emulador, y reacciona a INICIO, PAUSA y FINAL.
