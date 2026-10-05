# Slot.it oXigen — documentación de referencia

Estudio para integrar oXigen como fuente de cruces en PitWall (2026-10-05). Sin implementar.

## Ficheros

| Fichero | Qué es |
|---|---|
| `PCDongleProtocol_v4.06.pdf` | Protocolo oficial PC ↔ dongle, rev. 4.06 (07/11/24), oXigen 4.15+ |
| `PCDongleProtocol_v4.06.txt` | El mismo, en texto (`pdftotext -layout`) para buscar |
| `BaseDescriptionO2.en.pdf` | Descripción base del sistema (rev. 2.10, 2019): chips, imanes, mandos, emparejado |
| `oXigen-FAQ.pdf` | FAQ oficial (ENG/ESP) |

Slot.it ya no los sirve (404); se recuperaron de Wayback Machine:

- https://web.archive.org/web/20251016194145/https://slot.it/Download/oXigen/Manuals/PCDongleProtocol_v_4.06.pdf
- https://web.archive.org/web/20240612224332/http://www.slot.it/Download/oXigen/Manuals/BaseDescriptionO2.en.pdf
- https://web.archive.org/web/20231023021840/http://slot.it/wp-content/uploads/2019/05/o2faq-ENG-ESP.pdf

## Resumen del protocolo

- Dongle azul O204b (recomendado). Puerto COM virtual, VID `0x1FEE`, PID `0x0002`.
- **PC → dongle**, 11 bytes: estado de carrera (`01` parada, `03` en marcha, `04` pausa,
  `05`/`15` con bandera con/sin cambio de carril), velocidad máxima global, comando global
  y comando por coche, y el reloj del PC en centésimas (bytes 8–10).
  Para arrancar la transmisión: `byte0=0x61`, o `0x0F` con `byte1=0xFF`.
- **Dongle → PC**, 13 bytes por coche, un paquete cada 10 ms; cada mando informa cada 300 ms.
  - El paquete es **estado, no evento**: una vuelta nueva = el contador de los bytes 5–6
    (byte bajo primero) ha subido.
  - Tiempo de vuelta = `(b2·256 + b3) / 99.25` s.
  - Momento del cruce = reloj de los bytes 10–12 − retraso del byte 4 (centésimas).
  - Tiempo de vuelta 0 = el mando se ha reiniciado (la vuelta cuenta, sin tiempo).
  - Byte 0, bit 4 = el coche está en el pit lane.
  - Byte 9 = batería baja, llamada a pista, el tiempo suma vueltas demasiado cortas, botones del mando.
- Comandos: velocidad en pit lane, velocidad máxima y mínima, freno, potencia de radio,
  vuelta mínima (en décimas).

## Lagunas y erratas del PDF

- No dice cómo llegan los paquetes del dongle azul: si llevan byte de longitud y cómo van
  varios coches en un mismo paquete (hasta 4). Hay que verlo con hardware real o una captura.
- La Nota 3 usa `rf_data_x[6]` para la media de potencia; debería ser `[7]`.
- Dice que el envío del PC son «10 bytes», pero define 11 (bytes 0–10).

## Encaje en PitWall (propuesta)

1. **Cronometraje (solo lectura):** `src/services/oxigen/OxigenConnection.js` como
   `type: 'oxigen'` en `SerialService.connectMultiple`.
   - Cada ID de coche se trata como un carril virtual.
   - Se ignoran los paquetes repetidos y se detectan huecos en el contador de vueltas.
   - Hace falta un emulador para el banco de pruebas.
2. **Dirección de carrera:**
   - PitWall lanza el GO y el semáforo, y lleva el reloj de la manga.
   - Parada, pausa y fin de manga se mandan desde PitWall.
   - La vuelta mínima se configura desde `circuits.min_lap_ms`.
   - Formato de carrera «digital», sin rotación de carriles.
3. **Extras:** safety car (estado con bandera), penalizaciones limitando la velocidad de un
   coche, llamada a pista → pausa, avisos de batería y reinicio, combustible.
