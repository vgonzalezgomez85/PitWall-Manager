# Protocolo DS-300 — Referencia de tramas

Documento técnico basado en:
- `info para proyecto infolap slot/ds-300 lecturas.csv` — tramas anotadas byte a byte
- `info para proyecto infolap slot/RegistroCarrera/RegistroCarrera.txt` — captura cruda de puerto serie con timestamps
- `info para proyecto infolap slot/RegistroCarrera/Registro Sucesos.txt` — log de alto nivel del software TicTacSlot 5.8.8
- `src/services/SerialService.js` — implementación actual de decodificación

---

## Características del enlace serie

| Parámetro | Valor |
|-----------|-------|
| Velocidad | 56 000 baud (fallback: 57 600 en puertos virtuales) |
| Formato | 8N1 |
| Conector | USB-Serial (adaptador CH340 u similar) |
| Delimitación de tramas | Silencio > 75 ms entre bytes → nueva trama. **Además** se re-separan ráfagas: ver "De-merge de ráfagas" más abajo |

---

## Estructura de trama — 21 bytes

```
Byte:  B0   B1   B2   B3   B4   B5   B6   B7   B8   B9   B10  B11  B12  B13  B14  B15  B16  B17  B18  B19  B20
       E0  [cnt] 15   03   00   04   4C  [cls][typ] [?] [lane][00] [lap][00] [min][sec][cen][dmil][chk] 00   EB
```

| Byte | Nombre | Descripción |
|------|--------|-------------|
| B0   | `START` | Siempre `0xE0`. Inicio de trama. |
| B1   | `cnt`   | Contador de secuencia, `0x00`–`0xFF`, rollover. Incremental por trama. |
| B2–B6 | `devID` | Identificador fijo del dispositivo: `15 03 00 04 4C`. Igual para todas las tramas de una misma unidad DS-300. |
| B7   | `cls`   | Clase de trama (ver tabla más abajo). |
| B8   | `typ`   | Tipo de evento (ver tabla más abajo). |
| B9   | —       | Reservado / siempre `0x00` en las tramas observadas. En la trama GO contiene las decenas de minutos (BCD). |
| B10  | `lane`  | Bitmask de carril (cruce de carril) o duración en minutos (trama GO). `0x00` en tramas de control. |
| B11  | —       | Reservado / siempre `0x00`. |
| B12  | `lap`   | Número de vuelta en la manga actual (0x01, 0x02…). |
| B13  | —       | Reservado / siempre `0x00`. |
| B14  | `min`   | Minutos del tiempo de vuelta, codificación BCD. |
| B15  | `sec`   | Segundos del tiempo de vuelta, BCD. |
| B16  | `cen`   | Centésimas de segundo, BCD (rango 00–99). |
| B17  | `dmil`  | Diezmilésimas de segundo, BCD (menor precisión). |
| B18  | `chk`   | Checksum de integridad (ver fórmula abajo). |
| B19  | —       | Siempre `0x00`. |
| B20  | `END`   | Siempre `0xEB`. Fin de trama. |

---

## Checksum (B18)

```
B18 = (B1 + B2 + B3 + ... + B17) mod 256
```

Suma de los bytes B1 a B17 (17 bytes), resultado truncado a 8 bits. B0 (0xE0) y B20 (0xEB) **no** entran en el cálculo.

**Verificación con `vuelta 2` (4,57 s):**

```
Bytes B1-B17: 36 15 03 00 04 4C 1B A9 00 40 00 02 00 00 04 57 88
Suma decimal: 54+21+3+0+4+76+27+169+0+64+0+2+0+0+4+87+136 = 647
647 mod 256 = 135 = 0x87  ✓ (B18 del CSV = 87)
```

---

## Clases de trama (B7)

| B7 | Clase | Significado |
|----|-------|-------------|
| `0x1B` | Cruce de carril | B10 contiene el bitmask de carril; B12–B17 contienen vuelta y tiempo. |
| `0x3E` | Señal GO | Inicio de carrera. Acompañado de B8=`0xA1`. |
| `0x00` | Trama de control | B10 = 0. Estado del sistema (fin, pausa, info periódica). |

---

## Tipos de evento (B8) — resumen

| B8   | B7   | Evento | Acción en `SerialService.js` |
|------|------|--------|------------------------------|
| `0xA1` | `0x3E` | **GO** — semáforo + inicio de carrera | Emite `race_go { durationMs }` y `race_started` |
| `0xA2` | `0x00` | Confirmación post-GO (fase 1) | Ignorada por el código actual |
| `0xA3` | `0x00` | Confirmación post-GO (fase 2) | Ignorada por el código actual |
| `0xA4` | `0x00` | **Fin normal** — tiempo agotado | Emite `race_finished` |
| `0xA5` | `0x00` | **Pausa activada** | Ver nota en §Control de estado |
| `0xA6` | `0x00` | **Pausa desactivada** | Ver nota en §Control de estado |
| `0xA7` | `0x00` | **Stop forzado** | Emite `race_stopped` |
| `0xC0` | `0x00` | Info periódica de estado | Emite estado según B1 (ver §Control de estado) |
| `0xA9` | `0x1B` | Cruce de carril (subtipo A) | Procesado como cruce normal (B8 no diferencia comportamiento) |
| `0x00` | `0x1B` | Cruce de carril (subtipo B) | Procesado como cruce normal |

