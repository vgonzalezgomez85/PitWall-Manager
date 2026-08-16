# Historial de versiones — PitWall

La versión vive en `package.json` y se muestra en el pie de la app (enlaza a `/changelog`).

**Criterio de numeración (vMAYOR.MENOR.PARCHE):**
- **v1.0.X** — correcciones y ajustes pequeños (fixes, retoques visuales, textos).
- **v1.X.0** — funcionalidades nuevas (una feature completa).
- **vX.0.0** — cambios muy grandes (rediseños, rupturas de compatibilidad).

Cada cambio que se mergea debe subir la versión y añadir aquí su entrada, en la
sección que toque: **Añadido** (nuevo), **Mejorado** (existente a mejor),
**Corregido** (bugs).

---

## [1.28.5] — 2026-08-17

### Mejorado
- **Lap web y live-stats aguantan mejor bien avanzada una carrera de 24h.** Dos vistas (el resumen de equipo de Lap web y el "Gap de vueltas" de live-stats) recalculan un agregado de TODA la carrera acumulada hasta ahora, no solo de la manga en curso — cuanto más avanzada la carrera, más caro ese cálculo. Ambas ya tenían caché, pero con un tiempo de vida fijo de 1 segundo: bien al principio, insuficiente pasadas muchas mangas, cuando recalcular una vez por segundo por sí solo puede saturar el proceso. Ahora el tiempo de vida de la caché crece con el número de mangas ya corridas (hasta 10 s con muchas), sin que se note en pantalla. Detectado con un perfil de CPU (`node --prof`) bajo una carrera de 48 mangas/24 carriles con 30-180 espectadores simulados en Lap web: eliminó los errores HTTP y redujo a la mitad la latencia típica de live-stats bajo esa carga. No afecta al cronometraje ni al recuento de vueltas.

## [1.28.4] — 2026-08-16

### Mejorado
- **Menos trabajo de sesión en cada petición, bajo mucha carga de espectadores.** Un middleware interno tocaba (y por tanto reescribía) la sesión en TODAS las peticiones, aunque el 99,9% nunca tenían un mensaje pendiente que mostrar — con el polling de Lap web y live-stats (cientos de peticiones por segundo con muchos espectadores conectados a la vez) eso suponía muchas escrituras de sesión de sobra, identificado con un perfil de CPU bajo carga simulada de 600 espectadores. Ahora solo se toca la sesión cuando de verdad hay algo que mostrar; el comportamiento para el usuario es idéntico. No afecta al cronometraje.

## [1.28.3] — 2026-08-15

### Corregido
- **El margen de la v1.28.2 no bastaba con congestión severa.** Verificado contra la máquina real de la 24h de Llinars con 600 espectadores simulados: con picos de latencia de hasta ~31s (red real, no en local), el margen fijo de 15s del temporizador de auto-fin se quedaba corto y se seguían perdiendo vueltas. Ahora, además del margen, **cada cruce real de un circuito reinicia su propio temporizador de auto-fin** — así el respaldo por tiempo agotado cuenta el tiempo desde el ÚLTIMO cruce visto de ese circuito, no desde el inicio de la manga, y nunca dispara mientras sigan llegando cruces (aunque lleguen tarde). Solo se activa tras un silencio real del circuito, sea cual sea el nivel de congestión del servidor. Reverificado en local (24 carriles, 600 espectadores): recuento de vueltas idéntico con y sin carga.

## [1.28.2] — 2026-08-15

### Corregido
- **Cronometraje: ya no se puede perder la última vuelta de un circuito al final de una manga.** Cada circuito tiene un temporizador de seguridad que lo cierra por tiempo si su caja nunca manda la trama de fin (para que una caja averiada no cuelgue la manga para siempre) — pero corría contra el reloj real del servidor, compitiendo con la llegada de la trama de fin de verdad. Si el procesado de esa trama se retrasaba aunque fueran unos segundos (por ejemplo con mucha gente conectada a estadísticas en directo a la vez), el temporizador de seguridad podía adelantarse, cerrar el circuito, y la última vuelta legítima que llegaba justo después se descartaba sin ningún aviso. Ahora ese temporizador tiene un margen de 15 segundos: la trama de fin real siempre gana esa carrera salvo que el circuito esté genuinamente parado. Detectado y verificado con una prueba de estrés de 24 carriles y 600 espectadores simulados en los tres canales (app, Lap web, estadísticas en directo).
- Corregido también un fallo relacionado en "carrera simulada" (la función de pruebas sin hardware DS-300): al reponer vueltas perdidas por un corte de cable usaba el reloj del servidor en vez del de la propia trama, lo que bajo carga podía descuadrar el recuento de vueltas de la simulación.

## [1.28.1] — 2026-08-13

### Corregido
- **El instalador de macOS ya muestra el icono de PitWall en Finder.** El fichero `.dmg` generado al construir la app para Mac se veía en Finder con el icono genérico de "imagen de disco", aunque el icono de PitWall sí aparecía correctamente al abrirlo (dentro del volumen montado). Ahora el propio instalador `.dmg` también lleva el icono de la app.

## [1.28.0] — 2026-08-12

### Añadido
- **Elegir equipos del catálogo con un toque, en dos sitios más.** Además del autocompletado de texto que ya sugería equipos al escribir, ahora aparece un panel con una **tarjeta por cada equipo del catálogo** (nombre y nº de pilotos) para añadirlo de un clic, sin teclear nada:
  - En el paso **Participantes** del asistente de nueva carrera (cuando la carrera tiene **Pole**), un clic en una tarjeta rellena el siguiente hueco libre con el nombre del equipo **y sus pilotos**.
  - En **Entrenamiento de competición**, un clic en una tarjeta pone al equipo en el siguiente carril libre.
  Las tarjetas ya usadas se atenúan y dejan de poder pulsarse; si el equipo no está en el catálogo, se sigue pudiendo escribir su nombre a mano (el botón pasa a llamarse **"+ Añadir equipo a mano"** en el asistente, para dejar claro que el catálogo es ahora el camino más rápido).

## [1.27.0] — 2026-08-12

### Añadido
- **Restaurar una copia de seguridad desde la propia app.** La tarjeta "Importar copia" de `/database` (Base de datos) ya no es un aviso de "próximamente": ahora se puede subir un archivo `.db` (descargado antes con "Descargar copia de seguridad", de este PC o de otro) para restaurar todos los datos. La subida se valida al momento (tiene que ser realmente una base de datos SQLite) y queda pendiente sin tocar nada: se aplica en el siguiente arranque de PitWall —hay que cerrarlo del todo y volver a abrirlo—, momento en el que se guarda automáticamente una copia de seguridad de los datos que había antes, por si hace falta deshacer. Se puede cancelar una importación pendiente en cualquier momento antes de reiniciar.

### Corregido
- **Las banderas de país de los equipos ya se ven en Windows.** Desde la v1.26.0, en algunos PC con Windows solo se veían la senyera de Catalunya y la ikurriña de Euskadi: el resto de banderas (~99 países) no aparecían porque Windows, salvo en builds muy recientes, no compone el emoji de bandera y muestra el código de dos letras en texto o nada. Ahora esas banderas se dibujan siempre como icono (igual que ya pasaba con Catalunya y Euskadi), así que se ven igual en cualquier sistema operativo.

## [1.26.0] — 2026-08-12

### Añadido
- **Bandera de Euskadi (ikurriña), junto a la de Catalunya.** El selector de país de los equipos no tenía forma de representar la ikurriña —no existe como emoji Unicode, igual que la senyera—, así que se añade como una segunda "bandera dibujada" en el mismo selector: al elegir "Euskadi" aparece la ikurriña (fondo rojo, aspa verde, cruz blanca) en la ficha del equipo, en la tabla de `/teams`, en el importador CSV (también reconoce "país vasco", "euskadi", "euskal herria", "vascongadas" o "basque country" al importar) y en las pantallas de entrenos y de asignación de carriles.
- **Exportar los QR de los pilotos agrupados por equipo.** Nuevo botón «Exportar QR» en `/teams` que abre en una pestaña nueva una página lista para imprimir con el código QR de cada piloto del club, agrupados por equipo (nombre y categoría como cabecera de cada bloque). Los equipos sin pilotos se marcan como «Sin pilotos», y los miembros de equipo que todavía no tienen un piloto del club vinculado se marcan «⚠️ sin perfil» en vez de mostrar un QR. Complementa a la exportación ya existente de todos los pilotos sin agrupar.

### Mejorado
- **Las categorías de equipo, en `/teams`, ya se distinguen por color.** El indicador de categoría de cada equipo era siempre morado, sin distinción; ahora usa la misma paleta de colores por categoría que ya pinta el directo y la clasificación Le Mans (el mismo color para la misma categoría en toda la app).
- **La columna de país de `/teams` ya no se queda en blanco.** Los equipos sin país asignado mostraban esa celda vacía; ahora muestran un icono 🌐 atenuado a modo de aviso, para distinguir de un vistazo "sin país" de "cargando".

## [1.25.11] — 2026-08-11

### Añadido
- **Estadísticas en vivo: carril y piloto en la clasificación de la manga actual.** La tabla "Clasificación de manga actual" de `/races/:id/live-stats` muestra ahora el carril de cada participante y, en carreras por equipos, el piloto que lleva el carril ahora mismo (el turno más reciente registrado en esta manga, mismo origen que el directo). En carreras individuales no aparece la columna de piloto, porque el participante ya lo es.

## [1.25.10] — 2026-08-11

### Corregido
- **Estadísticas en vivo: al dar el GO, la pantalla ya no se quedaba mostrando la manga anterior como "finished".** La caché de `/races/:id/live-stats.json` daba por buena una respuesta de hasta 1 segundo de antigüedad sin comprobar si mientras tanto la manga había pasado de no-activa a activa (p.ej. al relanzar una manga ya corrida) — si la petición llegaba justo en ese salto, se servía el payload viejo ("finished", reloj a 00:00) aunque la manga ya estuviera corriendo de verdad. Ahora la caché también guarda si la respuesta se calculó con la manga activa o no, y solo se reutiliza si coincide con el estado actual.
- **Estadísticas en vivo: la pestaña "Comparativa por carril" no aparecía si se abría la página antes de la primera vuelta de la carrera.** Esa sección solo se genera en el servidor si ya hay algún carril con datos, así que si no había corrido ni una vuelta, ni siquiera existía en el HTML y ningún refresco por socket podía rellenarla. Ahora, en ese caso concreto, la página se recarga sola una vez en cuanto se da el primer GO de la carrera para que el servidor la incluya ya completa; el resto de mangas siguen refrescándose sin recargar, como hasta ahora.

