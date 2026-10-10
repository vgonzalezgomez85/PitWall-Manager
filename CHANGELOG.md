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

## [1.52.3] — 2026-10-10

### Mejorado
- **Los textos con números dentro salen ya del diccionario.** Los que llevan un dato en medio («12 coches creados», «Vuelta ignorada pista 5») tenían el texto repartido alrededor del número, y por eso se habían quedado fuera. Ahora van al diccionario con un hueco —`{{n}} coches creados`— que se rellena al pintarlo. Eran 52, casi todos avisos de importación y de la voz del directo.
- **Las fechas y las horas usan un solo formato por idioma.** Cada pantalla llevaba su locale escrito a mano, y estaban mezclados: en inglés unas usaban formato británico (día/mes) y otras americano (mes/día). Ahora salen de un único sitio (`src/utils/locale.js`), que es lo que permitirá añadir el italiano. **Ojo para quien use la app en inglés**: las pantallas que enseñaban la fecha al estilo americano pasan al británico, que era el que usaba la mayoría.

## [1.52.2] — 2026-10-10

### Mejorado
- **Los avisos que fabrica el servidor salen ya del diccionario.** Son los mensajes que no están en ninguna plantilla porque no existen hasta que pasa algo: «Esta carrera ya está en este PC» al importar una carrera, «Selecciona un archivo .db.», «No se puede exportar a Excel mientras hay una manga en curso», los errores de creación de coches y categorías, y los avisos de sincronización del catálogo. Eran 110 en el código del servidor. Lo que se ve en español y en inglés no cambia: verificado con las 148 pantallas.

## [1.52.1] — 2026-10-10

### Mejorado
- **Ya no queda ningún ternario de idioma en el código.** Los 96 últimos —los que estaban partidos en varias líneas y se iban a hacer a mano— pasan también al diccionario: son los textos largos de ayuda y de aviso (los avisos de la importación de coches, las descripciones de los escenarios, las condiciones de la pole). Con esto **todo el texto de la app sale del mismo diccionario**, que es lo que permite traducirla de verdad. Lo que se ve en español y en inglés no cambia: verificado con las 148 pantallas.

## [1.52.0] — 2026-10-10

### Añadido
- **Modelo de DS en Ajustes: DS-300, DS-200, DS-030 y DS-080.** La tarjeta de la fuente de datos pasa a llamarse «DS». Cada circuito tiene ahora un selector de modelo (Ajustes → Fuente de datos → DS). Al elegir uno la velocidad pasa a la suya (56000 baudios el DS-300, 4800 el resto) y se puede cambiar a mano. El DS-200 (2 carriles) codifica el carril de otra forma y PitWall ya la entiende; el DS-080 lleva **dos circuitos por un solo puerto** y sus carriles salen como 1–8 y 9–16. El visor de tramas también respeta el modelo. **Sin probar con aparatos reales:** los tres modelos nuevos siguen el documento de protocolo sacado de TicTacSlot; el DS-300 funciona exactamente igual que antes y es el valor por defecto.
- **Nueva fuente de datos «TicTac»: lee los cruces del interface TicTacSlot (Cuentavueltas) por USB.** Ajustes → Fuente de datos → TicTac. El aparato es USB HID (no crea ningún puerto COM), así que PitWall lo **detecta solo** por su identificador USB: basta con enchufarlo, aunque PitWall ya esté arrancado, y si se desenchufa se marca como caído y se reengancha al volver a conectarlo. Ajustes muestra si lo ve («✓ TicTacSlot detectado por USB»). La opción «Puerto serie» queda para el emulador (`emulador-tictac`) o su puente `hid-bridge.js`. PitWall decodifica la trama de 16 bytes y saca el tiempo de vuelta restando el **reloj del propio aparato** entre dos cruces del mismo carril (más preciso que la hora de llegada al PC); el primer cruce de cada carril, o el que llega tras más de 4 minutos de silencio, no trae tiempo. El visor de tramas también lo muestra. La lectura USB usa el módulo opcional `node-hid`: si no está disponible en una instalación, la fuente avisa y el resto de PitWall funciona igual. En macOS puede pedir permiso de «Monitorización de entrada». **Por ahora solo lee:** el aparato no manda GO, pausa, stop ni fin, y esa parte (que sea PitWall quien dirija la carrera con este aparato) llega en la siguiente fase, así que de momento no se puede correr una manga con él. Probado con el emulador y con tramas de la captura real del club; **la lectura USB directa no se ha probado con el aparato físico**.
- El vigilante del latido de 60 s solo se aplica al DS-300: en los otros modelos no está confirmado que lo emitan, y un silencio normal habría cerrado el puerto como si fuera una avería.

## [1.51.1] — 2026-10-10

### Mejorado
- **Los textos que pinta el navegador salen ya del diccionario.** El directo, la pantalla de TV, Lap, los paneles y el entrenamiento construyen buena parte de lo que se ve desde JavaScript, y esos 297 textos seguían con ternarios de idioma. Ahora usan el mismo diccionario que el resto de la app: se acabó la última vía por la que un idioma nuevo se quedaba a medias. El diccionario viaja en la página (5,8 KB, solo las claves que esa pantalla necesita). Lo que se ve en español e inglés **no cambia**.

## [1.51.0] — 2026-10-10

### Añadido
- **Piloto(s) por carril en la parrilla de resultados.** En carreras por equipos, cada celda de la matriz muestra bajo el número de vueltas **quién iba al volante** en ese carril en esa manga, tomado de los fichajes de turno; si hubo relevo a mitad de manga salen los dos nombres. También en la impresión. En carreras sin control de turnos la tabla no cambia.
- **Preparación del italiano como tercer idioma.** La app ya reconoce el italiano (navegador en italiano, selector del pie y `?lang=it`) y muestra los textos en español mientras no esté traducido, en vez de claves o huecos en blanco. Falta la traducción en sí.

### Mejorado
- **El separador decimal es la coma en toda la app.** El directo y la pantalla de TV sacaban el punto (`12.06`) mientras los resultados y las estadísticas ya usaban la coma (`12,06`): el mismo tiempo se veía distinto según la pantalla. Ahora es la coma en todas. Los campos numéricos del asistente siguen con punto, que es lo que exige el navegador.
- **Cambiar de idioma ya no pierde lo que estabas viendo.** El selector del pie conserva el resto de la dirección (filtros, orden, pestaña), y la lista de idiomas sale de los ficheros de traducción, así que añadir uno no obliga a tocar el pie.
- **Todos los textos de la app salen ya de un único diccionario.** Antes convivían tres sistemas —el diccionario, ternarios de idioma escritos a mano en cada vista y textos sueltos en español— que además solo entendían dos idiomas. Es el trabajo de base que hace posible el italiano. Lo que se ve en español y en inglés **no cambia**: se ha verificado que las pantallas salen idénticas.

## [1.50.0] — 2026-10-08

### Añadido
- **Exportar los resultados para area-corse.it (Italia).** La página de **Resultados** de una carrera estrena un botón, **area-corse**, junto a los de Excel, Puntos, Control y GitHub: descarga la **clasificación general** en el formato CSV que importa la plataforma italiana **Area Corse**, para llevar las carreras del club a sus campeonatos. El archivo lleva las **vueltas**, los **sectores** de la vuelta en curso al caer la bandera, la **mejor vuelta** y la **posición oficial** de cada participante.
- **El emparejado se hace por el nombre.** El identificador de piloto que exporta PitWall es el **interno** del programa, así que el CSV incluye también el **nombre** del piloto o equipo, que es por donde Area Corse reconoce cada resultado. El resto de exportaciones —**Excel**, **Puntos**, **Control** y **GitHub**— no cambian.

