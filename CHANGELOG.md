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
