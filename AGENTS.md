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
    TicTacConnection.js   — Fuente «interface TicTac»: lee los cruces por USB HID (node-hid, autodetección por VID/PID) o por un PTY (emulador/puente). Le manda las órdenes de PitWall (C1 GO con tiempo, C2 stop, C3 pausa, C4 reanudar) y traduce sus tramas de evento a las señales `race_*` de un DS
    TimingService.js      — Gestiona la sesión activa de manga (laps, standings, ticks)
    StatsWorkerClient.js  — Cliente del worker de stats en el hilo principal. requestProjection() SIEMPRE resuelve: si el worker no está / falló / PITWALL_NO_WORKER=1, calcula en el hilo con raceProjection
    TrainingService.js    — Modo entrenamiento libre (sin carrera)
    SocketService.js      — Wrapper de Socket.io (emit global)
    PoleTimingService.js  — Cronometraje para sesión de pole position
    LicenseService.js     — Validación de licencia de producto
    LaneColors.js         — Colores de carril: circuito (`circuits.lane_colors`) → global (`settings.lane_colors`) → fábrica. En vistas: `laneColorsFor(race)`, `laneInk(hex)`
    ClubBrand.js          — Nombre y logo del club (Ajustes → Preferencias): `settings.club_brand_enabled/club_name/club_logo/club_logo_ver`. El logo va en la BD como data URI PNG/JPEG (máx. 1 MB; entra en las copias y Electron no puede escribir en `public/`, que va en el asar). `active()` = marca a pintar o null; la sirve `GET /club/logo` (pública). En vistas: `partials/club-brand.ejs`. El logo de PitWall sale siempre
  lib/
    dsModels.js           — Familia DS PURA: modelos, baud por defecto, cómo se lee el carril (DS-200 distinto) y qué es una trama de control
    tictacProtocol.js     — Trama HID de 16 bytes del TicTac PURA (reloj = min·60000 + ms + décimas, NO 24 bits lineales; tiempo de vuelta = resta de relojes por carril) y sus órdenes (`ordenArrancar`: minutos 1-60 + horas). Ver `TicTacSlot-cuentavueltas-protocolos.md` §2.5
  utils/
    excelClubBand.js      — `addClubBand(wb, ws, cols, {pitwallLogo})`: banda del club arriba de una hoja ExcelJS (resultados, puntos, turnos). Los CSV no llevan marca
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
electron/                 — Electron main + launcher. `updater.js` (actualizaciones, ver «Actualizaciones de la app») + `updateLogic.js` (PURO, con tests). `windowPlacement.js` (PURO, con tests): en qué pantalla/modo se abre cada tipo de ventana (Ajustes → Ventanas y pantallas); se guarda en `userData/window-placement.json`, no en la BD
database/                 — pitwall.db (SQLite, no commitear)
```

---

## Protocolo DS-300

- **Puerto serie**: 56000 baud, 8N1
- **Frames**: 21 bytes fijos, `0xE0`…`0xEB`. Se buscan en el FLUJO de bytes como TicTacSlot (`dsProtocol.createFrameSplitter`): un `0xE0`, `0xEB` 20 bytes después y checksum correcto; da igual cómo lleguen troceados (la cola sin cerrar espera a la siguiente lectura). Ya no se corta por silencio (el antiguo `FRAME_GAP_MS` de 75 ms partía tramas en ráfagas o con el hilo bloqueado). La hora de una trama es la de su `0xE0`. Ver `DS300-protocolo.md`
- **Lector único**: `src/lib/dsProtocol.js` (`decodeFrame`, separador, `sameBytes`) lo usan `SerialService`, el visor (`frameDecoder`) y el importador de simuladas (`dsFrames`). No duplicar reglas de trama fuera de ahí ni de `dsModels`
- **Cruce o evento**: lo decide byte[7] (`0x1B` = cruce; cualquier otro = evento según byte[8]), como TicTacSlot y en todos los modelos (`dsModels.isCrossingFrame`). NO por byte[10]: el GO de clase `0x3A`/`0x3B` lleva datos ahí y se leía como cruce
- **Checksum**: byte[18] = (byte[1..17] + byte[19]) & 0xFF; la trama que no cuadra se descarta (`checksumOk`)
- **GO** (`0xA1`): cualquier clase de evento (`0x3E` DS-300, `0x3A` club, `0x3B` por vueltas). Duración por formato (`goDurationMs`): `0x3A` → [9][10] = H MM S; `0x3E` → [9]=_H, [10]=MM, [11]=S_; otra clase → sin duración (la de la carrera). El verde `0xA3` sin aviso previo arranca (reiniciando contadores por carril) o, en pausa, reanuda
- **Lane**: byte[10] — bitmask no secuencial: `0x80→1, 0x40→2, 0x20→3, 0x10→4, 0x08→5, 0x04→6, 0x02→7, 0x01→8`; `0xAC` = carril 1 (TicTacSlot)
- **Tiempo de vuelta**: bytes[14-17] BCD (`ds300Byte()`): minutos, segundos, centésimas, diezmilésimas. Si algún nibble es A-F = primer cruce (sin tiempo válido). Las vueltas de más de 240 s SE CUENTAN (la caja las cuenta); solo no entran en la media del carril con la que se reponen vueltas perdidas
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
| TicTac | `tictac` | la caja, por orden de PitWall (`remoteGo`): los botones mandan C1..C4 y el aparato hace el semáforo, abre/corta el relé de la pista y avisa con sus eventos. Su reloj sigue contando en pausa, así que aplica la compensación de pausa del DS |
| Simulación | `simulation` | PitWall |

- `SerialService.softwareGo` (BART \| simulación \| TicTac) = botones GO/PAUSE/STOP en directo, entrenamiento y **pole**. En BART y simulación PitWall da el GO (semáforo de 3 s). `SerialService.remoteGo` (TicTac) = los botones solo mandan la orden (`sendGo(durationMs)`, `sendPause`, `sendResume`) y la manga/entreno/pole se mueve con las señales `race_*` que devuelve la caja, como con un DS; el GO se marca para quien lo pulsó (`GoOwnerService.armRemoteGo`, caduca a los 20 s). Si el aparato no contesta (o no está), `TicTacConnection` sigue por su cuenta con su semáforo de 3 s. `sendStop` es aviso: PitWall ya cerró lo suyo y solo corta la corriente. `SerialService.endsByTimer` (simulación \| TicTac) = nadie avisa del fin: `TimingService` cierra justo al agotar el tiempo (los DS llevan un respaldo de 30 s de silencio). Usar estas propiedades, no `isBart`, para decidir quién manda.
- `sendStart()` en `TicTacConnection` (lo llama también su verde) borra las referencias de reloj por carril: el primer cruce tras el GO sale sin tiempo = vuelta de salida desde el GO. Con la manga viva (`setExternalRaceState`) una vuelta larga no se descarta como «primer cruce» (pausas largas).
- Modelo de DS: `circuits_serial[].model` (el DS-300 no se guarda; es el valor por defecto). El latido de 60 s solo se vigila en el DS-300.
- **Reposición de vueltas del TicTac** (`TicTacConnection._repone`): solo con TRES pruebas a la vez — salto del nº de vuelta del aparato, tramas perdidas según su contador de secuencia `[1]` (+1 por trama, de todos los carriles; la captura real del club no salta nunca) y tiempo plausible frente al ritmo típico (mediana de las últimas 9 vueltas reales). Las `k` vueltas del tramo salen como `missed:true` (is_estimated=1) a ese ritmo; `TimingService` nunca las deja ser mejor vuelta y `PoleTimingService` las ignora. El nº de vuelta del aparato solo no basta: no se sabe cuándo lo reinicia.
- La vuelta de bandera usa la misma ventana `late_crossing_grace_ms` con cualquier dispositivo (DS, BART, TicTac y simulación); 0 en Ajustes la apaga. Con TicTac y BART no hay reposición por contador del DS (`getDsLapCounters`), así que lo que cruce fuera de la ventana no suma.
- `node-hid` es `optionalDependencies`: si falta, la fuente TicTac USB avisa y el resto funciona. Si se copia a mano en `node_modules` (el `package-lock.json` está obsoleto desde la v1.27.0, y un `npm install` reescribe media carpeta), hay que anidar también `node-addon-api` 3.x en `node_modules/node-hid/node_modules/`: PitWall tiene la 7.x hoisted y sin la 3.x `electron-builder` falla con «Production dependency node-addon-api not found». Tras tocar `node_modules`, comprobar con `electron-builder --mac --dir` en una copia aparte. `npm run native:clean` / `native:dev` limpian y reconstruyen `better-sqlite3` **y** `node-hid` (sin lo segundo, los instaladores reutilizan el `HID.node` de la plataforma anterior).

---

## Actualizaciones de la app (Electron)

- `electron/updater.js`: la comprobación es propia (lee `latest*.yml` de `https://www.pitwall.es/software/pitwall-manager/` con `?noCache=` para saltar Cloudflare y compara versiones); `electron-updater` solo descarga e instala. Modo `auto` (Mac, Windows NSIS, AppImage) o `manual` (portable de Windows, .deb, sin empaquetar: abre la web). Log en `userData/logs/updater.log`.
- Antes de `quitAndInstall`: `GET /api/app/update-guard` (no con manga/entreno/pole viva) → `POST /api/app/pre-update-backup` (`services/UpdateBackup.js`, copia junto a la BD, 3 últimas) → se para el servidor. Ambas rutas solo desde localhost.
- **Publicar una versión** en esa carpeta del servidor SIN renombrar: `latest-mac.yml` + `PitWall-X-arm64-mac.zip` + `PitWall-X-mac.zip`; `latest.yml` + `PitWall-Setup-X.exe` (del build hecho en Windows); `latest-linux.yml` + AppImage; con sus `.blockmap`. Los `.yml` se suben LOS ÚLTIMOS: si no, un cliente ve una versión cuyos ficheros aún no están. El servidor responde 200 HTML a lo que no existe → el cliente lo da como «no se ha podido comprobar».
- Mac: Squirrel exige la misma firma Developer ID en la versión nueva. Al instalar, ShipIt cierra TODAS las copias de la app (también la de PitWall Videos) y reabre la app sin argumentos (datos y puerto por defecto).
- `PITWALL_UPDATE_FEED=http://127.0.0.1:8765/` apunta el actualizador a un servidor local para probar el ciclo completo (dos builds `--mac zip`, la nueva servida con `python3 -m http.server`). Con otra copia de PitWall abierta, ShipIt la cierra y el relanzado abre los datos por defecto: probar con PitWall cerrado o contarlo.
- `electron-updater` está fijado a 6.8.3 (usa `builder-util-runtime` 9.5.1, el mismo que ya hay en la raíz) y se copió a mano en `node_modules` junto con `tiny-typed-emitter`, como `node-hid` (no hacer `npm install`).

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
- **Entrada de bytes**: `_onData` → `_processFrame(bytes, ts)` (también la usan `feedFrame` y los tests) → separador del flujo → `_handleFrame(trama)`. El DS manda cada trama 2-3 veces: se descarta la trama idéntica a la última aceptada de esa caja (`_lastFrameByBox`, por `byte[4]` con agrupador), llegue junta o separada; la firma por carril (`_lastSigByLane`) es la segunda red. Con depuración activa se registran los bytes tal y como llegan (`serial_raw`) para poder reproducir una sesión.

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
- **Coma manual (`manga_lanes.coma_manual`)**: corrección opcional del operador sobre la coma (Ajustes → Preferencias → `manual_coma`, apagada por defecto). Se escribe en SECTORES al acabar cada tanda (`TandaSummaryController`, `/races/:id/tandas/:tandaId/summary`, solo con todas sus mangas `finished`) y se guarda como fracción en la última manga de cada participante en esa tanda; la escala es `coma_sectors` (Preferencias, 100 por defecto, `utils/settori.js`). Botón «Sectores» en directo, ficha (`Tanda.lastFinishedId`) e inicio (`homeLiveState.sectorsTandaId`). `Lap._lastMangaByEntity`/`_comaByEntity` resuelven el valor efectivo (manual si el ajuste está activo) y `utils/tieBreak` le da prioridad sobre el instante del cruce. La coma NO vive en `laps`: `Manga.setLaneComa` y `Manga.updateStatus('pending')` (manga que se vuelve a correr) hacen el `markExternalMutation()` explícito, y `SettingsController.savePrefs` invalida contadores + cachés del motor al cambiar el ajuste — sin eso, resultados/móvil/directo servirían el orden viejo.
- **`LiveStatsController.json`**: los agregados race-wide (pace/consistencia/progreso de toda la carrera) viven en `src/engine/raceWideStats.js` y los calcula el mismo worker (`requestRaceWide`). El controlador guarda el último paquete en `_rwCache` y pide un refresco en segundo plano (`_kickRaceWideRefresh`); solo calcula en el hilo si no hay worker o es la primera vez. `json` sigue siendo síncrono.
- **Pre-calentado de cachés (`TimingService._warmStatsCaches`)**: lo llama `invalidateStandingsCaches` (arranque de manga, fin de circuito, corrección). Calienta síncronamente `_priorAggregates` y `raceAggregate` (que arrastra `startSettledByEntity`, ~85 ms en frío) y pide al worker proyección + race-wide, para que el primer cruce no pague nada en frío. `Lap.noteMangaSeen(mangaId)` registra la manga sin contar mutación, para que el 1er cruce no dispare el guard de `mutatedMangaCount`. Estos momentos no tienen cruces (semáforo / fin de manga), así que el coste síncrono no importa.
- **Correcciones con manga viva (`TimingService.applyLapCorrection(raceId, mangaId)`)**: `LapCorrectionController` la llama tras cada acción. Rehace los contadores en memoria de la manga viva desde la BD (conservando el último cruce físico), numera el siguiente cruce tras la vuelta más alta (`ld.lapNumOffset`), refresca la mejor vuelta, invalida cachés y emite `standings` + `laps:corrected`. Sin esto el directo no cambiaba hasta el siguiente cruce y salían números de vuelta repetidos.
- **Reloj de la manga (`TimingService.now()`)**: toda lectura de reloj de la manga (arranque, circuitos, pausas, fin, coma/`last_cross_ms`, tick, standings, ventanas de bandera, auto-fin) va por `now()`, también en `MobileController` y `LiveStatsController`; no usar `Date.now()` ahí. Fuera de simulación es `Date.now()`; en la carrera simulada es el de las tramas (solo mientras `SerialService._simReplay` es true; `connectMultiple` y `startSimulation` lo apagan): `SimPlayerService` llama a `simSetClock(ts, rate, cap)` en cada trama (avanza a ×velocidad sin pasar la siguiente), `simSetRate(0)` congela (pausa del panel) y `simClearClock()` al parar. Mezclar relojes dejó desde v1.28.2 hasta v1.64.1 `elapsed_ms` negativos y coma/desempate rotos en la simulada.

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
- **Vistas del directo** (botón «Vista», `selectView`): `1` filas, `3` tarjetas con detalles, `4` **tarjetas fijas por carril** (`body.view-fixed` + `.live-lanes--fixed`). En la 4 `sortCards` fija `order` = nº de carril (sin FLIP/`ReorderFX`; los descansos van ocultos y salen en `#mangaRest`), la clasificación acoplada va siempre visible y `#mangaPanel` (la clasificación de LA manga, `renderMangaStandings`) se pinta encima de la general. `#sideBtn` no pinta nada en esa vista. `?view=4` la fuerza sin guardarla.

