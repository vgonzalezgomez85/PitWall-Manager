# PitWall — AGENTS.md

Guía para agentes de IA (Claude Code u otros LLMs) que trabajen en este proyecto.

---

## Qué es este proyecto

**PitWall** es una aplicación de gestión y cronometraje de carreras de slot cars.
Corre como aplicación web local (Node.js + Express) o como app de escritorio (Electron).
El hardware de cronometraje es el **DS-300**, un detector de cruces de carriles que comunica
por puerto serie a 56000 baudios con tramas de ~19 bytes codificadas en BCD.

---

## Stack técnico

| Capa | Tecnología |
|---|---|
| Servidor | Node.js + Express 4 |
| Base de datos | SQLite vía `better-sqlite3` (síncrono) |
| Tiempo real | Socket.io |
| Vistas | EJS (server-side rendering) |
| CSS/JS cliente | Vanilla JS, CSS custom properties, sin bundler |
| Desktop | Electron (empaqueta el servidor Express) |
| i18n | JSON planos en `src/locales/` (es / en), middleware `src/middleware/i18n.js` |

---

## Estructura del proyecto

```
src/
  app.js                  — Entry point: Express + Socket.io + SerialService init
  routes/index.js         — Todas las rutas HTTP
  controllers/            — Un controller por dominio (thin, delegan en models/services)
  models/                 — Acceso a SQLite, un archivo por tabla
  services/
    SerialService.js      — Lectura del DS-300 / simulación. Emite eventos internos
    TimingService.js      — Gestiona la sesión activa de manga (laps, standings, ticks)
    TrainingService.js    — Modo entrenamiento libre (sin carrera)
    SocketService.js      — Wrapper de Socket.io (emit global)
    PoleTimingService.js  — Cronometraje para sesión de pole position
    LicenseService.js     — Validación de licencia de producto
  views/                  — Plantillas EJS
  locales/                — es.json / en.json
  middleware/
    i18n.js               — req.t(key), res.locals.lang
    licenseGuard.js       — requireModule(feature)
public/
  js/
    live.js               — Lógica cliente para vista de manga en vivo
    training.js           — Lógica cliente para entrenamiento
    tv.js                 — Pantalla TV / marcador
    app.js                — JS global compartido
  css/
    live.css              — Estilos de la vista live
electron/                 — Electron main + launcher
database/                 — slotime.db (SQLite, no commitear)
```

---

## Protocolo DS-300

- **Puerto serie**: 56000 baud, 8N1
- **Frames**: 21 bytes fijos, `0xE0`…`0xEB`, separados por silencio > 75ms (`FRAME_GAP_MS`). En ráfaga (varios cruces juntos) llegan concatenados; `_processFrame` los **re-separa** en tramas de 21 bytes (de-merge) para no perder cruces. Ver `DS300-protocolo.md`
- **Lane**: byte[10] — bitmask no secuencial: `0x80→1, 0x40→2, 0x20→3, 0x10→4, 0x08→5, 0x04→6, 0x02→7, 0x01→8`
- **Tiempo de vuelta**: bytes[14-17] BCD (`ds300Byte()`): minutos, segundos, centésimas, diezmilésimas. Si algún nibble es A-F = primer cruce (sin tiempo válido)
- **Señales de carrera** (emitidas por `SerialService` como eventos internos):
  - `race_go` → semáforo + arranca la carrera (lleva `durationMs` real del DS-300)
  - `race_started` → empieza el cronometraje (`TimingService.startManga`)
  - `race_stopped` → parada forzada (preserva datos)
  - `race_finished` → fin normal (guarda resultados)
  - `race_paused` / `race_resumed`
  - `lane_crossing` → vuelta detectada `{ lane, lapTimeMs }`

---

## Flujo de una manga

```
Usuario crea Race → Tanda → Manga
         ↓
SessionController.live() — carga vista live.ejs
         ↓
DS-300 envía GO → app.js captura → emite race:semaphore via Socket.io → cliente muestra semáforo
         ↓
DS-300 envía STARTED → TimingService.startManga() → Socket.io emit manga:started
         ↓
live.js recibe manga:started → redirige a /races/:id/mangas/:mangaId/live
         ↓
TimingService recibe lane_crossing → guarda Lap en SQLite → emite standings + lap via Socket.io
         ↓
DS-300 envía FINISHED → TimingService.stopManga() → emite manga:stopped { mangaId, nextLanes }
         ↓
Siguiente manga pendiente se activa automáticamente
```

---

## Modelo de datos (tablas principales)

| Tabla | Descripción |
|---|---|
| `races` | Carrera: tipo (club/championship), formato (individual/team), duración de manga, estado |
| `tandas` | Grupo de mangas dentro de una carrera |
| `mangas` | Una manga individual. Estados: pending → active → finished. `actual_duration_ms` = duración real que mandó el DS al GO (la usa la estimada) |
| `manga_lanes` | Asignación carril↔equipo/piloto por manga. `lane=0, is_rest=1` = descanso |
| `laps` | Vueltas registradas. `is_ghost=1` = inválida (< min_lap_ms); `is_warmup=1` = 1ª vuelta (no cuenta para mejor vuelta); `is_exit`/`is_pit_stop` = salida/parada |
| `teams` / `drivers` | Entidades de competición |
| `settings` | Clave-valor persistente (puerto serie, carriles, etc.) |
| `circuits` | Circuitos con `lanes_count` y `min_lap_ms` |

---

