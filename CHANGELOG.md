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

## [1.7.0] — 2026-07-10

### Cambiado
- **Nueva regla de desempate a igualdad de vueltas: gana quien cruza antes.** Cuando dos participantes terminan con el mismo número de vueltas, ahora desempata **quién completó esas vueltas en menos tiempo**, es decir, quien cruzó la línea de su última vuelta primero. Antes desempataba la «coma» (quién iba más metido en la vuelta en curso al caer la bandera). La coma pasa a ser un criterio secundario: solo decide en el caso, prácticamente imposible, de que el tiempo total coincida al milisegundo. **Este cambio puede alterar el orden de la clasificación** respecto a versiones anteriores en los empates a vueltas. El nuevo criterio es coherente en todas las pantallas: marcador en directo, vista Le Mans, resultados y la app Lap ordenan igual.

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