> **Nota sobre `0xA9` vs `0x00` en cruces:** ambos valores se observan en tramas de cruce (`B7=0x1B`) para los mismos carriles en distintas vueltas. La implementación actual ignora B8 para cruces y usa únicamente B10 (carril) y B14–B17 (tiempo).

---

## Bitmask de carril (B10)

El DS-300 usa un bitmask **no secuencial** de 8 bits:

| Bit (valor) | Carril |
|-------------|--------|
| `0x80` (10000000) | Carril 1 |
| `0x40` (01000000) | Carril 2 |
| `0x20` (00100000) | Carril 3 |
| `0x10` (00010000) | Carril 4 |
| `0x08` (00001000) | Carril 5 |
| `0x04` (00000100) | Carril 6 |
| `0x02` (00000010) | Carril 7 |
| `0x01` (00000001) | Carril 8 |

Una misma trama puede tener varios bits activos si dos coches cruzan simultáneamente.

**Ejemplo:**
```
B10 = 0x40  →  Carril 2
B10 = 0x80  →  Carril 1
B10 = 0x28  →  Carriles 3 y 5 simultáneos (0x20 | 0x08)
```

---

## Codificación del tiempo de vuelta (B14–B17)

Los tiempos se almacenan en **BCD decimal-en-hex**: cada byte se lee como si sus dígitos hex fueran dígitos decimales.

```
ds300Byte(0x57) → parseInt("57", 10) → 57  (centésimas)
ds300Byte(0x04) → parseInt("04", 10) →  4  (segundos)
```

Fórmula de conversión a milisegundos:
```
lapMs = min × 60000 + sec × 1000 + cen × 10 + dmil × 0.1
```

**Primer cruce — tiempo inválido:**  
Si algún nibble de B14–B17 contiene `A`–`F`, la trama es un **primer cruce** (el coche ha pasado por primera vez; no hay referencia anterior). No se registra tiempo de vuelta. Ejemplo:
```
B14=AA  B15=AB  B16=AA  B17=AA  →  tiempo inválido, primer cruce
```

**Ejemplos de tiempos válidos (del CSV):**

| Vuelta | B14 | B15 | B16 | B17 | Tiempo calculado |
|--------|-----|-----|-----|-----|-----------------|
| 2 | 00 | 04 | 57 | 88 | 0×60000 + 4×1000 + 57×10 + 88×0.1 = **4 578,8 ms** |
| 3 | 00 | 05 | 64 | 60 | 0×60000 + 5×1000 + 64×10 + 60×0.1 = **5 646,0 ms** |
| 4 | 00 | 05 | 05 | 01 | 0×60000 + 5×1000 + 5×10 + 1×0.1 = **5 050,1 ms** |

---

## Trama GO — duración de la manga

```
Trama GO ejemplo: E0 59 15 03 00 04 4C 3E A1 00 06 00 00 00 00 00 00 00 A6 00 EB
                                             ↑B7 ↑B8 ↑B9 ↑B10
```

La duración en minutos se calcula como:
```
mins = BCD(B9) × 100 + BCD(B10)
```

| B9 | B10 | Duración |
|----|-----|----------|
| `0x00` | `0x07` | 7 minutos |
| `0x00` | `0x06` | 6 minutos |
| `0x00` | `0x10` | 10 minutos |

Inmediatamente después del GO el DS-300 emite dos tramas de confirmación con B8=`0xA2` y B8=`0xA3` (ignoradas por la implementación).

---

## Tramas de estado periódico (B8=0xC0)

El DS-300 emite tramas de estado aproximadamente cada minuto mientras la carrera está activa. B10=`0x00` (sin carril). B14 contiene los **minutos transcurridos** desde el inicio:

```
Trama: E0 E6 15 03 00 04 4C 00 C0 00 00 00 00 00 01 D4 D4 D4 0F 00 EB
                                        ↑B8=C0              ↑B14=01 → 1 min transcurrido

Trama: E0 FE 15 03 00 04 4C 00 C0 00 00 00 00 00 02 D6 D6 D6 28 00 EB
                                        ↑B8=C0              ↑B14=02 → 2 min transcurridos
```

---

## Control de estado — pausa y stop

### Stop forzado y fin normal (detectados por B8)
```javascript
if (frame[8] === 0xa7)  → race_stopped   (stop forzado por operador)
if (frame[8] === 0xa4)  → race_finished  (fin normal, tiempo agotado)
```