---

## Convenciones de código

- **Models**: métodos estáticos sobre `better-sqlite3`, síncronos. Sin ORM. Nombres: `findById`, `findAll`, `create`, `update`, `updateStatus`.
- **Controllers**: funciones exportadas `module.exports = { action }`. Leen `req.params/body/session`, llaman a models/services, renderizan EJS o redirigen.
- **Tests**: `npm test` (`node --test`, sin dependencias nuevas). Cubren turnos de piloto, informe, pre-arme, el lector de tramas DS (`ds-protocol`, `ds-lectura-tictac`, `serial-frames`; las tramas de prueba se cierran con `test/helpers/dsFrame.js` → `sellar()`, o el checksum las descarta), los endpoints peligrosos, el motor puro de proyección (`race-projection-engine`), el worker de stats (`stats-worker*`, `timing-projection-worker`, `lap-settled-cache`), la contraseña de acceso (`access-password`), la corrección de vueltas con manga viva (`lap-correction-live`) y el historial «las 10 mejores» de entrenos (`training-best-laps`). La rotación de carriles y el resto de estadísticas **siguen sin cobertura**.
- **Banco de pruebas**: emulador DS-300 (`/Users/victor/ds300-emulator/emulator.js`) y `node scripts/rehearsal-shifts.js` (ensayo E2E sobre 3 cajas, 24 carriles).
  Las rutas `/api/test/*` y `/api/rawlog` simulan las señales del DS, pero **solo se montan con `PITWALL_TEST_ENDPOINTS=1`**: `/api/test/stop` borra todas las vueltas de la manga activa, así que no puede existir en la máquina de una carrera.

