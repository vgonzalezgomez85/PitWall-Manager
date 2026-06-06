# Protocolo BART (BLE Advanced Race Timer) — Estudio

> Fuente: `info para proyecto infolap slot/BART_protocol(hex)_complete.pdf`
> Fabricante: **Policar Track / Slot.it** · Doc `FL_BLE` · Rev **0.04** · 22/09/25 · Autor C. Anceschi.
> Estudio reconstruido desde el PDF (la conversación original fue por la web y no se guardó).

---

## 1. Qué es BART y en qué se diferencia del DS-300

BART es un **cronometrador de carreras de slot analógico por Bluetooth Low Energy (BLE)**.
La detección de coche se hace por **dead strip** (tramo de pista sin alimentación: el coche
puentea los dos raíles → cierre de baja resistencia → cruce). Nada de óptica ni de puerto serie.

**Diferencia clave con el DS-300 (lo que importa para SlotTime):**

| | DS-300 (actual) | BART |
|---|---|---|
| Transporte | Serie COM @57600 baud | **BLE (GATT, Nordic UART Service)** |
| Trama | 21 bytes, `e0…eb`, byte[1]=secuencia | binaria, **header `0xA5`**, longitud variable |
| Endianness | — | **little-endian** |
| Integridad | (sin CRC robusto) | **CRC-8 (poly 0x07)** en cada paquete |
| Topología | 1 dispositivo por COM | **1 Master + hasta 7 Slaves = 32 carriles**; varios Masters coexisten |
| Sensor | — | dead strip (puente resistivo) |

> **Implicación para la app:** BART **no se lee por `serialport`**. Necesita un puente BLE
> (Web Bluetooth en navegador, `noble` en Node, o `bleak` en Python). Es un canal y un
> parser totalmente distintos al del DS-300. Ver §9.

---

## 2. Arquitectura Master / Slave

- **Mismo firmware** en todos; el rol se decide por configuración. De fábrica salen todos como Master.
- **Master**: único punto BLE visible para el móvil/PC. Recibe comandos del RMS, los reparte a los
  Slaves (fan-out), agrega los cruces (propios + de los Slaves) y los reenvía a la app.
- **Slave**: detecta cruces, mide tiempos, aplica el filtro MinLap **localmente**, y manda paquetes
  de vuelta (lap) a su Master. **Nunca** se conecta al móvil.
- Hasta **7 Slaves por Master → 32 carriles** (4 + 4×7). Varios Masters → carriles ilimitados
  (resistencia multipista / rally). El procesado de cruce + MinLap ocurre **dentro del Slave**, así
  el timing es estable aunque la latencia BLE varíe.

**Dos capas de comunicación:**
1. `Phone → Master → Slaves` : configuración, control de carrera (start/stop/pause/clear), MinLap, status.
2. `Slaves → Master → Phone` : eventos de vuelta (lap), ACKs, snapshots de estado.

---

## 3. Estructura binaria del paquete (§5)

Todos los paquetes (en las tres direcciones) comparten la misma forma:

```
Byte 0      : SYNC      = 0xA5
Byte 1      : MSG_TYPE  (categoría/dirección)
Byte 2      : OP_CODE   (acción concreta)
Bytes N…    : Payload   (opcional)
Último byte : CRC-8     (poly 0x07, sobre todos los bytes menos el propio CRC)
```

### MSG_TYPE (byte 1)
| Nombre | Hex | Dirección | Significado |
|---|---|---|---|
| MSG_LAP | `0x01` | Slave → Master (→Phone) | Evento de vuelta |
| MSG_STATUS | `0x20` | → Master/Phone | Snapshot de estado |
| MSG_FANOUT | `0x30` | Master → Slaves | Broadcast del Master |
| MSG_ACK | `0x7F` | cualquiera | Acuse de recibo |
| MSG_CMD | `0x90` | Phone → Master | Comando / config / control |