## Servicios clave: invariantes importantes

### SerialService
- Singleton. Emite eventos internos con `EventEmitter`.
- En modo simulación (sin puerto serie configurado) usa `RegistroCarrera.txt` o genera cruces aleatorios.
- `getRawLog()` devuelve los últimos bytes recibidos (útil para debug).
- **De-merge de ráfagas**: las tramas son de 21 bytes (`0xE0`…`0xEB`). Si varias llegan juntas (<`FRAME_GAP_MS`) se concatenan en un buffer; `_processFrame` lo re-separa en tramas de 21 bytes y procesa cada cruce. Sin esto se perdía ~7-8% de vueltas. Ver `DS300-protocolo.md` → "De-merge de ráfagas".

### TimingService
- Singleton. `isRunning` = hay manga activa.
- `_pendingSetup` = manga registrada para el próximo GO del DS-300. Si es null, `app.js` busca la primera manga pending de cualquier carrera activa.
- **No llamar a `startManga` directamente desde controladores** salvo en el flujo manual (`SessionController.start`).
- `stopManga(true)` = fin normal (guarda). `cancelManga()` = cancela sin guardar.
- **1ª vuelta = warmup**: la primera vuelta real de cada carril se marca `is_warmup=1` y NO compite por mejor vuelta (ni en vivo ni en `Lap.raceBestByLane`, que filtra `lap_number > 1`). Evita que una salida desde parado / primer cruce sea "vuelta rápida".
- **Duración de manga del DS**: `startManga` persiste la duración real del GO en `mangas.actual_duration_ms`. La clasificación estimada (`_getEffectiveMangaDurationMs`) la usa para no caer al placeholder `manga_duration_minutes`.
- **Proyección (clasificación estimada)**: `proyección = vueltas_reales + (tiempo restante de su manga / media) + (mangas futuras × duración / media)`. Anclada en lo real → converge al final; quien terminó sus mangas proyecta su total real. Se calcula en cliente (`live.js renderProjected`, `live-panel.ejs`).

### TrainingService
- También escucha `race_go` y `race_started`.
- **Guarda**: solo actúa si `!TimingService._pendingSetup && !TimingService.isRunning`.
- Si hay una carrera en curso, el TrainingService no interfiere.

### SocketService
- `SocketService.emit(event, data)` hace broadcast a todos los clientes conectados.
- Eventos cliente→servidor: `standings:request` (pide standings actuales).
- Eventos servidor→cliente principales: `standings`, `lap`, `tick`, `manga:started`, `manga:stopped`, `manga:cancelled`, `race:semaphore`, `manga:paused`, `manga:resumed`.

---

## live.js (cliente): puntos críticos

- `RACE_DATA` se inyecta en el HTML desde EJS. `durationMs` empieza en `null`; se actualiza desde el primer evento `standings` con `remainingMs + elapsedMs` (el valor real del DS-300).
- `RACE_DATA.isActive` se pone a `false` al recibir `manga:stopped` — **solo si `data.mangaId === RACE_DATA.mangaId`**; ignorar eventos de otras mangas.
- El timer (`startCountdown`) arranca desde `standings.remainingMs`. El handler `tick` solo es fallback si `timerInt === null && RACE_DATA.durationMs != null`.
- `manga:started` redirige a la nueva manga solo si `!RACE_DATA.isActive`.

---

## Convenciones de código

- **Models**: métodos estáticos sobre `better-sqlite3`, síncronos. Sin ORM. Nombres: `findById`, `findAll`, `create`, `update`, `updateStatus`.
- **Controllers**: funciones exportadas `module.exports = { action }`. Leen `req.params/body/session`, llaman a models/services, renderizan EJS o redirigen.
- **Tests**: `npm test` (`node --test`, sin dependencias nuevas). Cubren turnos de piloto, informe, pre-arme, el parser de tramas DS-300 y los endpoints peligrosos. El motor de vueltas, la rotación de carriles y las estadísticas **siguen sin cobertura**.
- **Banco de pruebas**: emulador DS-300 (`/Users/victor/ds300-emulator/emulator.js`) y `node scripts/rehearsal-shifts.js` (ensayo E2E sobre 3 cajas, 24 carriles).
  Las rutas `/api/test/*` y `/api/rawlog` simulan las señales del DS, pero **solo se montan con `PITWALL_TEST_ENDPOINTS=1`**: `/api/test/stop` borra todas las vueltas de la manga activa, así que no puede existir en la máquina de una carrera.
- **i18n**: usar `req.t('key')` en controllers/vistas. Añadir ambas claves (es + en) en `src/locales/*.json` siempre que se añada texto visible.
- **Sin comentarios redundantes** en el código. Solo WHY si no es obvio.

---

## Cómo arrancar

```bash
# Servidor web (modo desarrollo)
cd /Users/victor/SloTime
npm run dev          # nodemon src/app.js → http://localhost:3000

# Emulador DS-300 (en otra terminal)
cd /Users/victor/ds300-emulator
node emulator.js     # puerto 3001, REST: POST /api/go, POST /api/stop

# Limpiar base de datos
rm database/slotime.db && npm run dev
```

---

## Módulos con licencia (licenseGuard)

Algunas rutas requieren `requireModule('feature')`. Las features actuales: `races_basic`, `pole`, `tv`, `export`, `driver_profiles`, `teams_catalog`, `qr_checkin`, `lemans`. Si una ruta devuelve 403, verificar el archivo `src/data/slotime.license`.