## [1.25.9] — 2026-08-11

### Mejorado
- **El "Gap V" de las tarjetas del directo ahora es el gap REAL, no el estimado.** Antes mostraba la diferencia proyectada a fin de carrera (podía dar valores enormes, tipo "-33.60", en una 24h con muchas mangas por delante). Ahora muestra las vueltas de distancia YA corridas respecto al que va delante ahora mismo, con un decimal que afina con la fracción de vuelta en curso de cada uno (tiempo desde su último cruce ÷ su media). Si van a la par en vueltas enteras, muestra en su lugar el gap real en segundos entre sus últimos cruces de esta manga, para hacerse una idea de lo lejos que están en pista.

## [1.25.8] — 2026-08-11

### Corregido
- **Los botones del directo (clasificación general, minimapa, Le Mans, corrección de vueltas, registro de sucesos) ya no se abren en pantalla completa ni se quedan "bloqueados".** Antes unos usaban `target="_blank"` (en muchos navegadores abre en pestaña de la MISMA ventana: con el directo en pantalla completa, parecía que se había cerrado) y otros ya abrían ventana aparte pero, al estar el directo en pantalla completa, la ventana nueva se abría también a pantalla completa o quedaba oculta detrás sin poder interactuar con ella. Ahora los 5 pasan por un `openPanel()` común que sale de pantalla completa ANTES de abrir la ventana emergente (tamaño fijo, sin pantalla completa), dejando el directo detrás tal cual estaba; al volver a esa pestaña, el primer toque restaura la pantalla completa solo (mismo mecanismo de la v1.25.7).

## [1.25.7] — 2026-08-11

### Corregido
- **La pantalla completa del directo ya no se pierde con cada recarga.** La vista `/live` se recarga sola varias veces durante una manga (tras el semáforo, fin de manga, pausa/reanudación...) y el navegador sale de pantalla completa en cada una — es una restricción de seguridad del propio navegador que ninguna web puede evitar por JavaScript (reentrar exige un gesto del usuario). Ahora, si se salió de pantalla completa por una recarga (no por Esc o el botón), el primer toque/clic/tecla que dé el director en la página nueva la restaura sola, sin tener que volver a buscar el icono.

## [1.25.6] — 2026-08-11

### Mejorado
- **Clasificación en vivo de la pole más legible en pantalla grande.** En `/pole/timing`, el panel "🏆 Clasificación en vivo" ya no recorta con "…" los nombres de equipo largos: la vista ahora aprovecha toda la pantalla (antes se quedaba encorsetada en el ancho del resto del sitio) y calcula sobre la marcha cuántas columnas hacen falta, estirándolas para llenar el hueco vacío que antes quedaba a la derecha en monitores anchos.
- **Categoría del equipo, también en la pole.** La clasificación en vivo de la pole muestra ahora la categoría de cada equipo junto a su nombre, coloreada igual que en el directo de carrera (mismo color para la misma categoría en ambas pantallas).

## [1.25.5] — 2026-08-11

### Corregido
- **La pole ya no se quedaba "congelada" tras un stop forzado.** Al parar a un piloto a mitad de tanda (botón ⏹ "Parar" o stop físico del DS-300), si el siguiente GO físico llegaba antes de pulsar manualmente "Iniciar" en pantalla, el sistema lo descartaba en silencio: el piloto seguía marcado "EN PISTA" en la lista pero el panel se quedaba en "PREPARADO" sin responder a ningún clic. Ahora el stop forzado re-arma al mismo piloto en el acto, así el siguiente GO ya no se pierde. Verificado en caliente durante una carrera real; no tiene relación con el interruptor de cambio automático de piloto.

## [1.25.4] — 2026-08-10

### Corregido
- **El anuncio mDNS ya no dice "voltrace-manager".** El `type` del servicio Bonjour pasa de `'voltrace-manager'` a `'pitwall-manager'` (decisión explícita: se rompe a propósito el descubrimiento de la app Android "Infolap" desactualizada que dependía del nombre viejo; el cliente soportado hoy es PitWall Lap). Cambio coordinado con el cliente móvil, que ahora busca `_pitwall-manager._tcp`.

## [1.25.3] — 2026-08-10

### Corregido
- **Últimos restos del nombre "SloTime" en el código.** Variables de entorno (`SLOTIME_DATA`→`PITWALL_DATA`, `SLOTIME_RAW_DUMP`→`PITWALL_RAW_DUMP`), claves de `localStorage` del navegador (con migración automática del valor guardado, sin perder preferencias), el autor grabado en los `.xlsx` exportados, el secreto de sesión por defecto, el nombre interno del paquete npm y los scripts/documentación de desarrollo. Se deja intacto adrede el `type: 'voltrace-manager'` del anuncio mDNS (lo usa la app Android "Infolap" para descubrir el servidor) y el nombre de la carpeta legacy "Voltrace Manager" en la migración de datos de Electron.

## [1.25.2] — 2026-08-10

### Corregido
- **Limpieza de código muerto en el servidor.** Métodos de modelos, exports y wrappers que ya no llamaba nadie (Car, Driver, DriverShift, Lap, Race, Team, el lado "master" nunca usado del protocolo BART, SerialService, `isLocalRequest`, `DebugLogger.logError`).
- **El fichero de la base de datos pasa a llamarse `pitwall.db`** (antes `slotime.db`, nombre heredado de antes del cambio de marca). Migración automática al arrancar: si no hay `pitwall.db` pero sí `slotime.db`, se renombra en sitio (con `-wal`/`-shm`) sin perder datos; cubre también la migración legacy de instalaciones "Voltrace Manager".

## [1.25.1] — 2026-08-10

### Añadido
- **Botón «Pines Lap» en la ficha de la carrera.** Antes solo se llegaba a la hoja de PINs dando un rodeo por `/lap/<id>` → enlace de organización; ahora hay un acceso directo junto a Turnos/Neumáticos/Sucesos (solo en carreras por equipos).

### Mejorado
- **La hoja de PINs se ve entera sin hacer scroll.** Con carreras grandes (24 equipos o más) se repartía en una sola columna y se salía de la pantalla; ahora se ajusta sola al alto de la ventana, repartiendo los equipos en tantas columnas como haga falta.

## [1.25.0] — 2026-08-10

### Añadido
- **Los invitados ya pueden seguir la pole en directo.** El tablero de cronometraje de pole (antes solo visible para el operador) es ahora accesible sin restricción de IP, en modo solo lectura: se ocultan los controles (iniciar/parar/siguiente) y se ve en tiempo real quién está en pista, el orden de salida y la clasificación provisional. Accesible desde «Estadísticas en vivo» y con una tarjeta nueva en la home de invitado cuando hay una pole en marcha.
- **PitWall Lap funciona durante la propia pole, no solo tras terminarla.** Los equipos (con su PIN) se crean ya al confirmar el asistente de carrera, en vez de esperar a asignar los carriles al final de la pole. Cada equipo ve en su panel si le toca ahora, un cronómetro en vivo de su intento, sus vueltas y su mejor tiempo, con la voz cantando cada vuelta igual que en carrera; al terminar la pole, el panel pasa solo a mostrar su resultado (posición y tiempo).

### Corregido
- **La estrategia de neumáticos de Lap podía mostrar un número de juegos disparatado.** El widget usaba un contador local del propio móvil (4 juegos por defecto) sin relación con la dotación configurada en la carrera ni con las entregas reales registradas por la organización. Ahora, si la carrera lleva control de neumáticos, usa siempre ese dato real (y bloquea la configuración manual, que queda solo de respaldo para las carreras sin control).
- **La pantalla de pole podía quedarse con el nombre del piloto anterior.** Estaba pensada para que solo la viera el operador, que siempre recargaba la página al pasar de piloto; con un espectador que se queda varios pilotos seguidos (el tablero nuevo de invitados, o Lap), el piloto en pista y el orden de salida se quedaban congelados en el primero. Se corrige actualizándose por socket sin recargar.

### Mejorado
- **La vista de Lap donde eliges la carrera** usa ahora el mismo estilo del resto de la web (cabecera, botón de volver) en vez de su propia página independiente.
- **«Cambiar equipo» en el panel de Lap** se ve como un botón, no como un enlace de texto suelto.

## [1.24.1] — 2026-08-10

### Mejorado
- **Línea separadora entre filas en las vistas «Cuadrícula compacta» y «Tarjetas con detalles» del directo.** Ahora se distingue de un vistazo dónde termina una fila de tarjetas y empieza la siguiente, útil con muchos carriles en pantalla.

## [1.24.0] — 2026-08-10

### Añadido
- **Registro de sucesos de carrera.** Nueva página «🗒️ Sucesos» (accesible desde la ficha de la carrera y con un botón nuevo en la cabecera del directo) que muestra, manga a manga, todo lo que va pasando durante la sesión en formato fácil de leer: **GO** (también cuando se da en varias cajas por separado, circuito a circuito, algo que antes no quedaba registrado), **pausa y reanudado** por circuito, **fin de manga**, **cancelación**, **recuperación tras un corte**, **vueltas fantasma/ignoradas** y su **reasignación** al carril correcto, **salidas retroactivas** y los **fichajes de piloto** (QR, cambio en caliente o corrección manual). Las mangas se muestran compactadas por defecto —solo la que está en marcha aparece abierta— y se despliegan con un clic en su cabecera; un checkbox permite ocultar los fichajes de piloto rutinarios previos al GO cuando solo interesa el resto de sucesos. Disponible en español e inglés.
- **Se refresca en vivo.** Con la manga en marcha, la página va sumando los sucesos nuevos según ocurren, sin recargar.

## [1.23.0] — 2026-08-10

### Añadido
- **La lista de pole ya se puede reordenar arrastrando.** En «Configurar Pole Position», los participantes se muestran en una cuadrícula numerada (1, 2, 3…) que se ajusta sola al ancho de la pantalla y rellena por columnas —coincidiendo con los grupos de circuito C1/C2/C3—, y ahora se pueden arrastrar a mano para cambiar el orden de paso, además del botón «Aleatorio» que ya existía.
- **Cambio automático de piloto en pole.** Nuevo interruptor «Cambio automático de piloto» junto al de «Omitir 1er cruce»: con la casilla activa, al terminar el intento de un piloto el botón «Siguiente piloto» hace una cuenta atrás de 3 segundos y avanza solo, sin esperar el clic manual. Es una preferencia del puesto de control (se guarda en el propio navegador), no de la carrera.