## [1.49.1] — 2026-10-08

### Corregido
- **El arranque ya funciona en las unidades DS-300 que mandan el GO con clase `0x3A`.** Algunas unidades (detectado en un club que probaba PitWall) emiten la primera trama del GO con `byte7=0x3A` en vez de `0x3E`, con el mismo `byte8=0xA1` y el checksum válido sobre el byte real. PitWall solo reconocía `0x3E`: la señal no enganchaba el arranque, el «verde» posterior se ignoraba —el visor de tramas lo mostraba como «Verde sin GO pendiente» y pintaba la trama de GO como un cruce a 0 s— y **la carrera no empezaba al dar al GO**. Ahora el parser y el visor de tramas aceptan ambas clases.

## [1.49.0] — 2026-10-08

### Añadido
- **Categoría/copa y coche por equipo o piloto (opcional).** Cada carrera estrena dos interruptores —**Categoría / copa** y **Coche**— en el **asistente de nueva carrera** (paso 1) y en **Editar carrera**, para anotar por participante la copa en la que corre y el coche con el que participa. Con ellos activos, al **inscribir** los equipos o pilotos (en el asistente, carreras con pole, y en la pantalla de **nueva tanda**) aparecen dos campos de texto libre que se pueden dejar vacíos; al inscribir un **equipo del catálogo**, su categoría y su coche se copian como punto de partida. Después se pueden **editar desde la tanda**, también con mangas ya corridas. Si el dato de la carrera está vacío, se sigue leyendo el del **catálogo** por nombre, así que las carreras anteriores a esta versión se ven igual que siempre.
- **La categoría se ve en el directo, ahora también en sprint.** La categoría acompaña al nombre en las tarjetas, las filas, la clasificación, la TV, las mejores vueltas y las estadísticas en vivo; en las carreras **sprint** (de pilotos) ahora también aparece la de cada piloto, donde antes no salía ninguna. El **coche** no se muestra en el directo: se ve en la vista **Le Mans**.
- **Excel de resultados con Categoría y Coche junto al nombre.** Con los interruptores activos, las hojas **Clasificación**, **Mejor vuelta** y **Comparativa** añaden esas dos columnas justo al lado del nombre. El CSV de Control no cambia.
- **Apagados por defecto y reversibles.** Con los dos interruptores apagados nada cambia respecto a la versión anterior, y se pueden encender o apagar en cualquier momento —también con la carrera en marcha—: no afectan al cronometraje ni al calendario. Al apagarlos, lo ya anotado **no se borra**: si los vuelves a encender, reaparece.

## [1.48.0] — 2026-10-08

### Añadido
- **Corregir a mano la coma (opcional).** La **coma** —la fracción de vuelta que llevaba cada coche al caer la bandera— se sigue calculando sola, y por defecto nada cambia. Pero si el automatismo engaña (un coche que se sale o se queda parado y sigue «avanzando» en la estimación), ahora puedes arreglarlo: en **Ajustes → Preferencias → «Corrección manual de la coma»** eliges **Automática (recomendado)** o **Permitir corregirla a mano**. Se guarda al momento y el cambio reordena al instante las clasificaciones ya calculadas. Con el ajuste activo, en la pantalla de **Correcciones** de una manga **ya terminada** cada carril tiene un control **Coma**: escribes la fracción (**de 0 a 0,99**, con coma o punto) y **guardas**, o la dejas **vacía** (o pulsas el botón de **volver a la automática**) para recuperar el cálculo de siempre. Los carriles corregidos se marcan **a mano** (azul) con la automática de referencia; en mangas que no son la última que corrió esa entidad, una etiqueta **«no decide»** avisa de que ahí la corrección no cambia el desempate (solo la coma acumulada de referencia que se exporta).
- **La coma corregida manda en el desempate.** A igualdad de vueltas, si alguno de los implicados tiene la coma corregida a mano, manda ella por delante de «gana quien cruzó antes la meta»: el instante del cruce es justo el dato que engaña si el coche se quedó parado. Sin ninguna corrección, sigue decidiendo el instante del cruce igual que antes. Se aplica al orden de clasificación, la clasificación estimada en directo, los resultados (allí el badge de la coma sale en **azul** y avisa «corregida a mano»), el podio y las exportaciones a Excel/CSV.
- **Apagado por defecto y reversible.** Con el ajuste en automática, las comas corregidas se ignoran al momento (vuelve el cálculo automático) pero **no se borran**: al reactivarlo, reaparecen. Al **repetir una manga** (o tras un stop forzado que la devuelve a pendiente), sus comas corregidas se borran, porque la manga se vuelve a correr. El control solo aparece en mangas cerradas.

## [1.47.0] — 2026-10-08

### Añadido
- **La vuelta de bandera va con su tiempo real.** Cuando termina una manga, el último paso de cada coche por meta llega un instante después del final: antes se descartaba y PitWall reponía esa vuelta con la **media del carril** (una estimación). Ahora PitWall sigue esperando ese cruce unos segundos y lo guarda como **vuelta de bandera cronometrada**, con el **tiempo real del DS-300**, así la última vuelta y el orden de llegada son los de verdad. Si el cruce no llega, la vuelta se repone con la media como hasta ahora; en el **registro de sucesos** se distingue si quedó **cronometrada** o **repuesta**.
- **A igualdad de vueltas, gana quien cruzó antes la meta.** Cuando dos pilotos o equipos empatan a vueltas y acabaron en la **misma manga**, ahora desempata el **instante de su último cruce**: va delante quien pasó antes por meta. Si acabaron en mangas distintas o no hay dato (carreras antiguas), sigue decidiendo la **coma de la última manga** como siempre. Se aplica en el directo, los resultados, las clasificaciones y las exportaciones a Excel/CSV.
- **Nuevo ajuste «Espera de cruces tras el final (s)»** en **Ajustes → Preferencias**: los segundos que se sigue esperando, tras el final de la manga, el cruce que cronometra la vuelta de bandera (de **0 a 10 s**; por defecto **1,5 s**). Con **0** se desactiva y la vuelta vuelve a reponerse con la media. Se guarda al momento y se aplica desde la siguiente manga.

## [1.46.0] — 2026-10-06