## Variables de entorno (además de las del README)

- `PITWALL_TEST_ENDPOINTS=1` — monta las rutas `/api/test/*` y `/api/rawlog` (solo banco de pruebas).
- `PITWALL_NO_WORKER=1` — desactiva el worker_thread de stats; la proyección/agregados se calculan en el hilo principal (idéntico resultado, pero bloqueante).
- `PITWALL_DB_READONLY=1` — abre la BD en solo lectura, sin migraciones ni `ANALYZE`. Lo usa el worker de stats internamente; no ponerlo en el proceso principal.
- `PITWALL_UPDATE_FEED=<url>` — otro servidor de actualizaciones (pruebas del ciclo completo); por defecto pitwall.es.
- `PITWALL_NO_AUTOBACKUP=1` — no hace la copia de la BD al arrancar (`services/AutoBackup.js`: `VACUUM INTO` en `<datos>/_backups-auto/` antes del esquema y las migraciones; 5 últimas, una cada 6 h por versión; nunca en el worker de solo lectura ni en los tests).
- `PITWALL_DISABLE_PASSWORD=1` — ignora la contraseña de acceso (Ajustes → Seguridad) mientras esté puesta. Es la vía de recuperación si se olvida: arrancar con ella, entrar y poner otra (o desactivarla).
- **i18n**: TODO texto visible va por `req.t('key')` en controllers, `t('key')` en vistas y **`I18N.t('key')` en el JS de cliente** (dentro de `<script>` y en `public/js/`). **Nunca ternarios de idioma** (`lang === 'es' ? … : …`): no admiten un tercer idioma y eran 1.900 repartidos por las vistas.
  - En el navegador el ayudante es `I18N.t`, **no `t`**: el JS de cliente ya declara su propio `t` en una docena de sitios (bucles, temporales) y llamarlo `t()` los rompe. El diccionario llega en la página por `partials/i18n-client.ejs`, que va en el header y en las trece vistas autónomas (directo, TV, Le Mans, Lap, QR, paneles: no incluyen el header). `es.json` es la fuente del español; al añadir texto hay que dar de alta la clave en `es.json`, `en.json` e `it.json` (en `it.json` se pone el español como provisional, nunca una clave cruda).
  - Herramientas: `scripts/i18n-extract.js` (convierte ternarios → `t()` y avisa de lo que no puede y de los choques con una variable `t` local), `scripts/i18n-snapshot.js` (arnés de instantáneas HTML para verificar que una conversión no cambia el render), `scripts/i18n-kit.js` (exporta el diccionario a CSV para el traductor y lo reimporta).
  - En el navegador: `I18N.t('client.<sección>.<clave>', {vars})`. El diccionario de cliente lo arma `clavesDeCliente()` (`middleware/i18n.js`) **buscando en el código las llamadas literales** `I18N.t('…')`: una clave montada en tiempo de ejecución (`I18N.t(cond ? 'a' : 'b')`, `I18N.t('x.' + k)`) no viaja. Escribir `cond ? I18N.t('a') : I18N.t('b')`, o añadir la sección entera a `SECCIONES_ENTERAS` (como `client.tramas`).
  - Texto del servidor dentro de un `<script>`: `<%- JSON.stringify(t('k')) %>`, no `'<%= t('k') %>'` (un apóstrofo saldría `&#39;`).
  - Errores con código, no con frase: `TandaImportError(msg, key, vars)` → el controller hace `req.t('tandaimport.' + e.key, e.vars)`. Fuera de una petición (exportaciones con `?lang=`), `require('../middleware/i18n').translator(lang)`.
  - El `t` del servidor no cae al español clave a clave: toda clave nueva va en los tres JSON.
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