### Corregido
- **«Editar tiempos» de resultados de pole podía desplazar los tiempos a otro piloto, en silencio.** Al guardar el formulario de tiempos de la pole, si entre los participantes había un piloto cuyo identificador interno era el primero de la lista, el tiempo se desplazaba al piloto siguiente sin ningún aviso —un fallo del formato con el que viajaban los campos del formulario—. Confirmado y corregido de cara a la 24h de Llinars.
- **La página de tiempos de pole podía quedarse rota tras terminar un intento.** Un error de JavaScript en el cliente al marcar un intento como terminado dejaba inservibles el resto de botones de la página hasta recargarla. Ya no ocurre.

## [1.22.0] — 2026-08-09

### Añadido
- **«Conexión ecosistema»: interruptor para permitir o bloquear PitWall Control.** Nueva página en el menú Sistema (`/ecosystem`) con un único interruptor que decide si PitWall Control puede conectarse a este equipo desde la red local: enviar tandas (protegido con PIN) y leer los resultados de cada tanda. Desactivado, se rechaza cualquier conexión de Control desde otro dispositivo de la LAN; este equipo y las IPs de la allowlist de Ajustes no se ven afectados. Activado por defecto, para no cambiar el comportamiento de las instalaciones existentes. La misma página muestra el PIN de emparejamiento.
- **Verificaciones técnicas de PitWall Control, visibles en la carrera.** Con «Conexión ecosistema» activada, PitWall Control puede enviar por LAN (con el mismo PIN) el snapshot de las verificaciones técnicas de cada equipo por manga: pesos, motor, piñón/corona, llantas, trencilla, suspensión, bancada, chasis, neumático, validado y observaciones (con fotos). Dentro de la carrera aparece un botón «🔍 Verificaciones» en cuanto llega el primer envío, con una pantalla agrupada por manga. Es de **solo consulta**: en PitWall no se edita nada, cada envío de Control sustituye por completo las verificaciones de esa carrera.

### Mejorado
- **La categoría del equipo acompaña a su nombre en mejor vuelta y panel en vivo.** Cuando el equipo tiene categoría en el catálogo del club, la mejor vuelta de la manga y de la carrera, y las etiquetas del panel de pista en vivo, muestran ahora «Nombre - Categoría» en vez de solo el nombre.
- **El tiempo mínimo de vuelta se resincroniza al vuelo.** Si se corrige el `Pt` (tiempo mínimo de vuelta) de un circuito o de una de sus categorías, todas las carreras ya asignadas a ese circuito se actualizan automáticamente — antes se quedaban con el valor que tenían copiado desde que se les asignó el circuito, y podían acabar desincronizadas de la caja DS-300 real, marcando como vuelta fantasma tiempos que eran perfectamente válidos. El cambio se nota al instante, sin reiniciar la manga en curso.

### Corregido
- **«Eliminar pending setup» ya no da por terminadas carreras de paso.** Este botón de Diagnóstico completaba de paso cualquier carrera activa con una manga pendiente que no fuera la que estaba corriendo en ese momento — pero eso incluía carreras «huérfanas» (activas, con mangas de verdad por correr, simplemente sin nada corriendo en el motor en ese instante, por ejemplo tras un corte de serie). Ahora el botón solo libera el aviso interno del próximo GO, sin tocar el estado de ninguna carrera.
- **PitWall Lap ya no avisa por voz de «Último minuto» con la manga en pausa.** El motor de voz del cliente del equipo seguía extrapolando el tiempo restante por reloj de pared aunque la manga estuviera parada, así que el aviso de «Último minuto» o «Últimos 30 s» podía sonar tarde o no sonar al reanudar. Ahora se calla mientras dura la pausa y, al reanudar, resincroniza el reloj con el tiempo restante real del servidor.

## [1.21.0] — 2026-08-09

### Añadido
- **«Control de pilotos» ya es visible para invitados.** La home de invitado (IP externa no autorizada) suma una tarjeta «Control de pilotos» bajo «Carreras activas», que enlaza a `/control/shifts` (nueva ruta pública de solo lectura). El invitado ve las tarjetas de carril tal cual, pero sin ningún botón de acción: se ocultan la barra de cámara/escaneo, el lápiz de «Corregir tiempo» de cada carril y el enlace «Histórico» — los POST de fichaje/corrección siguen bloqueados por IP de todos modos.

## [1.20.0] — 2026-08-09

### Añadido
- **«Estadísticas en vivo» ya avisa de los cambios de neumático.** En resistencia con control de neumáticos activado, la columna «Salidas» de «Manga actual» y «Sal./Pit Total» de «Clasificación proyectada» añaden ahora, junto a las salidas/pit-stops, los cambios de neumático del equipo con el mismo indicador **🛞** que ya usa la pantalla en directo — el de la manga que se está viendo en la primera tabla, el TOTAL de la carrera en la segunda. Se refresca al instante con el socket `tires:changed`, igual que el resto del control.

## [1.19.1] — 2026-08-09

### Mejorado
- **La home de invitado agrupa sus accesos por título.** El acceso público (visitante externo sin IP autorizada) ahora separa sus tarjetas bajo dos secciones: «Carreras activas» (Estadísticas en vivo y Lap) y «Carreras pasadas» (Resultados), en vez de una única fila sin etiquetar.

## [1.19.0] — 2026-08-09

### Añadido
- **Cambio de posición con transición, en toda la app.** Cuando un equipo adelanta o es adelantado en la clasificación, la tarjeta o fila ya no salta de golpe a su puesto nuevo: se desliza hasta él y destella en **verde** (sube) o **rojo** (baja). Aplica a las **5 vistas** que reordenan una clasificación en vivo: las tarjetas del directo (las 3 variantes de vista), el pop-up «Clasificación General», el pop-up «Vueltas rápidas», la pantalla **TV** y la pantalla **Le Mans**. Respeta «reducir movimiento» del sistema.
- **Gap al siguiente, además del gap al líder.** Tanto en el directo como en «Estadísticas en vivo» (clasificación proyectada y clasificación de la manga actual), ahora se ve el hueco (en vueltas, o en tiempo si van empatados) respecto al que va **justo delante**, no solo respecto al líder de la general.
- **«Estadísticas en vivo» ya no depende de qué manga tengas seleccionada arriba.** La clasificación proyectada, el total de salidas/pit-stops y el tiempo perdido pasan a ser siempre de **toda la carrera** (mangas finalizadas + la que está en marcha), y el desplegable de manga/equipo y el check «Con salidas» —que no pintaban nada ahí— ahora solo se ven en la pestaña «Manga actual».
- **El equipo que descansa ya no desaparece.** En «Manga actual» sale igualmente, marcado como «💤 Descansando esta manga»; en la clasificación proyectada, quien esté descansando en la manga realmente en marcha lleva la misma marca junto a su nombre.
- **La cabecera del directo y del pop-up ya avisan de la pausa.** Antes se quedaban clavados en «En carrera» aunque la manga estuviera parada; ahora muestran «Pausada» (punto naranja) en cuanto se pausa, y vuelven a «En carrera» al reanudar.

### Corregido
- **El pop-up de clasificación dejaba de congelar el reloj al pausar.** El evento de reanudación del propio pausado («standings», que llega constantemente) volvía a poner en marcha el contador un instante después de que la pausa lo congelara — el reloj seguía bajando con la carrera parada. Ahora solo `manga:paused`/`manga:resumed` deciden si corre.
- **El aviso de «⏸ PAUSA» tapaba los botones de la cabecera.** Cubría toda la pantalla y bloqueaba clics en «Vista», «Sin voz», mapa, editar, Volver… Ahora cubre solo el área de tarjetas.
- **Al ver una manga ya finalizada, el orden de las tarjetas no cuadraba con el pop-up.** Sin manga activa, el directo recalculaba su propia proyección aproximada en el cliente en vez de usar la del servidor; ahora usa siempre la misma (`TimingService.buildRaceProjection`) que el pop-up y el resto de vistas.

## [1.18.0] — 2026-07-27

### Añadido
- **La app del piloto ya conoce el control de neumáticos de la carrera.** El detalle de carrera que consume la app móvil (**PitWall Lap**) incluye ahora la **dotación de juegos por equipo** (`tirePairsPerTeam`; **0** = la carrera no lleva control de neumáticos, y la app se queda con su configuración manual). Y hay un **endpoint nuevo** —`GET /api/mobile/races/:id/tires`— que devuelve, por equipo (**canónico por nombre**, igual que en la web), los **juegos usados y disponibles** y el **historial de cambios** en orden cronológico: **número de juego** (1, 2, 3…), **manga** y **minuto:segundo de carrera** de cada entrega. La app casa a su piloto y a los rivales **por nombre** para poblar la estrategia de goma sin llevar la cuenta a mano, y se refresca al recibir el socket `tires:changed`. Solo lectura; no toca ni las estadísticas ni el Control.

### Añadido
- **La pantalla en directo avisa cuando un equipo cambia de neumáticos.** En cada tarjeta de equipo, junto al nombre, aparece ahora un indicador **🛞 con el número de juegos que lleva usados** ese equipo —igual que los avisos de **salidas (⚠️)** y **pit-stops (🔧)**—. En cuanto se anota un cambio en el control de neumáticos, el indicador **se actualiza al instante** en la live (sin recargar) y **destella** para que se vea que se acaba de hacer. Funciona con la manga **en marcha o en espera**, y solo aparece en carreras de **resistencia con control de neumáticos**.

## [1.16.0] — 2026-07-24

### Añadido
- **El control de neumáticos ya tiene su historial completo de la carrera.** En la cabecera de la pantalla de neumáticos (tanto en `/races/:id/tires` como en el kiosco `/control/tires`), junto a la dotación, hay un botón nuevo **«🗒️ Historial de cambios»** que abre el **registro global** de toda la carrera —no el de un solo equipo— **en una pestaña nueva**, presentado como una **tabla por mangas repartida en columnas** que aprovecha el ancho de la pantalla para verlo casi sin scroll. Los cambios salen **agrupados por manga**: se listan **todas las mangas** de la carrera, y las que no tuvieron ningún cambio de neumáticos aparecen igualmente marcadas como **«— sin cambios de neumáticos —»**, para que se vea de un vistazo dónde hubo movimiento y dónde no. Dentro de cada manga, cada entrega muestra el **equipo** (con su punto de color y su nombre), **qué número de juego era** para ese equipo (**juego N de la dotación**, contando por orden cronológico —1, 2, 3…—, y en **rojo** si se pasó de lo que le tocaba) y el **minuto:segundo de carrera** en que se hizo. Si algún cambio se guardó sin manga asignada, va a un grupo **«Sin manga»** al final.
- **Es solo para consultar, y se actualiza en vivo.** El historial global es de **solo lectura** —para borrar, editar o añadir un cambio a mano se sigue usando el lápiz de cada equipo, como hasta ahora—. Y si lo dejas abierto mientras se dan neumáticos, **se refresca solo** en cuanto se anota un cambio en cualquier pantalla.