### Añadido
- **Modo básico / avanzado.** En **Ajustes → Preferencias → «Modo de la app»** (o en **Personalizar** del inicio) puedes dejar el inicio con lo justo para un club: **Entreno libre**, **Carrera sprint** y **Resultados**, más **Categorías**, **Escenarios** y **Ajustes** (para volver al avanzado). En básico las carreras ya creadas se abren desde la tabla de carreras recientes del inicio. El modo avanzado sigue mostrándolo todo. Se guarda al momento y no corta el cronometraje.
- **Contraseña de acceso** (Ajustes → **Seguridad**), para que quien no conoce el programa no toque lo que no debe. Protege los botones de **Sistema** (Ajustes, Base de datos, Sincronizar catálogo, Sincronizar carrera, Conexión ecosistema, Solución de problemas) y de **Catálogo** (Pilotos, Equipos, Coches, Categorías, Escenarios), también en el propio ordenador y en la app de escritorio. El inicio y todo lo de Competición (carreras, entrenos, resultados, directo, correcciones) siguen sin contraseña. En el inicio, esos botones llevan un candado y la cabecera muestra **Entrar** o **Bloquear** (cerrar la sesión al dejar el ordenador). Tras 5 intentos fallidos, esa IP espera 30 s (el propio ordenador de PitWall nunca se bloquea). La contraseña sigue activa tras reiniciar PitWall; lo que se cierra es la sesión. Si se olvida, arranca PitWall con `PITWALL_DISABLE_PASSWORD=1` y ponla de nuevo.
- **Entrenos: «Las 10 mejores».** En **Ajustes → Preferencias → «Historial de vueltas en entrenos»** eliges si la vista **Con historial** de cada carril muestra las 10 últimas vueltas (la más reciente arriba) o las 10 mejores, de mejor a peor, siempre con su número de vuelta. Vale para entreno libre y de competición.

### Mejorado
- **Nueva carrera más sencilla.** Si entras por **Carrera sprint** o **Carrera resistencia**, el asistente ya no pregunta el tipo: el título lo dice y hay un enlace para cambiar al otro. El primer paso queda en nombre, circuito y pole; con un circuito guardado, sus carriles y la vuelta mínima se resumen en una línea. **Pasadas** y **Repetir carril** pasan a **Más opciones** (plegado), y las reglas de resistencia solo salen en resistencia. **Volver** desde los pasos siguientes ya no borra lo que habías rellenado.
- **Botones separados en el inicio:** **Carrera sprint** y **Carrera resistencia** abren el asistente con el tipo ya marcado, y **Entreno libre** y **Entreno de competición** sustituyen al antiguo «Entrenamientos».
- **Resultados rediseñados:** buscador (carrera, circuito, equipo o piloto del podio), pestañas **Todas / Sprint / Resistencia** y la última carrera destacada arriba. Cada tarjeta muestra tipo, fecha, circuito, pilotos o equipos, mangas, el podio con sus vueltas y la vuelta rápida. Abre al instante aunque haya carreras de 24 h guardadas.

### Corregido
- **Corregir vueltas con la manga en marcha se ve al momento en el directo.** Antes el cambio no aparecía hasta el siguiente cruce, y tras añadir una vuelta a mano la siguiente salía con un número de vuelta repetido. Ahora el directo y la clasificación se actualizan en cuanto guardas la corrección y la numeración sigue bien.

## [1.45.2] — 2026-10-06

### Corregido
- **Pantalla completa del directo en Windows:** el botón ponía la ventana en pantalla completa pero luego no salía de ella. Ahora entra y sale con el mismo botón, también en las ventanas abiertas aparte.

## [1.45.1] — 2026-10-05

### Corregido
- **PitWall no arrancaba en Windows («No se pudo iniciar el servidor») ni en Linux.** Los instaladores de Windows y Linux se generaban con la base de datos preparada para Mac y el servidor interno no podía abrirla. Ahora cada sistema lleva la suya.
- **La app de escritorio arranca mucho más rápido.** La librería de exportar a Excel ya no se carga al abrir PitWall, sino la primera vez que exportas. El servidor interno pasa de unos 4 s a menos de medio segundo en estar listo.
- **Si el servidor no arranca, ahora se ve el motivo.** Antes salía solo «No se pudo iniciar el servidor: Timeout» tras 15 s. Ahora el aviso muestra el error real en cuanto el servidor se cierra, se espera hasta 60 s a un arranque lento y la salida se guarda en `logs/server.log` dentro de la carpeta de datos de PitWall.

## [1.45.0] — 2026-10-05

### Añadido
- **Colores de carril personalizables.** Cada circuito puede tener sus propios colores de carril (ficha del circuito → **«Colores de los carriles»** → «Usar colores propios en este circuito»), para que la pantalla coincida con los colores pintados en la pista. Además hay una **paleta global** en **Configuración → Preferencias → Colores de carril**, que se usa cuando no hay circuito o el circuito no tiene colores propios. Se aplican en todas las pantallas: directo, TV, paneles, entrenos, pole, tandas, resultados y control de pilotos. La paleta global se guarda al momento y no reinicia la conexión del cronometraje.
- **Número del carril legible en cualquier color:** en las tarjetas del directo y del entreno el número sale en negro o en blanco según lo claro que sea el color.

## [1.44.2] — 2026-10-05

### Mejorado
- **Entrenamiento libre: los datos de la tanda se quedan a la vista al terminar.** Al acabar la tanda (fin del DS-300 o fin automático por tiempo) ya no se borran las vueltas, la media, la mejor ni el gráfico de ritmo de cada carril: se borran al dar el **siguiente GO**. El récord de pista sigue igual (solo se borra con **Reset**).
- **Vuelta a vuelta del entrenamiento más grande.** Los tiempos de la lista de vueltas de cada tarjeta crecen con el ancho de la tarjeta, así que con 6 carriles se leen casi al tamaño de Mejor / Media / Récord.

## [1.44.1] — 2026-10-04

### Corregido
- **Directo de entrenamiento:** con 6 o más carriles, Mejor / Media / Récord ya no se cortan («12....»); el gráfico de ritmo ocupa todo el alto libre de la tarjeta y la vista compacta mete 6 carriles por fila en una pantalla de 1440 px.

## [1.44.0] — 2026-10-04

### Añadido
- **Inicio personalizable.** El botón **«Personalizar»** del inicio deja elegir entre los diseños del boceto: **A + C · Mando con lanzador** (el de siempre, por defecto), **A · Centro de mando**, **B · Menú lateral + panel**, **C · Lanzador compacto** y **D · Mando con menú lateral**. La elección se guarda en el PitWall, así que la app de escritorio y cualquier navegador ven el mismo inicio.

### Mejorado
- **«Abrir enlaces en» (Ventana nueva / Esta ventana) pasa a la cabecera del inicio**, al lado de «Personalizar», en todos los diseños.

## [1.43.1] — 2026-10-04

### Añadido
- **Cambiar el estado de una carrera a mano.** En la ficha de la carrera, junto a la etiqueta de estado, el botón **«Cambiar estado»** permite pasarla a **Pendiente**, **En curso** o **Completada**. No deja cambiarlo mientras una manga de esa carrera está en marcha, y avisa si ya hay otra carrera en curso (el GO del DS va a la primera manga pendiente de cualquier carrera en curso).

## [1.43.0] — 2026-10-04

### Añadido
- **Buscador en los catálogos de pilotos, equipos y coches.** Escribe para filtrar al momento (en pilotos también por categoría), con el contador de resultados a la vista. La tecla `/` lleva al buscador y Esc lo limpia; al volver de editar una ficha, el filtro sigue puesto.
- **Gráfico de ritmo en el directo de entrenamiento.** Cada carril muestra su ritmo vuelta a vuelta, con líneas de mejor vuelta y media; al pasar por encima ves el número de vuelta, el tiempo y lo que le falta a la mejor.