### Estado de carrera (detectado por B1 en tramas de control)

Cuando B10=0 y B8 no es `0xa7` ni `0xa4`, el código actual usa **B1** como byte de estado:

| B1 | Estado |
|----|--------|
| `0x06` | Carrera en marcha (`race_started`) |
| `0x08` | Carrera parada (`race_stopped`) |
| `0x0C` | Pausa activa (`race_paused`) |
| `0x0F` | Pausa desactivada (`race_resumed`) |

> **Advertencia de implementación:** B1 es el contador de secuencia y estos valores (`0x06`, `0x0C`, etc.) solo coinciden por la posición en la secuencia, no por semántica del protocolo. En los datos capturados del CSV las tramas de pausa tienen B8=`0xA5` (pausa) y B8=`0xA6` (reanudación) con B1 variable. Si la detección de pausa falla, revisar si B8=`0xA5`/`0xA6` debería tratarse explícitamente como `0xA7` y `0xA4`.

---

## Secuencia típica de una manga

```
DS-300 emite:                           Software interpreta:
─────────────────────────────────────   ──────────────────────────────────────
[GO]  B7=3E B8=A1 B10=07               → race_go { durationMs: 420000 }
      B8=A2 (confirmación 1)           → (ignorado)
      B8=A3 (confirmación 2)           → (ignorado)

[CRUCE] B7=1B B10=40 B12=01            → lane_crossing { lane:2, lapTimeMs:null }
        B14-B17 = AA AB AA AA            (primer cruce, sin tiempo válido)

[CRUCE] B7=1B B10=40 B12=02            → lane_crossing { lane:2, lapTimeMs:4578.8 }
        B14=00 B15=04 B16=57 B17=88

[INFO] B8=C0 B14=01                    → (estado periódico, 1 min transcurrido)

... (más cruces durante la manga) ...

[FIN]  B8=A4                           → race_finished
```

---

## Multi-circuito (modo Pro)

Con varios DS-300 conectados, cada unidad se identifica por su `devID` (B2–B6). El `SerialService.js` aplica un `laneOffset` a cada circuito:

- Circuito 1: carriles 1–N (offset 0)
- Circuito 2: carriles N+1–2N (offset N)
- …

El parsing de tramas es idéntico para todos los circuitos; el offset se añade al carril local antes de emitir `lane_crossing`.

---

## De-merge de ráfagas (`_processFrame`)

El DS-300 emite tramas de **21 bytes** delimitadas por `0xE0` (inicio) y `0xEB` (fin). Cuando varios coches cruzan casi a la vez (típico en el GO o en pista corta), el DS manda varias tramas **seguidas**: a 56 000 baud cada trama tarda ~3,6 ms, así que 6 tramas (~22 ms) llegan dentro de la ventana de `FRAME_GAP_MS` (75 ms) y `_onData` las concatena en **un solo buffer**.

La implementación antigua solo leía el **primer cruce** de ese buffer y perdía el resto (causa raíz de una pérdida medida de ~7-8 % de vueltas). Desde el fix, `_processFrame` hace **de-merge**: si el buffer es múltiplo de `DS_FRAME_LEN` (21) y cada sub-trama está bien formada (`0xE0`…`0xEB`), lo parte en tramas de 21 bytes y procesa **cada cruce**. Si no divide limpio, cae al comportamiento anterior (no rompe fragmentación).

> El contador de secuencia **B1** es consecutivo entre las tramas de una ráfaga, lo que confirma que el DS sí las envía todas — solo había que separarlas. Sirve además para detectar pérdida real a nivel de protocolo (saltos en B1).

---

## Filtros aplicados por `SerialService.js`

| Filtro | Valor | Motivo |
|--------|-------|--------|
| `MIN_CROSSING_MS` | 500 ms | Descarta rebotes / coches detenidos sobre el sensor |
| `MAX_LAP_MS` | 240 000 ms (4 min) | Descarta coche parado; resetea referencia sin registrar vuelta |
| `FRAME_GAP_MS` | 75 ms | Silencio entre bytes que separa lecturas. **No** basta por sí solo: las ráfagas se re-separan por estructura (ver "De-merge de ráfagas") |
| `DS_FRAME_LEN` | 21 bytes | Longitud fija de trama (`0xE0`…`0xEB`); base del de-merge de ráfagas |

---

## Modo simulación y replay

Si no hay puerto serie configurado, `SerialService` busca el fichero `src/data/RegistroCarrera.txt`. Si existe, reproduce sus tramas respetando los intervalos reales. Si no existe, genera cruces aleatorios con dispersión ±20 % del tiempo medio.

El fichero de replay tiene el mismo formato que el capturado por RegistroCarrera.exe:
```
HH:MM:SS.mmm   B0 B1 B2 ... B20
20:06:28.938   E0 DA 15 03 00 04 4C 1B A9 00 40 00 02 00 00 BC FD 2F 2B 00 EB
```