### OP_CODE (byte 2)
**Control de carrera / sistema:**
| OP | Hex | Acción |
|---|---|---|
| OP_START | `0x01` | Iniciar carrera |
| OP_STOP | `0x02` | Parar (con 2 s de gracia) |
| OP_PAUSE | `0x03` | Pausar |
| OP_CLEAR | `0x04` | Borrar contadores (propios + slaves) |
| OP_SET_MINLAP | `0x10` | Fijar MinLap (payload 2 bytes, ms, LE) |
| OP_READ_STAT | `0x20` | Pedir snapshot de estado |

**Configuración (solo en MODE_CONFIG):**
| OP | Hex | Acción |
|---|---|---|
| OP_SET_MODE | `0x40` | Rol Master/Slave |
| OP_SET_ID | `0x41` | ID de dispositivo |
| OP_SET_LABEL | `0x42` | Nombre/etiqueta del Master |
| OP_SET_MASTER | `0x43` | Asignar Slave a un Master |
| OP_READ_CONFIG | `0x50` | Leer toda la configuración |

**Control de notificaciones** (no aparece en la tabla de OPs, solo en §4.5/§7.1):
| OP | Hex | Acción |
|---|---|---|
| (NOTIFY_EN) | `0x30` | `A5 90 30 01` habilita / `A5 90 30 00` deshabilita stream async |

> ⚠️ Ojo: `0x30` como **MSG_TYPE** = fan-out; `0x30` como **OP** bajo `MSG_CMD 0x90` = control de
> notificaciones. Son campos distintos, no se confunden en el parser, pero conviene tenerlo presente.

### Endianness y unidades (§5.5) — con un matiz importante
- Todos los numéricos multibyte: **little-endian**.
- `lap_ms`: tiempo de vuelta en **milisegundos** (uint16).
- `ts_d10`: timestamp en unidades de **10 ms** (uint16). El ejemplo del doc `20930` = `209.30 s`
  ⇒ `20930 × 10 ms`. **Es centisegundos.** El PDF lo llama por error "deciseconds" en varios
  sitios (decisegundo = 100 ms); por el ejemplo numérico, **la unidad real es 10 ms (centisegundos)**.
  Confírmalo empíricamente antes de fiarte del texto.

---

## 4. Paquete de vuelta — MSG_LAP (§6, Apéndice D)

```
A5 01 01 lane_id laps[2] lap_ms[2] ts_d10[2] reserved[2] CRC
```
13 bytes en total (cabe de sobra en el MTU de 20).

| Campo | Tam | Descripción |
|---|---|---|
| SYNC | 1 | `0xA5` |
| MSG_TYPE | 1 | `0x01` (MSG_LAP) |
| OP | 1 | `0x01` |
| lane_id | 1 | carril 1–4 (según el dispositivo) |
| laps | 2 | contador acumulado de vueltas (uint16, LE) |
| lap_ms | 2 | duración de la última vuelta en ms (uint16, LE) |
| ts_d10 | 2 | timestamp en unidades de 10 ms (uint16, LE) |
| reserved | 2 | reservado, =0 |
| CRC | 1 | CRC-8 (poly 0x07) |

**Comportamiento del Slave por cada cruce:** valida contra MinLap → incrementa contador → mide
tiempo → calcula timestamp → construye paquete → lo envía al Master de inmediato (no se buffea
salvo que el BLE esté ocupado puntualmente; hay retransmisión).

**Comportamiento del Master:** valida CRC → identifica el Slave → actualiza estado global →
reenvía al móvil por notificación → lo guarda en memoria runtime.

**Fiabilidad/orden:** el contador `laps` hace los eventos monótonos; el `ts_d10` resuelve empates;
el CRC descarta corrupción; la retransmisión BLE asegura entrega. No hace falta secuencia extra.