### Mejorado
- **Inicio más claro y sin menú lateral.** Cabecera con un buscador **«Ir a…»** (`⌘K` / `Ctrl K`; Intro abre el primer resultado, Esc lo limpia) y el estado del DS y la IP del servidor; debajo, la franja de la carrera en curso y los accesos en mosaicos de **Competición**, **Catálogo** (con cuántos tienes de cada) y **Sistema**, el interruptor **«Abrir enlaces en»** y la tabla de **Carreras recientes**. Una barra fija abajo lista las **ventanas abiertas** para traerlas al frente o cerrarlas. Mayús + clic abre en la misma ventana.
  - La franja de la carrera en curso añade el botón **Corrección de vueltas** (de la manga en curso o la última terminada); el **líder estimado** es el mismo que el de la Clasificación estimada del directo y se actualiza en vivo; **Mangas** cuenta ya la manga que se está corriendo (1/10 desde que arranca la primera).
  - El inicio se actualiza solo cuando arranca una carrera o cambia su estado, sin recargar a mano.
- **Directo de entrenamiento renovado.** Los botones de arriba son los mismos que en el directo de carrera (GO, pausa, STOP, voz, Vista, reiniciar, pantalla completa, Volver). Cada tarjeta muestra la última vuelta y su diferencia con la mejor, la fila Mejor / Media / Récord y solo las **10 últimas vueltas**, cada una con su número. La vista compacta también enseña la última vuelta con su diferencia, Mejor / Media / Récord y el ritmo en miniatura.
- **Formulario del entreno de competición más cómodo.** Pasos numerados, buscador en el catálogo de equipos (Intro añade el primero), subir o bajar un participante de carril, **Sortear carriles**, **Vaciar todo**, aviso de nombres repetidos, botón **Orden natural** en la secuencia y una barra fija con el resumen (carriles · en pista · reserva) y **Preparar sesión**.
- **Nueva carrera más guiada.** El primer paso del asistente se ordena en bloques numerados (Datos, Pista, Formato y, solo en resistencia, Reglas de resistencia), con iconos claros. Antes de enviar avisa si falta el nombre o el tipo, o si algún circuito no tiene entre 2 y 8 carriles, y una barra fija abajo resume la carrera con el botón **Siguiente**.

### Corregido
- **En la app de escritorio, algunas secciones no se abrían desde el inicio** (por ejemplo Entrenamientos o Ajustes) si su ventana ya existía pero se había vuelto al inicio desde ella: había que cerrarla o reiniciar la app. Ahora esa ventana vuelve a la sección pedida y se trae al frente, aunque esté minimizada.

## [1.42.2] — 2026-10-04

### Corregido
- **La pantalla completa del directo se perdía en cada actualización** (al acabar el semáforo, al terminar o pausar la manga…) y había que volver a pulsar. En la app de escritorio, el botón de pantalla completa pone ahora **la ventana** en pantalla completa, que se mantiene aunque el directo se recargue. Esc y «Volver» siguen saliendo de ella. En el navegador no cambia: ahí la recarga siempre la quita y el primer toque la recupera.

## [1.42.1] — 2026-10-04

### Corregido
- **Error 500 al recibir verificaciones de PitWall Control.** Con muchas verificaciones con fotos, el envío pasaba del límite de 8 MB y fallaba («request entity too large»). Ahora las importaciones de PitWall Control (`/import/…`) admiten hasta 100 MB.

## [1.42.0] — 2026-10-04

### Añadido
- **Inicio rediseñado para el operador.** Menú lateral siempre visible con todas las secciones (Competición, Catálogo y Sistema, con sus contadores) y, arriba del todo, una **franja con la carrera en curso**: manga X de Y, tanda, **reloj de la manga en vivo**, mangas hechas, líder estimado y botones directos a **Directo, Pantalla TV, Estadísticas en vivo, Control de pilotos, Neumáticos, Registro de sucesos** y Gestionar carrera. Debajo, cuatro accesos rápidos (Nueva carrera, Entrenamientos, Resultados, Lap) y una **tabla con las últimas carreras** y su acción directa (Directo, Abrir o Resultados).
  - Sin carrera en marcha, la franja muestra la pole en curso o, si no hay, «Nueva carrera» y «Entreno libre».
  - Al empezar, terminar o pausar una manga, la página se actualiza sola.
- **Las secciones se abren en ventanas aparte**, para seguir trabajando con una manga en marcha. Cada destino tiene su propia ventana: si ya está abierta, se trae al frente sin recargarla. Un interruptor en el menú («Ventana nueva / Esta ventana») elige el comportamiento, y en la cabecera se ve cuántas ventanas hay abiertas.
  - En la app de escritorio, las ventanas nuevas se abren como la principal (sin barra de menú y con el sonido del semáforo), y los enlaces externos (GitHub, manuales) van al navegador del sistema.

## [1.41.0] — 2026-10-04

### Añadido
- **Exportar e importar una sola carrera** (Base de datos → «Exp. / Imp. carrera»). Para llevarte a tu PC la carrera que has corrido en otro club sin mover la base de datos entera. Se descarga un archivo **.pwrace** con todo: equipos, pilotos, tandas, mangas, vueltas, turnos de piloto, neumáticos, sucesos, verificaciones con fotos, pole y categorías. Al importarlo entra como **carrera nueva, al momento y sin reiniciar**, sin tocar el resto de carreras; si su circuito no existe en el PC, se crea. Una 24 h de 150.000 vueltas ocupa unos 3 MB y se importa en menos de un segundo.
  - No se puede importar dos veces la misma carrera: avisa y enlaza a la que ya tienes.
  - No se exporta una carrera con una manga sin cerrar (ciérrala o cancélala en Solución de problemas), y una carrera que venía «en curso» entra como pendiente, para que nunca se quede con el GO del DS-300 de este PC.
  - Exportar e importar esperan a que no haya una manga en marcha, como la exportación a Excel.
- **Resumen de la base de datos:** cuántas carreras, equipos, pilotos, circuitos y vueltas hay, además del tamaño del fichero.

### Mejorado
- **Configuración rediseñada con menú lateral:** Fuente de datos, Preferencias, Red local, Seguimiento online, Integraciones y Diagnóstico. Cada sección en su pantalla, con puntos de estado en el menú (cronómetro, túnel, modo debug), y vuelve a la última sección tras guardar.
  - **Barra fija de guardado** que avisa de **cambios sin guardar** y de cuáles **necesitan reiniciar** PitWall (solo la interfaz de red y HTTPS; el resto se aplica al guardar).
  - Infolap ya no dice que requiere reiniciar: se activa y desactiva al momento.
- **Mismo estilo en Base de datos** (menú: Resumen, Exp. / Imp. carrera, Copia de seguridad, Restaurar copia), **Solución de problemas** (menú: Estado, Cronometraje, Cronómetro, Mangas atascadas, Conexiones; «Estado» lista las incidencias con un botón para ir a cada una), **Sincronizar carrera** (menú: Enlace maestro/esclavo, Desde el maestro, Desde fichero, Comparar DS↔BART), **Conexión ecosistema** y **Sincronizar catálogo** (con barra fija «Se aplicará a N carreras»).
- Subir una copia de la base de datos completa usa ahora el botón rojo de peligro, para no confundirlo con descargarla.

### Corregido
- **Los avisos de Solución de problemas no se veían** («Boundary de tanda limpiado», «Manga reseteada»…).
- **Los avisos salían repetidos** en Configuración, Base de datos, Sincronizar carrera, Conexión ecosistema y Sincronizar catálogo.

## [1.40.0] — 2026-10-04