## [1.15.0] — 2026-07-24

### Añadido
- **Ya puedes ajustar los turnos y los neumáticos de una resistencia después de crearla.** Hasta ahora, las **reglas de turnos por piloto** (mínimo y máximo por piloto, máximo de turnos y bloqueo del final de manga) y los **neumáticos por equipo** solo se fijaban al crear la carrera, en el asistente: si te equivocabas en un número, tocaba rehacer la carrera entera. Ahora, desde **Editar carrera**, en las carreras de **resistencia** puedes cambiar todos esos valores con calma **antes de que ruede la primera manga**.
- **Con una manga rodada, esos campos se bloquean solos.** En cuanto empieza la primera manga, los ajustes de turnos y neumáticos aparecen **bloqueados y con un candado 🔒** —para no descuadrar el control de turnos ni la dotación de neumáticos de una carrera ya en marcha—. El **nombre** y el **escenario** siguen editándose con sus reglas de siempre. Y si pones un **máximo por piloto menor que el mínimo**, PitWall te avisa en vez de guardar un disparate.

## [1.14.0] — 2026-07-24

### Añadido
- **Control de neumáticos para las carreras de resistencia.** Nueva página para repartir y llevar la cuenta de los **juegos de neumáticos** de cada equipo durante una carrera larga. Cada equipo parte de la **misma dotación**, la que fijas al crear la carrera (asistente, paso 1, **«Neumáticos por equipo»**); un **0** deja el control apagado, como hasta ahora. La pantalla es una **rejilla con todos los equipos**, y cada casilla muestra dos números: **Disponibles** y **Usados**. **Un clic en el equipo = entregar un juego**: baja uno los disponibles, sube uno los usados y queda anotado **en qué manga y en qué minuto:segundo de carrera** se hizo el cambio (se sella con la manga en marcha y su reloj; si en ese momento no hay ninguna corriendo, se guarda la manga sin tiempo). Todo se sincroniza al instante entre las pantallas que tengas abiertas.
- **Historial por equipo, para arreglar lo que haga falta.** El **lápiz** de cada casilla abre el detalle de ese equipo, donde puedes **borrar** un registro (el juego vuelve a Disponibles), **editar** su manga y su tiempo (mm:ss) o **añadir uno a mano** (manga, tiempo y una nota). Los contadores no se guardan a pelo: se **calculan** a partir de los registros (dotación menos entregas), así que deshacer nunca deja descuadres. Si un equipo se pasa de su cupo, sus Disponibles pueden quedar en **negativo y en rojo** —pensado para cuando das un juego extra fuera de dotación.
- **Dos formas de abrirlo.** Desde la propia carrera, con el botón **🛞 Neumáticos** (aparece solo en resistencia y con dotación mayor que 0); y como **kiosco** en `/control/tires`, que **detecta solo** la carrera de resistencia que esté en marcha —igual que el kiosco de turnos— y tiene su tarjeta en la pantalla de inicio, para dejarlo abierto en una tablet junto al box.

## [1.13.0] — 2026-07-23

### Añadido
- **Ya puedes crear una tanda con menos participantes que carriles.** Hasta ahora, si tu pista tiene 8 carriles, hacía falta rellenar los 8 sí o sí: PitWall no te dejaba empezar con 5 equipos. Ese candado se ha quitado — ahora basta con **un participante como mínimo** y los carriles que sobran se quedan libres, sin coche fantasma que ensucie las vueltas ni la clasificación. Perfecto para cuando falla gente a última hora o simplemente sois menos que carriles.
- **Y eliges qué pasa con los carriles que sobran.** Al crear la tanda aparece un selector con dos opciones:
  - **Sobran los últimos** (por defecto): los carriles de mayor número quedan vacíos toda la carrera y nadie rueda por ellos. Es el comportamiento de siempre, ahora disponible aun sin llenar la pista.
  - **El hueco rota**: el carril (o carriles) libre va rotando manga a manga, de modo que **todos los participantes acaban pasando por los mismos carriles**. Así nadie se lleva de gratis el carril bueno ni carga con el malo — la pista queda igual de justa que con la rejilla completa.

## [1.12.0] — 2026-07-21

