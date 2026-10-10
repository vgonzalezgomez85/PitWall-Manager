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
| i18n | JSON planos en `src/locales/` (es / en / it), middleware `src/middleware/i18n.js` |

---

## Estructura del proyecto

```
src/
  app.js                  — Entry point: Express + Socket.io + SerialService init + arranca el worker de stats
  routes/index.js         — Todas las rutas HTTP
  controllers/            — Un controller por dominio (thin, delegan en models/services)
  models/                 — Acceso a SQLite, un archivo por tabla
  engine/
    raceProjection.js     — buildRaceProjection PURO (sin `this`, deps inyectables {db, Lap, now, activeMangaOf, raceAggregate}). Mismo cálculo en el hilo principal y en el worker
    raceWideStats.js      — agregados race-wide de live-stats PUROS (pace/consistencia/progreso de TODA la carrera). Lo caro de LiveStatsController.json, extraído para el worker
  workers/
    statsWorker.js        — worker_thread: proyección/agregados caros. Abre su propia conexión SQLite `readonly` al mismo pitwall.db (PITWALL_DB_READONLY=1). Protocolo ready/projection/raceWide/invalidate/ping/error
  services/
    SerialService.js      — Lectura del DS (DS-300/200/030/080) / BART / TicTac / simulación. Emite eventos internos
    TicTacConnection.js   — Fuente «interface TicTac»: lee los cruces por USB HID (node-hid, autodetección por VID/PID) o por un PTY (emulador/puente). Solo cruces: PitWall dirige la carrera
    TimingService.js      — Gestiona la sesión activa de manga (laps, standings, ticks)
    StatsWorkerClient.js  — Cliente del worker de stats en el hilo principal. requestProjection() SIEMPRE resuelve: si el worker no está / falló / PITWALL_NO_WORKER=1, calcula en el hilo con raceProjection
    TrainingService.js    — Modo entrenamiento libre (sin carrera)
    SocketService.js      — Wrapper de Socket.io (emit global)
    PoleTimingService.js  — Cronometraje para sesión de pole position
    LicenseService.js     — Validación de licencia de producto
    LaneColors.js         — Colores de carril: circuito (`circuits.lane_colors`) → global (`settings.lane_colors`) → fábrica. En vistas: `laneColorsFor(race)`, `laneInk(hex)`
  lib/
    dsModels.js           — Familia DS PURA: modelos, baud por defecto, cómo se lee el carril (DS-200 distinto) y qué es una trama de control
    tictacProtocol.js     — Trama HID de 16 bytes del TicTac PURA (reloj = min·60000 + ms + décimas, NO 24 bits lineales; tiempo de vuelta = resta de relojes por carril)
  views/                  — Plantillas EJS
  locales/                — es.json / en.json / it.json (diccionario único)
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
database/                 — pitwall.db (SQLite, no commitear)
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

## Fuentes de datos (quién manda la carrera)

| Fuente | `serial_mode` | Quién da GO/pausa/stop/fin |
|---|---|---|
| DS (300/200/030/080) | `serial`, `serial_agg` | la caja (señales `race_*`) |
| BART | `bart` | PitWall (`isBart`: el Master SÍ se pausa de verdad) |
| TicTac | `tictac` | PitWall (`isTicTac`: el aparato sigue contando en pausa, así que aplica la compensación de pausa del DS) |
| Simulación | `simulation` | PitWall |

- `SerialService.softwareGo` (BART \| simulación \| TicTac) = PitWall da el GO: semáforo de 3 s, botones GO/PAUSE/STOP en directo, entrenamiento y **pole**. `SerialService.endsByTimer` (simulación \| TicTac) = nadie avisa del fin: `TimingService` cierra justo al agotar el tiempo (los DS llevan un respaldo de 30 s de silencio). Usar estas propiedades, no `isBart`, para decidir quién manda.
- `sendStart()` en `TicTacConnection` borra las referencias de reloj por carril: el primer cruce tras el GO sale sin tiempo = vuelta de salida desde el GO. Con la manga viva (`setExternalRaceState`) una vuelta larga no se descarta como «primer cruce» (pausas largas).
- Modelo de DS: `circuits_serial[].model` (el DS-300 no se guarda; es el valor por defecto). El latido de 60 s solo se vigila en el DS-300.
- La vuelta de bandera usa la misma ventana `late_crossing_grace_ms` con cualquier dispositivo (hoy desactivada en BART y simulación).
- `node-hid` es `optionalDependencies`: si falta, la fuente TicTac USB avisa y el resto funciona. Si se copia a mano en `node_modules` (el `package-lock.json` está obsoleto desde la v1.27.0, y un `npm install` reescribe media carpeta), hay que anidar también `node-addon-api` 3.x en `node_modules/node-hid/node_modules/`: PitWall tiene la 7.x hoisted y sin la 3.x `electron-builder` falla con «Production dependency node-addon-api not found». Tras tocar `node_modules`, comprobar con `electron-builder --mac --dir` en una copia aparte.

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
| `teams` / `drivers` | Entidades de competición. `categoria` y `coche` son la copa y el coche **de esta carrera** (opcionales; interruptores `races.has_categoria`/`has_coche`). Al leerlos manda el valor de la carrera y, si está vacío, cae al del catálogo de equipos por nombre (`teams_catalog.categoria/coche`) — ver `Manga.getLanes`, `Lap._entityCategoria` |
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
- **`buildRaceProjection` / `raceAggregate` / `activeMangaOf` viven en `src/engine/raceProjection.js`** (módulo puro); `TimingService` delega en él. El cálculo caro corre en un **worker_thread** (`src/workers/statsWorker.js`) vía `StatsWorkerClient`: `_cachedProjection` sigue siendo síncrono, pero con worker disponible sirve la caché y pide el refresco al worker sin bloquear el event loop (el tick de 1 s refresca la caché mientras hay manga viva). El worker lee de una conexión SQLite `readonly` propia (WAL permite lectores concurrentes). Se puede desactivar con `PITWALL_NO_WORKER=1` (entonces todo se calcula en el hilo principal, comportamiento idéntico pero bloqueante).
- **Caché de `Lap.startSettledByEntity`** (corrección de la vuelta de salida): solo depende de la 1ª manga de cada entidad, así que solo se invalida si la mutación puede afectarla de verdad (`Lap.mutationsInvolving(mangaIds)`, `Lap.mutatedMangaCount`). No invalidar con cualquier escritura en `laps`: su escaneo de toda la carrera se repetiría en cada cruce.
- **Coma manual (`manga_lanes.coma_manual`)**: corrección opcional del operador sobre la coma (Ajustes → Preferencias → `manual_coma`, apagada por defecto; solo mangas `finished`, desde la pantalla de correcciones). `Lap._lastMangaByEntity`/`_comaByEntity` resuelven el valor efectivo (manual si el ajuste está activo) y `utils/tieBreak` le da prioridad sobre el instante del cruce. La coma NO vive en `laps`: `Manga.setLaneComa` y `Manga.updateStatus('pending')` (manga que se vuelve a correr) hacen el `markExternalMutation()` explícito, y `SettingsController.savePrefs` invalida contadores + cachés del motor al cambiar el ajuste — sin eso, resultados/móvil/directo servirían el orden viejo.
- **`LiveStatsController.json`**: los agregados race-wide (pace/consistencia/progreso de toda la carrera) viven en `src/engine/raceWideStats.js` y los calcula el mismo worker (`requestRaceWide`). El controlador guarda el último paquete en `_rwCache` y pide un refresco en segundo plano (`_kickRaceWideRefresh`); solo calcula en el hilo si no hay worker o es la primera vez. `json` sigue siendo síncrono.
- **Pre-calentado de cachés (`TimingService._warmStatsCaches`)**: lo llama `invalidateStandingsCaches` (arranque de manga, fin de circuito, corrección). Calienta síncronamente `_priorAggregates` y `raceAggregate` (que arrastra `startSettledByEntity`, ~85 ms en frío) y pide al worker proyección + race-wide, para que el primer cruce no pague nada en frío. `Lap.noteMangaSeen(mangaId)` registra la manga sin contar mutación, para que el 1er cruce no dispare el guard de `mutatedMangaCount`. Estos momentos no tienen cruces (semáforo / fin de manga), así que el coste síncrono no importa.
- **Correcciones con manga viva (`TimingService.applyLapCorrection(raceId, mangaId)`)**: `LapCorrectionController` la llama tras cada acción. Rehace los contadores en memoria de la manga viva desde la BD (conservando el último cruce físico), numera el siguiente cruce tras la vuelta más alta (`ld.lapNumOffset`), refresca la mejor vuelta, invalida cachés y emite `standings` + `laps:corrected`. Sin esto el directo no cambiaba hasta el siguiente cruce y salían números de vuelta repetidos.

### TrainingService
- También escucha `race_go` y `race_started`.
- **Guarda**: solo actúa si `!TimingService._pendingSetup && !TimingService.isRunning`.
- Si hay una carrera en curso, el TrainingService no interfiere.

### SocketService
- `SocketService.emit(event, data)` hace broadcast a todos los clientes conectados.
- Eventos cliente→servidor: `standings:request` (pide standings actuales).
- Eventos servidor→cliente principales: `standings`, `lap`, `tick`, `manga:started`, `manga:stopped`, `manga:cancelled`, `race:semaphore`, `manga:paused`, `manga:resumed`, `laps:corrected` (tras una corrección de vueltas; sin manga viva, el directo recarga).

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
- **Tests**: `npm test` (`node --test`, sin dependencias nuevas). Cubren turnos de piloto, informe, pre-arme, el parser de tramas DS-300, los endpoints peligrosos, el motor puro de proyección (`race-projection-engine`), el worker de stats (`stats-worker*`, `timing-projection-worker`, `lap-settled-cache`), la contraseña de acceso (`access-password`), la corrección de vueltas con manga viva (`lap-correction-live`) y el historial «las 10 mejores» de entrenos (`training-best-laps`). La rotación de carriles y el resto de estadísticas **siguen sin cobertura**.
- **Banco de pruebas**: emulador DS-300 (`/Users/victor/ds300-emulator/emulator.js`) y `node scripts/rehearsal-shifts.js` (ensayo E2E sobre 3 cajas, 24 carriles).
  Las rutas `/api/test/*` y `/api/rawlog` simulan las señales del DS, pero **solo se montan con `PITWALL_TEST_ENDPOINTS=1`**: `/api/test/stop` borra todas las vueltas de la manga activa, así que no puede existir en la máquina de una carrera.

## Variables de entorno (además de las del README)

- `PITWALL_TEST_ENDPOINTS=1` — monta las rutas `/api/test/*` y `/api/rawlog` (solo banco de pruebas).
- `PITWALL_NO_WORKER=1` — desactiva el worker_thread de stats; la proyección/agregados se calculan en el hilo principal (idéntico resultado, pero bloqueante).
- `PITWALL_DB_READONLY=1` — abre la BD en solo lectura, sin migraciones ni `ANALYZE`. Lo usa el worker de stats internamente; no ponerlo en el proceso principal.
- `PITWALL_DISABLE_PASSWORD=1` — ignora la contraseña de acceso (Ajustes → Seguridad) mientras esté puesta. Es la vía de recuperación si se olvida: arrancar con ella, entrar y poner otra (o desactivarla).
- **i18n**: TODO texto visible va por `req.t('key')` en controllers, `t('key')` en vistas y **`I18N.t('key')` en el JS de cliente** (dentro de `<script>` y en `public/js/`). **Nunca ternarios de idioma** (`lang === 'es' ? … : …`): no admiten un tercer idioma y eran 1.900 repartidos por las vistas.
  - En el navegador el ayudante es `I18N.t`, **no `t`**: el JS de cliente ya declara su propio `t` en una docena de sitios (bucles, temporales) y llamarlo `t()` los rompe. El diccionario llega en la página por `partials/i18n-client.ejs`, que va en el header y en las trece vistas autónomas (directo, TV, Le Mans, Lap, QR, paneles: no incluyen el header). `es.json` es la fuente del español; al añadir texto hay que dar de alta la clave en `es.json`, `en.json` e `it.json` (en `it.json` se pone el español como provisional, nunca una clave cruda).
  - Herramientas: `scripts/i18n-extract.js` (convierte ternarios → `t()` y avisa de lo que no puede y de los choques con una variable `t` local), `scripts/i18n-snapshot.js` (arnés de instantáneas HTML para verificar que una conversión no cambia el render), `scripts/i18n-kit.js` (exporta el diccionario a CSV para el traductor y lo reimporta).
  - El kit para traductores está en `traducciones/` (README + CSV). Se regenera con `node scripts/i18n-kit.js export --lang it --out traducciones --sin-guia`.
- **Sin comentarios redundantes** en el código. Solo WHY si no es obvio.

---

## Cómo arrancar

```bash
# Servidor web (modo desarrollo)
cd /Users/victor/PitWall
npm run dev          # nodemon src/app.js → http://localhost:3000

# Emulador DS-300 (en otra terminal)
cd /Users/victor/ds300-emulator
node emulator.js     # puerto 3001, REST: POST /api/go, POST /api/stop

# Limpiar base de datos
rm database/pitwall.db && npm run dev
```

---

## Módulos con licencia (licenseGuard)

Algunas rutas requieren `requireModule('feature')`. Las features actuales: `races_basic`, `pole`, `tv`, `export`, `driver_profiles`, `teams_catalog`, `qr_checkin`, `lemans`. Si una ruta devuelve 403, verificar el archivo `src/data/slotime.license`.