### Añadido
- **Tarjetas del directo rediseñadas, legibles de lejos.** La **última vuelta** va en grande con el **total de vueltas** al lado, y debajo mejor vuelta, media, Gap V y vueltas de la manga. Las cifras se ajustan solas al tamaño de cada tarjeta, así que no se pisan con 6, 24 o 40 equipos. La última vuelta sale en **morado con «RÉCORD CARRERA»** si es la vuelta rápida de la carrera y en **azul con «BOXES»** si fue una parada (antes salía en rojo como una vuelta lenta).
- **Piloto al volante en las tarjetas**, con una **barra del tiempo que lleva conducido en la carrera** frente al máximo por piloto (ámbar desde el 85 %, rojo si lo pasa). Si un carril no ha fichado, aparece **«SIN PILOTO»** mientras la manga está en marcha.
- **Avisos en cada tarjeta:** salidas, **paradas en boxes («PIT 2»)** y **juegos de neumáticos usados sobre el total («4/12»)**. Una parada o un cambio de neumáticos recién hechos se resaltan durante unos segundos.
- **Vista por filas a dos columnas** cuando los equipos no caben en una: se ven **todos a la vez** (hasta 40 en una pantalla de 1080p), cada columna con su cabecera, y los que descansan en su posición. En carreras con control de pilotos, cada fila lleva **el piloto fijo debajo del equipo** (ya no se alterna con el nombre del equipo).
- **Clasificación estimada al lado también en la vista de tarjetas**, con el mismo botón que en filas. Con el panel abierto, las tarjetas quitan mejor, media y Gap V (ya están en la clasificación) y mantienen las **vueltas de la manga** bajo el total.
- **Ajustes → «Orden del directo»:** ordenar tarjetas y filas por **clasificación estimada** (como hasta ahora) o por **vueltas reales** (a igualdad, menos tiempo total). Con vueltas reales, el Gap V no se muestra en tarjetas ni filas.

### Mejorado
- **Cabecera del directo más compacta:** relojes, tanda, manga y estado en una sola línea y botones solo con icono (salvo PAUSE, STOP, GO, REANUDAR y «Tanda N»). Pasa de 143 a 80 px de alto, que ganan las tarjetas y las filas.
- **Nuevo aspecto de la clasificación estimada:** podio oro/plata/bronce, flecha que compara la posición estimada con la de vueltas reales, bandera y nombre en fuente estrecha, y atenuados los que no corren esta manga. **Caben siempre todos los equipos** sin pasar de página.
- **Se quita la vista «Cuadrícula compacta»:** era igual que «Tarjetas con detalles» con menos datos. Quien la tuviera elegida, o un enlace con `?view=2`, abre las tarjetas.
- **Tarjetas de descanso** con una disposición fija (posición, equipo, vueltas y «DESCANSO x/y»).
- **Gap V sin ceros de relleno:** «-6» y «-0.5» en lugar de «-6.00» y «-0.50».

### Corregido
- **Tras recargar el directo en pantalla completa, los botones necesitaban dos clics:** el primero solo volvía a pantalla completa. Ahora un clic en un botón hace su acción a la primera; la pantalla completa vuelve al tocar una zona sin botones o pulsar una tecla.
- **La bandera vasca salía como texto («_SVG_EUS_») en el directo**, y las demás banderas no se veían en Windows. Ahora se pintan como imagen.
- **«Tarjetas con detalles» con pocos carriles** mostraba las cifras diminutas dentro de cajas enormes.

## [1.39.2] — 2026-10-04

### Corregido
- **En modo simulación la manga no terminaba nunca.** Al acabar el tiempo seguía en carrera indefinidamente. Ahora se cierra **justo al agotarse el tiempo**, como en una carrera real. Con la caja DS-300 y con la carrera simulada a partir de una grabación no cambia nada.
- **En simulación y con BART no aparecía el botón GO al terminar una manga**, así que no había forma de arrancar la siguiente desde el directo. Ahora la manga terminada muestra el **GO (con su duración)** para la **siguiente manga pendiente**, también si es la primera de la tanda siguiente, y al ponerse verde el semáforo la pantalla salta sola a ella.

## [1.39.1] — 2026-10-03

### Corregido
- **El Registro de sucesos mezclaba las mangas de tandas distintas.** En carreras con varias tandas, la caja «Manga 1» juntaba las mangas 1 de todas las tandas (y así con cada número), así que parecía que solo salían las de la primera tanda y la hora no decía de qué día era. Ahora hay **una caja por manga real**, titulada **«Tanda N · Manga M»** cuando la carrera tiene más de una tanda, con el **día y la hora de arranque** (p. ej. «vie 2/10 · 21:07»), ordenadas de la más reciente a la más antigua; se abre desplegada la manga que está en marcha.

## [1.39.0] — 2026-10-03

### Añadido
- **Clasificación estimada al lado de las filas, como en TicTac.** En el directo de la manga, un botón nuevo en la barra (junto a «Vista», con icono de panel lateral) abre y cierra la clasificación estimada acoplada a la derecha. Funciona en la vista **«Filas horizontales»** y PitWall recuerda si la dejaste abierta en cada carrera.
- **El panel se ajusta solo.** De entrada usa el **ancho justo** para que se lean los nombres enteros (como mucho el 40% de la pantalla), con las columnas **#, participante, V. Proy.** (vueltas estimadas), **Total** (vueltas reales) y **Media**. La letra se adapta al alto para que quepan todos; si aun así no caben, pasa de página cada 20 s. Si **arrastras el borde** eliges tú el ancho (y, si sobra sitio, aparecen también **Gap V** y la tendencia); con **doble clic en el borde** vuelve al ancho automático.
- **Enlaces para pantallas fijas de sala o TV:** añadiendo `?side=standings` (panel abierto) o `?side=none` (cerrado) y `?view=1`, `?view=2` o `?view=3` (vista) a la dirección del directo, esa pantalla arranca siempre así, sin cambiar lo que tengas guardado.

### Mejorado
- **«Filas horizontales» se ve bien a cualquier tamaño de ventana.** El tamaño de letra se calcula según el espacio real de cada columna: las cifras ya no se pisan entre sí (antes, a media pantalla, se solapaban) y el **nombre del piloto tiene prioridad** y se ve entero (antes se cortaba aunque sobrara sitio). En ventanas muy estrechas se ocultan primero **Gap V**, luego **VLT** y luego **ÚLTIMA**.
- **Barra de botones más compacta en pantallas de menos de 1400 px de ancho:** Repetir, voz, Vista y Volver se quedan solo con su icono para que la barra no se desborde.

### Corregido
- **«Volver» activaba la pantalla completa en vez de volver** cuando se había salido de pantalla completa con Esc o con el botón de la ventana.
- El botón de **pantalla completa mostraba sus dos iconos a la vez**.
- Con muchos carriles en filas, **la última fila de cada página salía cortada**.
- Los **nombres se cortaban con «…» en plena carrera** al aparecer el aviso ⚠ de salidas (o 🔧 / 🛞).

## [1.38.3] — 2026-10-03