### Añadido
- **La distancia al líder ya lleva la coma, y además se dice en segundos.** Hasta ahora el hueco se mostraba en **vueltas enteras** (**«+3 vlts.»**), así que dos coches separados por 2,8 vueltas y otros dos separados por 3,0 se veían exactamente igual, y al caer la bandera se perdía por completo **quién iba más adelantado en pista**. Ahora la distancia incluye la **coma** —la fracción de vuelta ya rodada— y se acompaña de su equivalente **en segundos**, calculado con el **ritmo del que persigue**: la etiqueta pasa de **«+3 vlts.»** a **«a 2,8 v (35,5")»**, que es justo lo que canta TicTac. Con la manga en marcha la coma es **viva** (lo que llevas rodado desde tu último cruce); con la manga terminada o descansando se usa la **coma con la que cruzaste la bandera**, la misma que ya desempata en los resultados. En una carrera real el hueco entre dos equipos pasaba de un «+3 vlts.» que no era cierto a los **2,8 vueltas ≈ 35,5 segundos** reales.
- **La clasificación estimada avisa cuando todavía no es firme.** Al principio de la **primera manga** de un equipo, PitWall aún no tiene una referencia sólida de su ritmo de salida, y su estimada puede moverse. Mientras esa manga no pasa del **60 %** de su duración, la proyección de ese equipo sale marcada con un **asterisco naranja** —con su explicación al pasar el ratón— en la **clasificación Le Mans** y en las **estadísticas en vivo**. Pasado ese punto el asterisco desaparece y la referencia queda fijada. Es una forma de no leer como definitivo un número que todavía se está asentando.

### Corregido
- **La media de carril vuelve a cuadrar al milisegundo con TicTac.** El **cruce de salida** —el de la rejilla a la línea, con el coche arrancando parado— no es una vuelta de verdad y por eso no se promedia. El problema es que, además de ese cruce, PitWall descartaba también la **primera vuelta completa**, que sí es ritmo real y que TicTac sí cuenta. Resultado: la media salía unas **14 milésimas por debajo** y con **una vuelta menos** en el reparto, y esa primera vuelta tampoco podía optar a **mejor vuelta** aunque lo fuera. Ahora entra donde debe —**media y mejor vuelta**—, y se comporta igual si el programa se reinicia a mitad de manga.
- **El tiempo total ya no se queda corto por el arranque desde parado.** En la **primera manga de cada equipo**, ese cruce de salida trae un tiempo artificialmente corto (poco más de un segundo: es media pista, no una vuelta), y eso dejaba el **tiempo total** acumulado unos **11 segundos por debajo** del real. Como el tiempo total es el **último criterio de desempate**, podía alterar el orden entre dos que empataran en vueltas y en coma. Ahora, **solo para el total y el desempate**, ese cruce se sustituye por el ritmo con el que ese equipo rodó de verdad al empezar (la media de sus vueltas completas del primer 60 % de su primera manga). Las **mangas siguientes no se tocan**, y la **media de carril tampoco**: esa sigue siendo, al milisegundo, la de TicTac.
- **El panel en directo y la tabla de resultados ya no pueden desempatar distinto.** El tiempo total que mostraba el **directo** dejaba fuera la vuelta de calentamiento de la manga en curso, mientras que el de la **tabla** la incluía. Con dos equipos empatados a vueltas, el orden podía no ser el mismo en una pantalla que en la otra. Ahora los dos salen del **mismo cálculo** y con la misma corrección de salida: una sola verdad en toda la aplicación.

## [1.11.0] — 2026-07-20

### Añadido
- **Ya se puede ver, en directo, lo que llega por el cable del cronometraje.** Nueva pantalla **«Visor de tramas»** (`/diagnostico/tramas`), a la que se entra desde **Solución de problemas**. Muestra **cada trama que manda el hardware** según va llegando, ya **traducida a lenguaje normal**: hora, circuito, fuente y una etiqueta que se entiende —**«Cruce — carril 3»**, **«GO — arranque de manga»**, **«Fin de manga»**, **«Latido»**, **«Stop forzado»**…— con los datos que importan ya formateados (carril, tiempo de vuelta, número de vuelta, duración de la manga) y, debajo, la trama completa en hexadecimal. Sirve para lo que hasta ahora había que hacer a ciegas: saber si el **DS-300** o el **BART** están hablando, qué están diciendo y si el problema es del cable, de la caja o de PitWall. Vale para **las dos fuentes**, incluido el **agrupador** de varias cajas.
- **Se ve qué parte del protocolo entiende PitWall y cuál no.** Los bytes que PitWall **no interpreta** salen **atenuados** en la trama: en un cruce del DS-300 son **10 de 21**, casi la mitad. Es lo que permite ir descifrando lo que queda del protocolo con hardware real delante, en vez de a base de suposiciones.
- **Salen a la luz las tramas que antes se descartaban en silencio.** El visor **marca** lo que el cronometraje tira sin decir nada: cruces con un tiempo **fuera de rango** (un rebote o un coche parado), tramas **truncadas** y tramas que el lector **ignora por no tener sentido en ese momento** (por ejemplo, un semáforo en verde sin un GO previo). También señala las **ráfagas de retransmisión** de los adaptadores PL2303 —los que repiten la misma trama 2 o 3 veces—, indicando **cuántas copias se descartaron por duplicadas** y dejando ver las sub-tramas reales anidadas. Hasta ahora nada de esto se veía.
- **Pensado para mirar con una carrera en marcha.** Botones de **Pausar/Reanudar** (congela el pintado sin desconectar nada), **Limpiar**, y filtros **«Ocultar latidos»** y **«Solo cruces»**, más los contadores de **tramas totales** y **tramas por segundo**. Muestra las **últimas 500** tramas: es un visor en vivo, no un registro histórico.
- **Con la pantalla cerrada no cuesta absolutamente nada.** PitWall solo decodifica y envía tramas **mientras alguien tiene el visor abierto**. Con la página cerrada no se decodifica ni se manda nada por la red — importante para que ese chorro de tramas no acabe llegando a los móviles de los equipos.

## [1.10.2] — 2026-07-19

### Mejorado
- **La pantalla de Ajustes queda más limpia al configurar los puertos.** En cada circuito DS-300 (y en el modo Agrupador), las propiedades técnicas del puerto COM —**Data bits, Paridad, Stop bits y Control de flujo**, que casi nunca se tocan— ahora viven dentro de un desplegable **«Opciones avanzadas del puerto»**, plegado por defecto. El campo para escribir el path del puerto a mano también se oculta tras un enlace **«Escribir el path a mano»**, que solo aparece cuando de verdad hace falta (y se abre solo si el puerto guardado no está en la lista detectada). Así, de un vistazo, cada circuito muestra únicamente **Puerto** y **Baud rate**.
- **El «Baud rate» vuelve a ser un desplegable de verdad.** Antes era un campo de texto con sugerencias que en algunos navegadores no llegaban a mostrarse al pulsar; ahora es una lista desplegable con las velocidades habituales (igual que el resto de campos del formulario), con un enlace **«Escribir a mano»** por si hiciera falta un valor fuera de lo común. Aplica también al modo Agrupador.
- **El cronómetro BART usa BLE por defecto.** Al elegir la fuente **BART**, el transporte preseleccionado pasa de TCP (puente/emulador) a **BLE (directo)**, que es lo normal con hardware real. El TCP sigue disponible en el desplegable para pruebas con el emulador o un puente BLE→TCP.

## [1.10.1] — 2026-07-18

### Corregido
- **PitWall ya no necesita internet para NADA.** Las páginas cargaban sus **tipografías** desde Google (`fonts.googleapis.com`), la última cosa que aún dependía de tener línea. En un circuito sin conexión no era grave —el navegador usaba una fuente del sistema y todo funcionaba—, pero la letra no se veía como debe. Ahora las fuentes las sirve el **propio PitWall** desde el ordenador (igual que ya se hizo con las gráficas en la 1.8.2), así que el aspecto es idéntico haya o no internet. Se incluyen los subconjuntos latin y latin-ext, que cubren el español, inglés, francés e italiano (acentos, ñ, ç…). Con esto, **la versión de escritorio no hace una sola petición a internet** en toda su operación.

## [1.10.0] — 2026-07-17

### Añadido
- **La cámara del escáner QR ya funciona en los móviles y tablets de la red.** El escáner de QR del **control de pilotos** usa la cámara, y los navegadores solo la permiten en «localhost» o por **HTTPS**. En el ordenador del operador (localhost) siempre fue bien, pero cualquier dispositivo que entraba por la IP de la red (192.168.x.x) se encontraba la cámara **bloqueada** por el navegador, con el aviso «La cámara necesita HTTPS o localhost». Ahora PitWall puede servir **HTTPS en la red local** para que esos dispositivos escaneen sin problemas.
- **HTTPS con certificado propio, sin instalar nada y sin internet.** PitWall crea su **propia autoridad raíz (CA)** y firma con ella el certificado del servidor. Sin instalar nada, el navegador avisa **una sola vez** («conexión no privada → continuar») y, al aceptar, la cámara funciona. Si se instala la **CA de PitWall** en el dispositivo, el aviso desaparece del todo. Y si cambia la IP de la red, PitWall solo reemite el certificado del servidor —la CA sigue siendo la misma—, así que **los dispositivos que ya confiaron no vuelven a avisar**. Todo se genera en el propio ordenador, sin conexión a internet, algo clave en un circuito.
- **Corre en paralelo al PitWall de siempre.** El HTTP del puerto 3000 no cambia en nada; el HTTPS abre un **puerto aparte** (por defecto **3443**). El operador sigue trabajando en `http://localhost` y solo quien escanea usa el enlace `https://`.
- **Nueva sección en Ajustes → «HTTPS local (cámara del escáner QR)».** Un interruptor para activarlo (abre un puerto nuevo, así que pide **reiniciar** el servidor), el puerto configurable, los **enlaces `https://IP:3443/control/shifts`** listos para cada dirección de la red, un botón para **descargar la CA** con su guía de instalación, y la **huella SHA-256** de la CA para cotejarla.
- **Página nueva `/cert` con la guía de instalación de la CA.** Explica paso a paso cómo instalar la CA de PitWall en **iPhone/iPad, Android y Windows**; `/cert/ca` descarga el certificado (`PitWall-CA.crt`). Son páginas públicas a propósito: el certificado no lleva clave privada y los dispositivos de la red necesitan poder bajarlo.
- **El aviso de la cámara ahora da el enlace directo.** Si abres el control de pilotos por HTTP en un dispositivo de la red y el HTTPS local está activado, el propio mensaje te ofrece el **enlace `https://`** a esa misma pantalla, ya en modo seguro.

## [1.9.0] — 2026-07-17

### Añadido
- **Los entrenos competitivos ya guardan sus resultados.** Una sesión de entreno por tandas con rotación de carriles solo existía **mientras estaba en marcha**: al pararla, los tiempos de **todos** los heats desaparecían y no quedaba rastro de quién había rodado ni cuánto. Ahora, **al caer la bandera de cada heat**, PitWall guarda una fila por cada carril que ha rodado con su **participante**, sus **vueltas**, su **mejor vuelta** y su **media**. Los participantes que **descansan** y los carriles **sin cruces** no dejan fila. Un **stop forzado no guarda nada**: ese heat se descarta y se repite entero, igual que se comportaba hasta ahora.
- **Pantalla nueva de entrenos guardados.** Desde el setup del entreno competitivo, el enlace **«Ver entrenos guardados»** abre la lista de sesiones guardadas —**fecha**, **nº de heats**, **participantes**, **vueltas** y **mejor vuelta**—, con la más reciente arriba. Cada sesión se puede **borrar** desde su propio detalle.
- **Detalle de una sesión, con clasificación y heat a heat.** El detalle de cada entreno trae dos bloques: la **Clasificación** de la sesión —gana quien **más vueltas suma** en todos sus heats y, a igualdad, quien tenga la **mejor vuelta**— y el desglose **heat a heat**. La **media** que se muestra es la de **todas** las vueltas del participante, ponderada por heat: un heat de 40 vueltas pesa lo que debe frente a uno de 3, cosa que no pasaría promediando las medias.
- **Al parar la sesión, se acaba en los resultados.** Si la sesión llegó a guardar algún heat, el botón de **STOP** lleva directamente a **sus** resultados en vez de devolverte al setup.
- **Las vueltas fantasma no ensucian los resultados del entreno.** El setup del entreno competitivo tiene ahora un campo **«Vuelta mínima (Pt)»** (en segundos): cualquier cruce por debajo de ese tiempo se descarta como vuelta fantasma —no cuenta vuelta, no entra en la media y no puede ser la mejor vuelta—, igual que en la carrera. Se precarga con el mínimo del circuito elegido; en un montaje de varias cajas DS se teclea a mano; y un **0** desactiva el filtro. Sin esto, un doble disparo del puente o un adaptador que repite la trama podía colarse como «mejor vuelta» de milésimas y falsear el desempate.

## [1.8.2] — 2026-07-16

### Añadido
- **Una prueba de esfuerzo para saber si un ordenador aguanta una carrera larga.** Antes de montar un evento de 24 horas no había forma de saber si el ordenador que se va a llevar al circuito da la talla, más allá de probarlo el día de la carrera. Ahora hay un banco de pruebas que levanta PitWall **de verdad** sobre una **copia desechable** de la base de datos (nunca toca la buena), con una manga en marcha y cruces entrando por el camino real, y le echa encima la carga de un evento grande: **100 móviles** conectados, los equipos en la app **Lap** y, si se quiere, pantallas de estadísticas en vivo abiertas. Al terminar dice si esa máquina se bloqueó lo bastante como para perder algún cruce. Se lanza con `DUR_S=60 N_APP=100 node scripts/stress-24h.js`.

### Mejorado
- **Las estadísticas en vivo ya no cuestan más cuanto más gente las mira.** Cada vez que alguien tenía esa página abierta, PitWall le preparaba los datos **desde cero** (259 milésimas y 213 KB **por petición**), y el navegador se los volvía a pedir en **cada cruce**: unas cinco peticiones por segundo. Cada espectador se comía así medio segundo de CPU por cada segundo de carrera, y con dos pantallas puestas el programa se quedaba sin aire. Ahora los datos se preparan **una sola vez y se reparten** a todos los que estén mirando: la petición baja de **259 a 1,54 milésimas**, y **10 espectadores** pidiendo a la vez pasan de casi **2,6 segundos** de cola a **13 milésimas**.
- **La página de estadísticas en vivo pide los datos con más cabeza.** Se los pedía al servidor con cada aviso de vuelta y con cada aviso de clasificación, sin ningún freno. Ahora espera **400 milésimas** antes de pedir —el mismo criterio que ya usaba la app **Lap** del móvil, y nadie nota esa diferencia en una pantalla de estadísticas— y no lanza una petición nueva mientras la anterior sigue en camino.
- **Los resultados en el móvil se preparan una sola vez para todos.** El dossier de resultados costaba **69 milésimas** y se rehacía para cada móvil que lo pidiera; al caer la bandera, con **100 móviles** consultando los resultados a la vez, eso eran unos **7 segundos** de cola. Ahora se calcula una vez y se reparte.
- **PitWall deja de escribir una línea de registro por cada petición.** Con la carrera en marcha son unas **55 peticiones por segundo**, y en la aplicación de escritorio cada una de esas líneas tenía que cruzar de un proceso a otro. Era trabajo constante a cambio de un registro que nadie lee: ahora solo se escribe cuando se está desarrollando.
- **La instalación ocupa 29 MB menos y ya no compila nada innecesario.** PitWall arrastraba dos componentes de gráficas que **no usaba** (las gráficas se dibujan en el navegador), y uno de ellos obligaba a compilar un módulo nativo en cada instalación para nada. Fuera.
- **Lo que todavía no está resuelto (queda pendiente para otra versión).** Rehacer la vista de estadísticas en vivo **sigue costando unas 200 milésimas**, y eso ocurre una vez por segundo mientras alguien la tenga abierta con una manga en curso. Con el banco de pruebas nuevo, en un Apple M4 Pro: **sin** pantallas de estadísticas, **ningún** bloqueo por encima del hueco entre tramas del DS-300 (máximo 20,1 milésimas); con **2** pantallas abiertas, **18 bloqueos** y un máximo de **222,8 milésimas**. Es decir: la caché quita el problema de que la cosa empeore con cada espectador, pero tener abierta la página de estadísticas durante una carrera, en una máquina justa, todavía puede costar algún cruce.

### Corregido
- **Las gráficas de los resultados ya no necesitan internet.** La página de resultados se descargaba la librería de gráficas desde internet cada vez que se abría, y en un circuito no siempre hay línea — sin conexión, las gráficas sencillamente no salían. Ahora esa librería la sirve el propio PitWall, igual que ya hacía la vista de estadísticas en vivo. (Queda otra dependencia menor de internet: las **tipografías de Google Fonts**; si no hay línea, el navegador usa una fuente del sistema y todo sigue funcionando.)
- **Los carriles sin equipo asignado ya no falsean los resultados en el móvil.** Las vueltas de los carriles sin equipo se agrupan en una fila aparte que, en los resultados que se ven en el móvil, podía colarse en la clasificación e incluso salir como **líder**, falseando las vueltas de diferencia de **todos** los equipos. Ahora se descarta, igual que en el resto de pantallas (es el mismo fallo que ya se corrigió en la app **Lap**).
- **La app Lap de los equipos ya no satura PitWall en carreras largas.** Cada móvil, en cada refresco, obligaba a recalcular desde cero la clasificación, la proyección, las paradas y la última vuelta leyendo **todas** las vueltas de la carrera: unas **266 milésimas por equipo** sobre las 160.569 vueltas reales de la carrera de 24 horas de Modena. Con 22 equipos pidiendo a la vez, el resultado era **idéntico para todos** pero se calculaba 22 veces. Ahora se calcula **una sola vez por carrera y se reparte** a todos los equipos, y se rehace al instante en cuanto entra una vuelta nueva o se corrige alguna. En una prueba con los 22 móviles reales, PitWall pasa de atender 4,2 peticiones por segundo —con esperas de hasta 20 segundos— a **53,7, respondiendo en 5 milésimas**. Lo más importante: ese bloqueo podía partir en dos una trama del DS-300 y **perder un cruce real**; ya no ocurre.
- **Tener abierta una carrera antigua ya no frena a la que se está corriendo.** PitWall solo guardaba los cálculos de **una** carrera: si alguien dejaba abierta en el móvil una carrera ya terminada, cada refresco suyo tiraba los cálculos de la carrera **en curso** y el siguiente cruce volvía a pagarlos enteros (unas 100 milésimas). Ahora recuerda varias carreras a la vez y ninguna estorba a las demás. Entre mangas y en una carrera acabada, además, deja de rehacer cuentas que ya no cambian.
- **Los carriles sin equipo asignado ya no falsean las vueltas de diferencia en la app Lap.** Las vueltas de los carriles que no tienen equipo se agrupan en una fila aparte; en la app Lap esa fila podía colarse en la clasificación e incluso salir como **líder**, con lo que el hueco en vueltas que se mostraba a **todos** los equipos era erróneo. Ahora se descarta, igual que ya hacían las demás pantallas.
- **Arrancar una manga ya no frena a PitWall lo bastante como para perder un cruce.** Al dar el GO de cada manga, PitWall tenía que releer las vueltas de las mangas anteriores —**153.000** de las 160.569 de la carrera de 24 horas de Modena— y las recorría **tres veces seguidas** para sacar tres datos que salen todos de la misma lectura. Ahora las lee **una sola vez**. Con esto, y con lo demás de esta versión, la pausa al arrancar una manga baja de **275 a 59,55 milésimas**: por debajo del hueco entre tramas del DS-300, así que ya no queda ningún punto del camino capaz de partir una trama y perder un cruce con la carrera en marcha.
- **PitWall busca mejor las vueltas en carreras muy largas.** Las consultas que resumen una carrera entera estaban tomando un atajo que no ahorraba nada (un índice que no descarta ninguna vuelta), y salía más caro que leer los datos de frente. Ahora, al arrancar, PitWall mide su propia base de datos y elige bien. Sobre la carrera de Modena: la **mejor vuelta por carril** pasa de 78 a **18 milésimas**, el resumen de la carrera de 63 a **30**, y el de las mangas anteriores de 71 a **39**. Arrancar cuesta unas **45 milésimas** más, una sola vez.
- **La página de estadísticas en vivo dejó de rehacer la clasificación estimada en cada cruce.** Esa vista se pedía de nuevo con **cada vuelta que entra** y cada vez recalculaba la proyección desde cero (**68 milésimas** en una carrera de 24 horas), saltándose los cálculos ya hechos —el mismo fallo que tenía la app Lap—. Ahora aprovecha los del motor.
- **Comprobado en el escenario real de las 24 horas de agosto.** Con el servidor de verdad, cruces reales entrando (22 carriles a ~2,2 por segundo), **100 móviles** con la app nativa conectados y **22 equipos** en la app Lap web a la vez: PitWall responde en **1,1 milésimas** de media (5,2 en el peor 1%, 59,3 como máximo) y **ninguna** de las 4.295 medidas superó el límite a partir del cual podría perderse un cruce. La app Lap web atiende **53,5 peticiones por segundo**, respondiendo en 11,9 milésimas de media y 27,4 en el peor caso.

## [1.8.1] — 2026-07-15

### Corregido
- **Las cajas DS-300 que repiten la trama ya no cuentan vueltas de más.** Con varias cajas conectadas, algunos adaptadores entregaban **cada cruce repetido 2-3 veces** en el mismo instante y PitWall lo contaba como varias vueltas (×2, ×3). Ahora, al separar una ráfaga de tramas pegadas, **descarta las copias idénticas consecutivas** (mismo carril y mismo contador) y cuenta el cruce **una sola vez**. Los cruces simultáneos de carriles **distintos** se siguen respetando (que es justo lo que esa separación recupera). El montaje de **una caja por puerto** no se ve afectado.
- **Reasignación de vueltas fantasma por certificación (ya no adivina).** Al detectar una vuelta fantasma (por debajo del Pt), antes se reasignaba «al vuelo» al carril que más tardaba —y a veces se la daba a un carril que no era—. Ahora la **retiene** y solo se la asigna al carril que **de verdad se saltó un cruce**, cuando ese carril lo **confirma al cruzar** (su vuelta sale ~el doble de su media). Si nadie lo confirma, se queda como fantasma para **revisión manual** en el corrector. El carril de origen **nunca** la cuenta.
- **Aviso de voz de la reasignación, sin repetir «Vuelta ignorada».** Al asignar la vuelta al carril que tocaba se decía «Vuelta ignorada pista X» **otra vez** (ya se había dicho al detectar el fantasma) y luego «Vuelta asignada pista Y». Ahora solo se anuncia la **asignación**; la «ignorada» se dice **una única vez**, al detectar el fantasma. Vale para el directo y para la app **Lap** del piloto.

## [1.8.0] — 2026-07-15

### Añadido
- **Nueva fuente de datos «DS-300 agrupador».** En **Ajustes → Fuente de datos** hay una cuarta opción para los montajes en los que un aparato **agrupador** junta **varias cajas DS-300 (de 2 a 4) en un solo puerto COM**. Basta con indicar el **puerto**, el **baud** (57600, 8N1) y el **nº de cajas** (2, 3 o 4 → 16, 24 o 32 carriles). Antes PitWall daba por hecho «una caja por puerto»; ahora también entiende varias cajas por un único cable.
- **Carriles numerados de forma global con el agrupador.** PitWall separa cada caja por su identificador de trama y numera los carriles de corrido: caja 1 → carriles **1–8**, caja 2 → **9–16**, caja 3 → **17–24** y caja 4 → **25–32**. No hay que configurar nada más: cada carril aparece con su número global en toda la app.
- **Una sola señal de salida arranca todos los circuitos del agrupador.** Como el agrupador comparte un único director, un **GO** arranca, pausa, reanuda o finaliza **a la vez** todas las cajas que cubre (igual que la simulación o BART), y el **STOP** cancela la manga completa. Funciona tanto en carrera con mangas multi-circuito (p.ej. 8+8+8+8) como en **Entrenos competitivos**.

### Corregido
- **El modo de una caja por puerto no cambia.** La opción **DS-300** de siempre (una caja = un puerto) se comporta exactamente igual que antes; el agrupador es una vía nueva y separada, no la sustituye.

## [1.7.1] — 2026-07-13

### Añadido
- **Botón de pantalla completa en el directo.** La barra superior del marcador en directo tiene ahora un botón que pone la vista a pantalla completa (y otro para salir); el icono cambia según el estado. Combinado con el auto-ajuste, el marcador ocupa toda la pantalla del dispositivo sin bordes del navegador. También se puede usar la tecla del navegador (F11 en Windows/Linux, Ctrl+Cmd+F en Mac).
- **Panel «Todas las tarjetas» en el control de pilotos.** Un botón nuevo abre en otra ventana la vista con las tarjetas de los 24 carriles a la vez, sin el pase de hojas: útil para tener toda la parrilla de un vistazo en una pantalla dedicada. Ese panel tiene también su propio botón de pantalla completa y se actualiza en vivo igual que la vista normal.

### Cambiado
- **En la vista «detalles» del directo, el Δ de cada tarjeta pasa a ser el «Gap V».** Antes ese hueco mostraba la consistencia (media − mejor vuelta). Ahora muestra el mismo **Gap V** de la clasificación estimada: las vueltas proyectadas que le separan del que va justo por delante en la general (el líder muestra «—»). Así el dato de la tarjeta coincide con el de la clasificación y se ve de un vistazo la distancia proyectada al rival de delante.
- **El control de pilotos mantiene al piloto que corre al cambiar de manga.** Al terminar una manga ya no baja del coche al piloto que iba conduciendo: se le pre-arma automáticamente en el nuevo carril de su equipo para la manga siguiente (un piloto puede rodar varias mangas seguidas). Solo lo sustituye un fichaje nuevo. Si el equipo descansa la manga siguiente, no se arrastra.
- **El panel de fichaje (pre-arme) sigue visible con la manga en marcha.** Antes desaparecía al dar el GO; ahora se mantiene durante la manga (y en pausa) para ver de un vistazo qué carril no ha fichado todavía.

### Mejorado
- **En el control de pilotos, el total del piloto se actualiza al momento mientras corre.** Con un piloto en pista, su «Total piloto» —tanto el de la cabecera de la tarjeta como el de su fila en la lista de pilotos— va subiendo en tiempo real junto al cronómetro del turno, sin esperar al fin del turno.
- **El marcador en directo llena la pantalla en montajes grandes.** En carreras con más de 8 carriles (varias cajas), el marcador de directo pasa a una rejilla de tarjetas. Antes las tarjetas tenían un tamaño tope y quedaban pequeñas y centradas, con una franja negra arriba en pantallas grandes; en pantallas pequeñas, en cambio, sobraban carriles y aparecía scroll. Ahora la rejilla se ajusta sola a la resolución del dispositivo: calcula cuántas columnas y qué alto de tarjeta hacen que **todas** las tarjetas quepan y llenen la pantalla sin scroll, y el tamaño de letra crece o mengua con la tarjeta. Se recalcula al cambiar de resolución o de tamaño de ventana.

---

## [1.7.0] — 2026-07-10

### Añadido
- **Colocar a cada piloto en su carril arrastrándolo.** Tras la pole, la elección de carriles se hace colocando a cada piloto o equipo en un carril concreto: lo arrastras desde la bolsa de arriba hasta el carril que quieras, o tocas primero al piloto y luego el carril. Puedes moverlo entre carriles o entre tandas, o devolverlo a la bolsa tocándolo. Ya no hay que seguir el orden de pole: colocas a cada uno donde decidas.
- **Reparto de la carrera en varias tandas.** Puedes dividir la carrera indicando el «Nº de tandas», con tandas del tamaño que quieras; la misma forma de colocar sirve tanto para una sola tanda como para varias. El botón «+ descanso» añade plazas de descanso a una tanda.
- **Carriles en orden y agrupados por circuito.** Los carriles se muestran siempre en orden numérico. Si el montaje tiene varias cajas —por ejemplo tres cajas de ocho, 24 carriles— se agrupan y rotulan por circuito: «Circuito 1» (1-8), «Circuito 2» (9-16) y «Circuito 3» (17-24), para no perderse en montajes grandes.
- **Todas las tandas se crean de una sola vez.** Al confirmar se generan de golpe todas las tandas con cada piloto en el carril donde lo colocaste; antes solo se creaba la primera y las demás había que añadirlas a mano.
- **Recuperación de una manga tras un corte.** Si PitWall se reinicia (o se corta la corriente) con una manga en marcha, al volver a arrancar retoma esa manga automáticamente en vez de darla por perdida, siempre que la caja confirme que sigue rodando. Las vueltas que ocurrieron durante el corte se reponen con la media del carril y quedan **marcadas** en el corrector, para poder revisarlas o quitarlas a mano. El tiempo del corte se cuenta como conducido en el control de turnos.
- **Aviso de qué caja DS se ha quedado sin señal.** Con varias cajas, si una pierde la conexión el aviso indica **cuál** (por ejemplo «Sin señal · caja 2»), en la vista de directo y en el pie del kiosco de turnos. Antes, con una caja caída y las demás vivas, el aviso podía no salir.

### Cambiado
- **Nueva regla de desempate a igualdad de vueltas: la coma de la última manga.** Cuando dos participantes terminan con el mismo número de vueltas, ahora desempata **quién iba más adelantado en pista al caer la bandera de la última manga** — su «coma» (la fracción de la vuelta en curso en ese momento) más alta. Se mide como los segundos entre el último cruce del coche y el final de la manga, respecto a su media de vuelta. Si un coche descansó la última manga, cuenta la última que sí corrió. El tiempo total pasa a ser un criterio secundario, solo por si empataran también en esa coma. **Este cambio puede alterar el orden de la clasificación** respecto a versiones anteriores en los empates a vueltas. El nuevo criterio es coherente en todas las pantallas: marcador en directo, vista Le Mans, resultados y la app Lap ordenan igual.

### Mejorado
- **El panel de vueltas rápidas ahora se adapta a ventanas pequeñas.** El panel a pantalla completa era una tabla fija de tres columnas que estiraba el tamaño de letra para llenar el alto; al encoger la ventana quedaba estrecho e incómodo de leer. Ahora usa las mismas píldoras de colores que el marcador de «VUELTAS RÁPIDAS» del directo, que se recolocan solas en varias filas según el ancho disponible. Así se puede dejar el panel en una ventana pequeña junto al directo sin que se desborde ni se descuadre.

### Corregido
- **La misma vuelta ya no muestra un tiempo distinto en el panel y en el directo.** El panel de vueltas rápidas redondeaba a milésimas mientras que el resto de PitWall trunca a centésimas, así que una misma vuelta podía verse como `8.09` en el panel y `8.08` en el directo. Ahora el panel usa exactamente el mismo formato que el directo y los tiempos coinciden.
- **PitWall ya no se queda sin memoria al desconectar una caja DS.** Al perder la conexión con una caja mientras corría una manga, en algunos casos el consumo de memoria crecía sin parar hasta tumbar el programa. Ahora el enlace caído se detecta y se cierra correctamente, y el consumo se mantiene estable.

## [1.6.2] — 2026-07-09

### Corregido
- **La vuelta de la bandera se recuperaba mal en los coches más rápidos.** Cuando cae la bandera, la última vuelta que la caja DS-300 sí contó puede llegar demasiado tarde y perderse; PitWall la repone comparando su propio recuento con el contador de la caja. Pero ese contador solo cuenta hasta 99 y vuelve a empezar, así que en cuanto un coche pasaba de 100 vueltas en una manga la comparación salía negativa y la recuperación se desactivaba en silencio — justo para los coches que más vueltas dan. Ahora se reconstruye el número real de vueltas.
- **La «coma» de la caja que termina antes.** La coma es la fracción de vuelta que un coche llevaba recorrida cuando cayó la bandera, y desempata a igualdad de vueltas. Con varias cajas DS, la que termina antes que las demás veía la coma de sus carriles disparada al máximo, porque se calculaba con el momento en que terminó la **última** caja. Ahora se usa el fin real de cada caja.
- **Desempate coherente entre pantallas.** La clasificación proyectada (panel y Le Mans) desempataba por la suma de comas y la pantalla de resultados por la coma media de cada manga. Dos equipos empatados a vueltas podían aparecer en orden opuesto según la pantalla que se mirara. Ahora las dos usan la misma regla: la coma media por manga. En las carreras ya guardadas el orden no cambia.
- **Una manga parada ya no cuenta como si estuviera corriendo.** Al detener una manga y devolverla a pendiente, se conservaba su hora de inicio, así que la clasificación estimada la seguía tratando como una manga en marcha y a la vez la excluía de las que quedan por correr. Los cálculos quedaban mal en toda la ventana entre el stop y la nueva salida.

## [1.6.1] — 2026-07-09

### Corregido
- **El marcador ya no se atasca en las últimas horas de una carrera larga.** Cada vez que un coche cruzaba la meta, PitWall recalculaba la clasificación y la proyección leyendo **todas** las vueltas de la carrera. En una prueba de 24 horas eso son más de 160.000 vueltas, y el cálculo llegaba a tardar 174 milésimas por cruce: con 24 carriles cruza un coche cada 0,8 segundos, así que el programa pasaba más del 20% del tiempo bloqueado justo en la hora en la que se decide la carrera. Ese bloqueo retrasaba el cronómetro y —lo más grave— podía partir en dos una trama del DS-300 y perder una vuelta.
- **Ahora las mangas ya terminadas se calculan una sola vez y se reutilizan**, y solo se recalcula la manga en curso: el coste baja de 174 a 2 milésimas por cruce y deja de crecer con las horas de carrera. Comprobado sobre las 160.569 vueltas reales de la carrera de 24 horas de Modena, la clasificación resultante es idéntica, equipo a equipo, en las 22 mangas.

## [1.6.0] — 2026-07-09

### Corregido
- **Un cable suelto ya no deja ciega una caja DS.** Si una trama de cruce llegaba partida (un tirón del cable USB, un pico de latencia), el programa fallaba al interpretarla y se quedaba atascado releyendo la misma trama rota: esa caja —sus ocho carriles— dejaba de registrar vueltas el resto de la manga, y nadie se enteraba porque el programa seguía aparentemente vivo. Ahora la trama rota se descarta y el cronometraje continúa.
- **Aviso cuando una caja DS se queda muda.** El DS-300 envía una señal de vida cada minuto mientras la manga corre. Si dejaba de enviarla pero el puerto seguía abierto (caja colgada, fallo del USB), PitWall mostraba el enlace en verde y esos ocho carriles no contaban vueltas durante horas. Ahora, si pasan más de 75 segundos sin señal con la manga en marcha, se marca el enlace como caído y se intenta reconectar. Con la manga parada el silencio es normal y no se avisa.
- **Un fallo del disco al cerrar una manga ya no contamina la siguiente.** Si al terminar una manga fallaba la grabación (disco lleno, base de datos ocupada), el cronometraje quedaba en un estado a medias: la manga constaba como terminada pero el motor seguía creyéndola activa, y el siguiente GO del DS no arrancaba la manga nueva. Ahora el cierre se completa siempre, aunque la grabación falle.
- **Retirados los atajos de prueba que podían borrar la carrera.** Existían unas direcciones internas de prueba que simulaban las señales del DS. Una de ellas cancelaba la manga activa y borraba todas sus vueltas —horas de carrera— sin pedir confirmación, y bastaba con abrir cierta página en el ordenador de cronometraje para dispararla sin querer. Ya no están disponibles salvo que se active expresamente el modo banco de pruebas.
- **El botón «Eliminar pending setup» ya no cierra la carrera en curso.** En una carrera larga siempre hay mangas futuras pendientes; ese botón de la pantalla de diagnóstico las daba por terminadas junto con la propia carrera, que a partir de ese momento dejaba de encadenar mangas y se paraba sin avisar. Ahora nunca toca la carrera que se está corriendo.

## [1.5.2] — 2026-07-08

### Corregido
- **Parar una manga que se quedó colgada tras reiniciar el programa:** si PitWall se cierra o se reinicia mientras una manga está corriendo, la manga sigue marcada como activa aunque el cronometraje ya no esté en marcha. Al pararla, se borraban las vueltas y la manga volvía a pendiente, pero los turnos de los pilotos se quedaban con el tiempo acumulado y sin cerrar: el piloto arrastraba tiempo de una manga anulada y no podía volver a fichar su QR. Ahora parar una manga da el mismo resultado tanto si el cronometraje sigue vivo como si se perdió al reiniciar: se descarta el tiempo de esa manga (el de las mangas anteriores no se toca), se conserva qué piloto está en cada carril y todos quedan listos para el siguiente GO sin tener que reescanear. Lo mismo se aplica al reseteo de mangas desde la pantalla de diagnóstico.

## [1.5.1] — 2026-07-08

### Añadido
- **Reglas de turnos a la vista** en la pantalla de control de pilotos: en la cabecera, junto al nombre de la carrera, ahora se muestran el tiempo mínimo y el máximo que puede rodar cada piloto, el número máximo de turnos y los minutos finales en los que ya no se admiten cambios de piloto. Estaban configuradas en la carrera pero no aparecían en ninguna parte de la pantalla. Los puntos de color son los mismos de la leyenda de carriles (morado el mínimo, rojo el máximo). Los límites que estén sin poner no se muestran.

### Mejorado
- **Lista de pilotos por tiempo más legible:** se quita el punto de categoría (oro, plata, bronce) que iba delante de cada nombre en la pantalla de control de pilotos. Despistaba, porque en esa pantalla los colores significan estado del turno (ámbar «a punto», rojo «pasado»). La categoría sigue estando en el histórico de turnos y en el informe final. De paso, los nombres largos ganan sitio y dejan de cortarse.

## [1.5.0] — 2026-07-08

### Añadido
- **Panel de pre-arme** en la pantalla de control de pilotos, visible mientras la manga aún no ha arrancado: una casilla por carril, agrupadas por circuito, **verde** si el equipo ya ha pasado su QR y **ámbar a rayas** si falta. Arriba, el contador «21/24 fichados». A la derecha de cada circuito aparece el nombre de los equipos que faltan. Cuando fichan todos, el panel se pone verde y avisa de que están listos para el GO. Se ve entero aunque la lista de carriles esté paginada, que es donde antes se perdía de vista el equipo que faltaba. Los equipos en descanso no cuentan.

### Mejorado
- **Tarjetas de carril más compactas**, para que quepan más de una vez en pantalla.
- La altura de las tarjetas **se ajusta sola** al equipo con más pilotos de la manga: antes tenía una altura fija y a un equipo de seis pilotos se le cortaba el último de la lista.
- Los **nombres largos de piloto** se encogen en lugar de cortarse con puntos suspensivos; los muy largos se parten en dos líneas.

## [1.4.1] — 2026-07-08

### Añadido
- **Ensayo automático de extremo a extremo del control de turnos** sobre tres cajas DS emuladas (24 carriles) con tramas reales: salida escalonada, cambio de piloto en caliente, pausa de una sola caja, stop forzado, nueva salida y fin escalonado. Comprueba además que el informe final no se deja a ningún piloto.

### Corregido
- **Hora de entrada con varias cajas DS:** cada caja arranca cuando le llega su propia señal de salida (el GO es escalonado), pero la hora de entrada de los pilotos se anotaba con la salida de la **primera** caja. En la cronología del informe, los pilotos de la segunda y la tercera caja aparecían entrando varios segundos antes de que su caja hubiera arrancado. Ahora cada caja anota a sus pilotos con su propia salida. El tiempo acumulado ya era correcto; lo que fallaba era la hora que se mostraba.
- **Pilotos de una caja que nunca sale:** un piloto cuya caja no llega a recibir su señal de salida ya no consta como que rodó — queda sin hora de entrada y con 0 de tiempo.
- Medido sobre el ensayo, la desviación del cronómetro de cada piloto queda en **0,5 segundos en 24 horas** (antes eran unos 89 segundos, siempre a la baja).

## [1.4.0] — 2026-07-08

### Añadido
- **Informe final de turnos:** botón «Informe final» en el histórico de turnos de la carrera. Un informe completo con el tiempo total y el número de turnos de cada piloto, las reglas aplicadas, las infracciones marcadas y la cronología turno a turno de cada manga. Se puede imprimir, descargar como HTML autónomo (para adjuntar a una reclamación) y exportar a Excel. Los turnos con el tiempo corregido a mano por el staff aparecen señalados.
- **Pruebas automáticas del control de turnos** (50 pruebas) que recorren el ciclo completo: pre-arme antes del GO, cambio de piloto en caliente, pausa y reanudación, stop forzado y fin de manga, incluido el arranque escalonado de tres cajas DS.

### Mejorado
- **Stop forzado:** antes borraba todos los turnos de la manga y obligaba a volver a escanear todos los QR. Ahora solo descarta el tiempo acumulado **en esa manga** (lo registrado en mangas anteriores no se toca), conserva qué piloto está en cada carril y los contadores vuelven a arrancar solos con el siguiente GO.
- **Pausa y reanudación:** la pausa congela el contador de todos los pilotos y al reanudar no se les cobra el tiempo parado.

### Corregido
- **Tiempo de cada piloto exacto:** el cronómetro sumaba un segundo por cada tic de reloj en vez de medir el tiempo real y, como los tics llegan tarde, siempre contaba de menos — unos **89 segundos perdidos por piloto en 24 horas** medidos en banco. Ahora el tiempo se calcula por marcas de tiempo y tampoco se pierde la fracción de segundo al abrir y cerrar cada turno.
- Un piloto que estuviera en **dos equipos del catálogo** veía su tiempo y sus turnos multiplicados (×2 con dos equipos), lo que con un tiempo máximo por piloto provocaba infracciones falsas.
- Dos pilotos con el **mismo nombre** en equipos distintos se cruzaban el tiempo entre ellos.
- Un turno cuyo piloto se hubiera **borrado del catálogo** desaparecía del total del equipo.
- Si el staff pre-armaba a un piloto y lo **sustituía antes del GO**, el sustituido se llevaba igualmente un turno de 0 segundos que contaba contra el máximo de turnos permitidos.
- El histórico de turnos **no mostraba a los pilotos que nunca ficharon**, que es justo la infracción más grave (no llegar al tiempo mínimo): sencillamente no aparecían.
- El **límite de número de turnos** se calculaba pero no se aplicaba: un piloto que se pasaba de turnos salía como «OK».
- El aviso de **«último turno»** nunca saltaba si el máximo de turnos era 1.
- Los **tiempos largos** se mostraban mal: 4 horas se pintaban como «240:00» en vez de «4:00:00».
- Con **varias cajas DS**, un circuito que terminaba antes que los demás seguía sumando tiempo a sus pilotos.
- Un **carril sin caja asignada** sumaba tiempo aunque no estuviera corriendo.

## [1.3.1] — 2026-07-07

### Corregido
- **«Arrancar túnel» sin guardar antes:** el botón aplicaba el modo guardado (no el elegido en pantalla) y avisaba «El túnel está desactivado» aunque acabaras de seleccionar un modo. Ahora arrancar guarda primero la configuración que ves (modo, token, dominio, autoarranque) y arranca con ella.

## [1.3.0] — 2026-07-07

### Añadido
- **Instalador de cloudflared integrado:** si el binario no está en el sistema, la sección del túnel ofrece el botón «Instalar cloudflared», que descarga el release oficial de Cloudflare para tu sistema (macOS/Windows/Linux, Intel/ARM) a la carpeta de datos de PitWall — sin permisos de administrador y solo si el club lo quiere.
- **Guía de configuración del modo «Cloudflare propio»:** pasos numerados con enlaces al dashboard Zero Trust y a la documentación oficial para crear el túnel del club y obtener el token.

## [1.2.0] — 2026-07-07

### Añadido
- **Seguimiento público por internet configurable por club:** nueva sección en Ajustes para publicar las vistas públicas (directo, resultados, Lap) mediante un túnel de Cloudflare **propio de cada instalación** — ya no depende de ninguna cuenta central. Dos modos: **Rápido** (URL temporal `*.trycloudflare.com`, sin cuenta ni dominio) y **Cloudflare propio** (token del túnel del club con su dominio). PitWall arranca/para el túnel desde Ajustes (con estado y URL en vivo) y puede autoarrancarlo con el servidor. El control de la app sigue bloqueado desde fuera (403).

## [1.1.2] — 2026-07-07

### Mejorado
- **Editar carrera:** ahora se puede **asignar, cambiar o quitar el escenario** de cualquier carrera sin vueltas registradas (antes solo se podía cambiar si ya tenía uno). Al asignarlo se heredan carriles, secuencia y vuelta mínima y se regeneran las tandas pendientes; al quitarlo la carrera pasa a manual conservando su configuración.

## [1.1.1] — 2026-07-07

### Mejorado
- **Importar tanda con pole:** el orden de carril del envío se ignora y no se crean tandas — solo la carrera y la sesión de pole con todos los equipos; la parrilla se asigna después de correr la pole (flujo nativo de PitWall).

## [1.1.0] — 2026-07-07

### Añadido
- **Puente con PitWall Control (ida):** importar tandas desde un fichero JSON (`pitwall.tanda/v1`) o directamente por WiFi/LAN. La carrera y sus tandas se crean automáticamente con cada equipo en su carril de salida; los descansos (D1, D2…) se colocan y rotan con el motor de resistencia. Pantalla «Importar tanda» con PIN de emparejamiento para los envíos desde la red.
- **Puente con PitWall Control (vuelta):** nuevo endpoint `/link/races/:id/results.json` con los resultados por tanda (posición dentro de cada tanda) para que Control construya la clasificación del campeonato con su propia tabla de puntos.
- **Pole en la importación:** el contrato de tanda acepta `pole: true` y la pantalla de import tiene el checkbox «Esta carrera tiene pole»; se crea la sesión de pole con todos los equipos como participantes.
- **Historial de versiones visible:** la versión aparece en el pie de todas las páginas y enlaza a esta página de historial (`/changelog`).

### Mejorado
- **Excel de resultados:** la hoja «Comparativa» es idéntica a la web — orden de posición por carril «(n)», carril de la vuelta rápida, «Media gen / Mejor med» y fila de consistencia «Const. sin».

### Corregido
- Los descansos «D1..Dk» de Control ya no chocan con los carriles numéricos al importar una tanda (antes «D1» y el carril «1» daban *carril repetido*).

## [1.0.0] — julio 2026

Versión base de PitWall como software libre (AGPLv3):
- Cronometraje de carreras de slot con DS-300 y BART (resistencia por tandas/mangas con rotación de carriles y descansos, sprint, pole).
- Directo con proyección de clasificación, vista Le Mans, TV y estadísticas en vivo; seguimiento público por internet mediante túnel.
- Cliente web «Lap» por equipo (PIN, voz, estrategia de neumáticos).
- Resultados con media TicTac verificada, consistencia, comparativas y exportaciones (Excel con logo y estilo, HTML, CSV para Control).
- Carrera simulada desde tramas DS-300 (×1/×2/×5/×10).
- Race Link maestro↔esclavo (provisión de carrera + estado por LAN).