> ⚠️ **Doble representación:** la "Quick Start" (§1.4) muestra un formato de notificación **de texto**
> `<lane_bit>,<device_ID-1>,<lane_ID>,<laps>,<last_lap_time>,<timestamp>`
> (ej. `"2,0,2,5,1834,20930"` = carril 2, device 1, 5ª vuelta, 1.834 s, en 209.30 s). Pero el protocolo
> **real** que define el resto del documento es **binario** (lo de arriba). El texto parece de la
> implementación de referencia QT; **no asumas el formato texto** para el parser de producción.

---

## 5. Snapshot de estado — MSG_STATUS (§4.4, §9.6)

Petición: `A5 90 20 CRC` (OP_READ_STAT)
Respuesta:
```
A5 20 01 race_state minlap uptime_d10 lanes reserved CRC
```
Contiene: estado de carrera, MinLap actual, uptime (en 10 ms), nº de carriles, campos reservados.

> ⚠️ El **layout exacto en bytes del STATUS no está cerrado** en el PDF: el Apéndice Q ("Full Binary
> Packet Reference") es un **placeholder** ("Fully rewritten in developer-friendly style"), sin tabla.
> Los anchos de `minlap`/`uptime_d10` (probablemente uint16 LE cada uno) hay que **confirmarlos
> capturando con nRF Connect** antes de parsear en firme.

---

## 6. ACK — MSG_ACK (§5.4)

```
A5 7F OP RESULT CRC
```
Todo comando recibe ACK. RESULT:
| Código | Significado |
|---|---|
| `0x00` | OK |
| `0x01` | error de CRC |
| `0x02` | longitud de payload incorrecta |
| `0x03` | OP desconocido |
| `0x04` | Busy |
| `0x05` | Denegado (no permitido en el modo actual) — citado en §8.2 |
| `0x06–0xFF` | reservado |

---

## 7. Máquina de estados de carrera (§4.1, Apéndice H)

Estados: **FREE** (idle, contadores a 0) · **RUN/RUNNING** · **PAUSE/PAUSED** · **STOP/STOPPED**.

| Evento | Transición |
|---|---|
| START | FREE → RUNNING |
| STOP | RUNNING → STOPPED |
| PAUSE | RUNNING → PAUSED |
| CLEAR | cualquiera → FREE + reset de contadores |

- **Gracia de 2 s**: tras STOP/PAUSE se siguen aceptando vueltas durante 2 s (coches en marcha).
- El relé de potencia se activa **solo en RUNNING** (Apéndice I).
- El Master reparte cada transición a todos los Slaves por **fan-out** → sincronía garantizada.

---

## 8. CRC-8 (Apéndice G, §9.3.3)

Polinomio `0x07`, valor inicial `0x00`, sin reflexión. Cubre todos los bytes **menos** el CRC final.

```c
uint8_t crc8_update(uint8_t crc, uint8_t b) {
    crc ^= b;
    for (uint8_t i = 0; i < 8; i++)
        crc = (crc & 0x80) ? (crc << 1) ^ 0x07 : (crc << 1);
    return crc;
}
// crc = 0; for each byte: crc = crc8_update(crc, byte);
```

---

## 9. BLE / GATT e integración (§7, §9, Apéndices E y J)

- **Servicio:** Nordic UART Service (NUS).
  - El PDF abrevia las características como "NUS RX `0x0002`" / "NUS TX `0x0003`" — son índices, no los
    UUID reales. Hay que usar los **UUID 128-bit estándar de NUS**:
    - Service `6E400001-B5A3-F393-E0A9-E50E24DCCA9E`
    - **RX (Phone→Master, write)** `6E400002-…`
    - **TX (Master→Phone, notify)** `6E400003-…`
- **Descubrimiento:** escanear peripheral con nombre `BART_xxxx` (Master normal) / `BART_MST` /
  `BART_CFG_<ID>` (modo config) y el Service UUID de NUS.
- **Activar notificaciones:** escribir el CCCD de la característica TX **y/o** enviar `A5 90 30 01`.
  El Master responde `A5 7F 30 00` y vacía la cola pendiente.
- **MTU = 20 bytes** → trocear mensajes largos (los lap/ack/status caben en uno).
- **Backpressure:** si la app no consume rápido, el Master encola (`phone_tx_busy=true`) y drena al
  recuperarse. No se pierden eventos, se retrasan. Latencia típica 10–40 ms.
- **Parámetros BLE recomendados:** connection interval 30–50 ms, slave latency 0, PHY 1 Mbit.
  Supervision timeout: el doc se contradice (§7.6 dice 4–6 s, Apéndice J dice 1–2 s) → elegir y probar.
- **En desconexión:** flags y colas se limpian, el Master vuelve a advertising solo.
- **Polling interno Master↔Slaves:** round-robin cada **100 ms**.

### Demux en la app (§9.4.1)
```
[0]=0xA5  [1]=MSG_TYPE  [2]=OP/subtipo  [3..N]=payload  [last]=CRC
0x01 → lap   |   0x20 → status   |   0x7F → ACK   |   0x90 → comando (no esperado en lado app)
```

### Pseudocódigo mínimo (§9.11)
```
master = ble_connect("BART_xxxx")
enable_notifications(master.tx)         # CCCD + A5 90 30 01
write(master.rx, build_cmd(OP_START))   # A5 90 01 CRC
on_notify(pkt):
    p = parse(pkt)
    if p.type == LAP: update_lap_table(p); ui.render()
write(master.rx, build_cmd(OP_READ_STAT))  # A5 90 20 CRC
```

### Ejemplo JSON de salida sugerido por el doc (§9.10)
```json
{ "type":"lap", "lane":3, "lap":14, "time_ms":1250, "timestamp":81234 }
```
El doc sugiere puentear BLE → JSON → MQTT / WebSocket / RMS. **Esta es la vía natural para SlotTime:**
un proceso puente BLE que normalice los paquetes BART al mismo modelo interno que ya usamos para el DS-300.

---

## 10. Manejo de errores y casos límite (§8)

- **Filtro MinLap**: cruces antes del MinLap se ignoran (anti-rebote, dobles cruces, ruido). Si hay
  fantasmas → subir MinLap (mismo patrón que ya documentamos en DS-300, ver [[project_ghost_laps]]).
- **Fuera de orden / duplicados**: laps con número menor o mismo timestamp se rechazan y loguean.
- **Overflow 16-bit** de `laps`/`ts`: wrap-around seguro, el Master reordena por timestamp.
- **Slave timeout**: si un Slave deja de mandar, el Master lo marca offline; la carrera sigue con el
  resto; la app debe pintar esos carriles como "offline".
- **DFU**: si el firmware está corrupto arranca como `DfuTarg`; reflasheo por nRF Connect/USB.

---

## 11. Resumen de gotchas a verificar empíricamente (lo que NO está cerrado en el PDF)

1. **Unidad real de `ts_d10`** = 10 ms (centisegundos), pese a que el texto dice "deciseconds". ✅ por ejemplo numérico.
2. **Layout exacto del STATUS** (anchos de minlap/uptime): Apéndice Q es placeholder → capturar.
3. **UUID reales de NUS** (el PDF da índices `0x0002/0x0003`, no los 128-bit). Usar los estándar.
4. **Supervision timeout**: contradicción 1–2 s vs 4–6 s.
5. **Formato texto vs binario** del lap: el binario es el de producción; el texto de §1.4 es de la demo QT.
6. **Lane numbering global**: el ID de dispositivo define la numeración global de carriles
   (4 por device); hay que mapear `(device_id, lane_id)` → carril global en la app.

## 12. Herramientas recomendadas por el doc
nRF Connect (Desktop/Mobile) para sniffing de paquetes, nRF Sniffer + Wireshark, dongle nRF52840,
y `bleak` (Python) para scripting. Implementación de referencia open-source en QT (MIT + Qt LGPLv3).