### Corregido
- **El tiempo total de la 1ª manga ya respeta los atascos en la salida.** Para que el tiempo total sea justo, PitWall cambia el primer cruce (el tramo desde la parrilla hasta la línea) por la media normal del piloto. Lo hacía siempre, también cuando el coche se había quedado atascado en parrilla: en Modena llegó a convertir **468 s perdidos de verdad en unos 10 s**. Ahora solo hace ese cambio si la salida es **más corta que la vuelta mínima de la pista** (o, si la pista no tiene vuelta mínima, que la media del piloto); una salida más larga es tiempo perdido de verdad y se cuenta tal cual.
- Solo afecta al cruce de salida de la 1ª manga (no a la primera vuelta tras una pausa) y se nota en el **tiempo total** y en los **desempates a igualdad de vueltas**.

## [1.38.2] — 2026-10-03

### Corregido
- **En Windows, los campos de texto dejaban de admitir escritura** al azar en cualquier pantalla y había que cerrar y volver a abrir la ventana. Lo provocaba un fallo de Electron: después de cualquier ventana de confirmación («¿Seguro que…?»), la ventana se quedaba sin foco de teclado, y se notaba más tarde, a menudo ya en otra página. Ahora PitWall devuelve el foco a la ventana en cuanto se cierra la confirmación. En macOS no pasaba y no cambia nada.

## [1.38.1] — 2026-10-03

### Mejorado
- **«Editar tanda» muestra los participantes ordenados por carril** (1, 2, 3…), con los **descansos al final**. Antes salían en el orden de la rotación de carriles (p. ej. 1, 3, 5, 6, 4, 2), lo que hacía difícil encontrar a cada uno. Solo cambia cómo se ven: al guardar, cada participante sigue en el mismo carril que tenía.

## [1.38.0] — 2026-10-03

### Mejorado
- **Las salidas de pista ahora cuentan igual que las «vueltas lentas» de TicTac.** Es **salida** toda vuelta que tarde **más que la vuelta rápida de ese piloto en ese carril durante la manga + 1,5 s**, incluida la primera vuelta (antes se comparaba con la media limpia + 1,7 s). Si además tarda el doble de su media limpia o más, sigue siendo **parada en boxes (🔧)**. Las vueltas que repone PitWall (bandera, caída de conexión) nunca cuentan como salida. Comparado con TicTac en **RESISLEMANS 1**, las salidas pasan a coincidir casi pista a pista.
- **En directo, las salidas pueden aparecer en vueltas ya pasadas.** Como la vuelta rápida va bajando durante la manga, cuando un piloto la mejora PitWall revisa sus vueltas anteriores en ese carril y marca como salida las que ahora quedan por encima del límite (p. ej. con mejor 10,20 s una vuelta de 11,50 s no es salida; si luego hace 9,80 s, sí lo es). Al cerrar la manga se repasa todo con la vuelta rápida definitiva. Esto cambia el número de salidas en el directo, en Resultados y en PitWall Lap, y las cifras «limpias / sin salidas» (media limpia, ritmo limpio, consistencia).
- **La coma y el desempate no cambian**, y **las carreras ya corridas se quedan como estaban**: la regla nueva vale para las próximas.

## [1.37.3] — 2026-10-03

### Corregido
- **Vueltas de más en algunos arranques de manga con el DS-300.** Cuando todos los coches cruzan a la vez al empezar, el DS-300 manda una ráfaga de avisos que a veces llegaba partida a PitWall. En esos casos PitWall podía **contar una vuelta de más** (incluso anotar cruces en carriles que no existen) o **perder cruces** que luego reponía al final como vueltas de bandera. Ahora PitWall recompone bien esas ráfagas, descarta los trozos sueltos y no cuenta dos veces un mismo aviso repetido.
- **Una vuelta fantasma pasada a otro carril podía acabar contando para los dos.** Al cerrar la manga (o tras una caída de conexión), PitWall reponía en el carril de origen una vuelta de bandera que en realidad ya se había asignado al otro carril. Ahora esa vuelta cuenta solo para el piloto al que se asignó.
- Se detectó comparando con **TicTac** los resultados de **RESISLEMANS 1** (PitWall daba 9 vueltas más). Las carreras ya corridas no cambian: el arreglo vale para las próximas.

## [1.37.2] — 2026-10-03

### Corregido
- **Al traer los resultados a PitWall Control, llegaban las posiciones de cada tanda en vez de la clasificación final.** Cada tanda empezaba otra vez desde el 1, así que Control daba los puntos del ganador (y del segundo, del tercero…) a un piloto de cada tanda. Ahora «Traer resultados de PitWall» recibe la **posición en la clasificación final de la carrera**, la misma que ves en Resultados (con el desempate oficial), y Control reparte los puntos correctamente. La vista previa sigue mostrando en qué tanda corrió cada uno.

## [1.37.1] — 2026-10-02

### Corregido
- **La ventana «Clasificación General» se quedaba atrasada al acabar la manga.** Mostraba hasta 4 vueltas menos que el directo y que los resultados para quien corría la última manga: le faltaba la última vuelta y las vueltas de bandera que PitWall repone al cerrar (las que el DS-300 contó con el circuito ya cerrado). Ahora la ventana se recarga sola al terminar la manga y también cuando se reponen vueltas, así que muestra el total real. Los resultados guardados siempre fueron correctos.

## [1.37.0] — 2026-10-02

### Añadido
- **Seguimiento de rivales en PitWall Lap.** En el panel del equipo hay una sección nueva, **«Seguimiento · mangas terminadas»**, con una tarjeta para tu equipo (marcada **Tú**) y otra por cada rival que sigas (hasta **5**). Cada tarjeta muestra, carril a carril y en total: **vueltas**, vuelta **rápida**, **media** (con salidas) y media **limpia** (sin salidas). Solo cuentan las mangas ya terminadas: la que está en curso no entra hasta que se cierra.
- Los rivales se eligen en **«Elegir equipos a seguir (hasta 5)»** y se guardan **para todo el equipo**: todos los móviles del mismo box ven la misma lista y se actualizan solos cuando alguien la cambia.
- La **app móvil PitWall Lap** también puede leer el seguimiento y cambiar la lista (`/api/mobile/races/:id/tracking`). Para cambiarla pide el **PIN del equipo** de la hoja de PINs, salvo que la carrera tenga el PIN desactivado.

## [1.36.2] — 2026-09-13

### Corregido
- **Vuelta fantasma asignada al carril equivocado con varios circuitos.** Con el agrupador DS-300 o varios Masters BART (varias pistas físicamente independientes en la misma carrera), la asignación automática de un cruce "vuelta fantasma" podía certificarse con el fantasma de OTRO circuito, algo físicamente imposible (los carriles de cada pista no se cruzan entre sí). Ahora solo se emparejan fantasma y cruce si son del mismo circuito.

## [1.36.1] — 2026-09-11

### Corregido
- **Vuelta rápida de la carrera de prueba «Llinars 24h simulada».** Aparecía una vuelta imposible de 11,670s que en realidad era ruido del sensor (vuelta fantasma), no una vuelta real. Ajustado el umbral que descarta estas vueltas al reconstruir la carrera a partir de las tramas originales; ahora la vuelta rápida sale correcta (14,348s, coincide exacto con el registro oficial de la carrera real). No afecta a la clasificación general.

## [1.36.0] — 2026-09-11

### Añadido
- **La rejilla de gap ya muestra la hora real de cada manga.** En Resultados → *Gap (rejilla)*, debajo de cada cabecera «M1», «M2»... ahora aparece la hora a la que arrancó esa manga (en tu hora local; al pasar el ratón se ve la fecha y hora completas). En carreras largas (24h) que cruzan la medianoche, la cabecera de la manga donde cambia el día se resalta en **dorado** para verlo de un vistazo. Pensado para poder cruzar la rejilla con sucesos reales conocidos por hora.

### Corregido
- **Zona horaria de la carrera de prueba «Llinars 24h simulada».** El script que la genera guardaba la hora local de Llinars (verano, UTC+2) como si ya fuera UTC, así que las horas se veían 2h adelantadas. Ya guarda la hora correcta.

## [1.35.1] — 2026-09-11

### Corregido
- **«Exportar para GitHub» ya dibuja las gráficas.** La exportación de resultados a un HTML autocontenido (para publicarlo en GitHub Pages u otro sitio sin depender del servidor de PitWall) buscaba una versión antigua de Chart.js que ya no se usa, así que nunca la encontraba y el gráfico se quedaba con una referencia a un fichero que solo existe dentro de la app —resultado: ninguna gráfica se dibujaba (gap al líder, progresión, posiciones). Ahora se inserta el Chart.js correcto y también se retira una referencia a las fuentes del servidor que tampoco existía en el export, así que el HTML exportado ya no depende de nada externo.

## [1.35.0] — 2026-09-08

### Mejorado
- **La exportación a Excel ya no puede frenar el cronometraje.** Generar el Excel de resultados de una carrera larga es la operación más pesada de la app (decenas de miles de filas con formato más la compresión del fichero), y hasta ahora corría en el mismo hilo que atiende al cronómetro: hacerlo con una manga en marcha podía partir una trama y perder un cruce. Ahora:
  - **No se deja exportar a Excel mientras hay una manga viva** (corriendo o en pausa). Los tres botones de Excel —resultados, puntos de clasificación e informe de turnos— avisan de que hay que detener la manga o esperar a que termine la carrera. Con la manga parada o la carrera finalizada funcionan igual que siempre.
  - **Si una exportación estaba en curso y arranca una manga** (por ejemplo se lanzó entre mangas y llega el GO del cronómetro), esa exportación se cancela automáticamente para dejar el hilo libre para las vueltas. Quien la pidió recibe el aviso y puede repetirla al acabar.

## [1.34.2] — 2026-09-07

### Mejorado
- **Nuevo índice en la base de datos para los cálculos de estadísticas de toda la carrera.** Las consultas que recorren todas las vueltas para sacar el ritmo medio, la consistencia y el progreso manga a manga de cada equipo tenían que leer fila por fila la tabla completa. Con un índice que ya las cubre, sobre una carrera de 24 h con 160.000 vueltas bajan a la mitad o menos (p. ej. la del progreso, de 78 ms a 35 ms). Ayuda sobre todo en PCs poco potentes: el hilo auxiliar recalcula más rápido y los datos van más frescos. El índice se crea solo al arrancar (ocupa ~1/3 de lo que ocupa la tabla de vueltas).

## [1.34.1] — 2026-09-07

### Mejorado
- **En equipos poco potentes, el arranque de cada manga tampoco da un tirón.** Los tres cálculos que solo se hacen una vez por manga (la corrección de la vuelta de salida, la clasificación proyectada y los agregados de toda la carrera) se preparaban en el primer cruce; en un PC lento eso podía ser un parón de más de un segundo justo al empezar. Ahora se preparan durante la cuenta atrás del semáforo —cuando no hay ningún coche cruzando— y el hilo auxiliar tiene los datos listos antes de la primera vuelta. En la prueba de estrés simulando una máquina a media potencia (24 h, 160.000 vueltas, ~140 dispositivos) no queda **ningún** parón capaz de perder un cruce (antes quedaba 1, el del arranque).

## [1.34.0] — 2026-09-07

### Mejorado
- **La página de estadísticas en vivo tampoco frena ya el cronometraje.** Siguiendo lo que se empezó en la v1.33.0 con la clasificación proyectada: los cálculos que recorren toda la carrera para las estadísticas en vivo (ritmo medio, consistencia y progreso manga a manga de cada equipo) —la otra operación pesada, ~250 ms sobre una carrera de 24 h— pasan también al hilo aparte. El hilo principal sirve el último resultado y pide uno nuevo en segundo plano, sin quedarse bloqueado aunque haya muchas pantallas de estadísticas abiertas a la vez. En la misma prueba de estrés (24 h, 160.000 vueltas, ~140 dispositivos) los parones capaces de perder un cruce bajan de 5 a 1 (y ese único parón es el arranque, no ocurre en carrera). El resultado que ve el espectador es idéntico al de antes. Si el hilo auxiliar no está disponible, todo se calcula como hasta ahora.

## [1.33.1] — 2026-09-07

### Corregido
- **El filtro «Completada» de la lista de carreras ya cuenta bien.** La lista comparaba el estado de la carrera con `completed`, pero PitWall guarda las carreras terminadas como `finished`: el contador de la pestaña salía siempre en 0, el filtro no mostraba ninguna carrera y la etiqueta de la tarjeta enseñaba el texto crudo «finished» en vez de «Completada». Ahora los tres puntos usan el estado real.

## [1.33.0] — 2026-09-07

### Mejorado
- **El cálculo de la clasificación proyectada ya no frena el cronometraje cuando hay muchas pantallas conectadas.** La estimación de "dónde va a acabar cada equipo" (que suma vueltas reales más el tiempo restante dividido por la media) es la operación más pesada de PitWall en una carrera larga, y hasta ahora se hacía en el mismo hilo que atiende al DS-300: con decenas de móviles, paneles de Lap web y pantallas de estadísticas pidiéndola a la vez, esos cálculos podían durar lo bastante como para partir una trama del cronómetro y perder algún cruce. Ahora ese cálculo corre en un hilo aparte y el hilo principal solo sirve el último resultado ya calculado, así que el cronometraje sigue fino aunque toda la sala esté mirando la clasificación. En una prueba de estrés equivalente a una carrera de 24 h con 160.000 vueltas y ~140 dispositivos conectados, los parones capaces de perder un cruce bajaron de 44 a 5.
- **Menos trabajo repetido al registrar cada vuelta.** La corrección de la vuelta de salida repasaba toda la carrera en cada cruce aunque el dato no hubiera cambiado; ahora ese repaso solo se rehace cuando de verdad puede haber cambiado algo, lo que aligera aún más el proceso en carreras con muchas vueltas.

## [1.32.0] — 2026-09-07

### Añadido
- **Sincronizar catálogo con carreras pendientes.** Nueva página `Sistema → Sincronizar catálogo` (y atajo «Actualizar desde catálogo» en el menú de la ficha de carrera) que vuelca los cambios del catálogo de equipos —pilotos y país— a las carreras que **aún no han arrancado ninguna manga**, sin tener que pasar por «Editar tanda». Empareja equipos por nombre, deja la plantilla de la carrera idéntica al catálogo (añade y quita pilotos) y muestra un diff antes de aplicar. No toca la parrilla ni añade/elimina equipos, y solo actúa sobre carreras en formato equipos. La categoría no se sincroniza porque ya se lee siempre del catálogo.
- **El PIN de acceso de Lap web se puede desactivar por carrera.** Interruptor en la hoja de PINs (`/lap/:raceId/pins`): con el PIN desactivado, cada equipo abre su panel de timing solo eligiéndose en la lista, sin teclear PIN (útil en eventos internos). Los PINs se conservan por si se reactiva. El ajuste viaja también al esclavo BART al sincronizar la carrera.

### Mejorado
- **La ficha de una carrera es accesible mientras hay una manga en curso.** Antes redirigía siempre al directo; ahora muestra el estado de la carrera con un enlace «Manga N» para entrar al directo cuando se quiera. Se mantienen los demás candados (no se puede arrancar una segunda manga con otra corriendo, y al dar GO desde la ficha sigue saltando sola al directo).

### Corregido
- **En el control de pilotos, el check verde tras escanear un QR desaparecía al instante.** La propia estación se recargaba ~300 ms después de escanear (por el eco del fichaje vía socket), cortando la confirmación grande. Ahora ese ✓ dura 7 s y la recarga de la estación que ha escaneado se aplaza hasta que termina; las demás pantallas se refrescan a los 2,5 s.

## [1.31.0] — 2026-08-25

### Añadido
- **El asistente de carrera simulada admite repetición de carril y varias pasadas**, igual que el flujo normal de creación de carreras. Al confirmar el análisis de las tramas se pueden indicar "Pasadas" y "Repetir carril" (mismos campos `race.passes`/`race.lane_repeat` de siempre), de modo que resultados, live-stats y la exportación a Excel desglosan las vueltas por manga/pasada sin ningún cambio adicional. El asistente valida que el nº de mangas resultante (carriles + descansos × pasadas × repetir carril) coincida con el nº de GO detectados en las tramas antes de crear nada, porque el reproductor indexa cada manga por su turno de rotación y una descuadre le haría perder la correspondencia.

## [1.30.3] — 2026-08-24

### Corregido
- **La exportación a Excel sumaba en una sola celda las vueltas de un carril repetido**, en vez de separarlas por manga como ya hacía la pantalla de resultados. Las hojas "Por carril" y "Comparativa" del Excel ahora reproducen el mismo desglose por ocurrencia (carril × manga) que la web cuando la carrera tiene repetición de carril o varias pasadas.
- **Las tandas creadas desde el flujo de pole ignoraban la repetición de carril de la carrera.** Al generar el calendario no se le pasaban `race.passes`/`race.lane_repeat`, así que una carrera con repetición de carril activada generaba solo la mitad de las mangas necesarias si la tanda se creaba por pole en vez de por el flujo normal de "Nueva tanda".

## [1.30.2] — 2026-08-24

### Corregido
- **El corrector de vueltas y el registro de sucesos no distinguían la vuelta "de final de bandera" de una reposición por caída de conexión.** Cuando el DS-300 cuenta un cruce justo al caer la bandera (llega con el circuito ya cerrado y se descartaba en directo), PitWall la repone con la media del carril igual que hace con las vueltas perdidas en una caída — pero son dos situaciones distintas: una es un corte real, la otra pasa en toda manga normal. Ahora el corrector las separa en dos categorías ("repuestas (estimadas)" en morado vs. "final de bandera" en azul) y la de final de bandera también queda registrada en el registro de sucesos de la manga (antes ninguna de las dos aparecía ahí).

## [1.30.1] — 2026-08-20

### Corregido
- **Con BART, un entrenamiento que se acababa el tiempo se quedaba "activo" para siempre.** El DS-300 avisa solo cuando se agota el tiempo de una sesión (para volver a standby y poder pulsar GO de nuevo), pero BART no manda ese aviso (lleva su propio reloj interno). Ahora el entrenamiento (libre y de competición) tiene su propio respaldo por tiempo, igual que ya tenía el modo Carrera, así que con BART también vuelve solo a standby al agotarse el tiempo.
- **Tras ese auto-fin (o tras rotar sola de tanda en un entrenamiento de competición), el botón GO no reaparecía** aunque el servidor ya estuviera listo para arrancar de nuevo — había que recargar la página a mano. Ahora la pantalla se refresca sola en ese momento, igual que ya hacía al pulsar GO.

### Mejorado
- **El campo de duración del GO en entrenamiento recuerda el último valor usado**, en vez de volver siempre a "10" minutos.
- Se etiqueta con el texto "Tiempo" el campo de duración del GO en entrenamiento, antes solo tenía un tooltip.

## [1.30.0] — 2026-08-20

### Añadido
- **Soporte para varios cronómetros BART independientes en la misma carrera.** Con más de un Master BART físico (por ejemplo `BART_TRACK1`, `BART_TRACK2`, `BART_TRACK3`, cada uno cronometrando su propio tramo de carriles), Ajustes solo dejaba configurar uno y los carriles de los demás nunca recibían cruces. Ahora la sección BART de Ajustes es una lista: añade una fila por cada Master con su nombre BLE y su nº de carriles, y PitWall se conecta a todos y numera los carriles de corrido (Master 1 → 1-8, Master 2 → 9-16…), igual que ya hacía con varias cajas DS-300.

### Corregido
- **Con varios Master BART activados a la vez, ninguno llegaba a conectar.** El escaneo Bluetooth es un único recurso compartido del proceso; al intentar conectar a varios Master en paralelo, cada uno se pisaba el escaneo de los demás y todos se quedaban reintentando sin encontrar nunca su cronómetro. Ahora el escaneo BLE se coordina entre todos los Master configurados, así que cada uno encuentra el suyo sin interferir con el resto. Verificado con hardware real: tres Master BART conectando a la vez y cruces correctos en sus 24 carriles.

## [1.29.1] — 2026-08-17

### Mejorado
- **El aviso de vuelta al público ahora se agrupa bajo mucha carga, en vez de disparar uno por cruce.** Con mucho público conectado, cada cruce de meta enviaba su propio aviso en el acto por el directo; ahora, si el servidor está ocupado, varios cruces cercanos se agrupan en un mismo aviso (nunca se pierde ninguno, solo puede llegar con un pequeño retraso agrupado con otros). Con poco público, el comportamiento es idéntico a antes: cada cruce llega al instante. No afecta al cronometraje ni al recuento de vueltas.
- **El resumen de equipo de Lap web, en el sondeo de respaldo, pasa de 5 a 10 segundos.** Ese sondeo es solo la red de seguridad por si falla el aviso en directo; como el aviso en directo ya refresca al instante, no hacía falta comprobarlo cada 5 segundos.

## [1.29.0] — 2026-08-17

### Añadido
- **Pole: saltar a quien no está en su turno.** Nuevo botón "No se presenta" en la pantalla de cronometraje de pole: al primer salto, el participante se manda al final de la cola y tendrá otra oportunidad cuando le vuelva a tocar; si se le vuelve a saltar sin haber llegado a correr, se marca como **Ausente** de verdad. Los ausentes ya no compiten por la pole con un 0.00 como si fuera la vuelta más rápida: aparecen en su propio bloque, separado, tanto en la clasificación en vivo como en los resultados finales.

## [1.28.6] — 2026-08-17

### Corregido
- **El "Gap V" de las tarjetas del directo ya no podía divergir del que se ve en la tabla "Clasificación" del sidebar.** Eran dos cálculos distintos que en algún caso raro no coincidían y hacían que el líder (P.1) no mostrara "—" como cabía esperar. Ahora las tarjetas usan el mismo gap ya calculado para la tabla, así que siempre son el mismo número.

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
