# PitWall — README Técnico

Sistema de cronometraje y gestión de carreras de scalextric. Aplicación web local que corre en el PC del evento y es accesible desde cualquier dispositivo en la misma red WiFi.

---

## Requisitos del sistema

| Componente | Mínimo | Recomendado |
|------------|--------|-------------|
| SO | Windows 10 x64 / macOS 12 / Ubuntu 20.04 | Windows 11 x64 / macOS 14+ |
| RAM | 512 MB | 2 GB |
| Disco | 200 MB libres | 500 MB libres |
| Node.js | v18 LTS | v20 LTS |
| Puerto USB | 1 (DS-300 single) | 1 por circuito |

> Para el ejecutable Electron no se necesita Node.js instalado en el sistema.

---

## Estructura del proyecto

```
pitwall/
├── electron/           # Proceso principal de Electron
│   └── main.js         # Arranque, ventana, fork del servidor Express
├── src/
│   ├── app.js          # Servidor Express + Socket.io
│   ├── routes/         # Rutas HTTP
│   ├── controllers/    # Lógica de cada sección
│   ├── models/         # Acceso a base de datos (SQLite)
│   ├── engine/         # Cálculo puro para el worker (raceProjection.js, raceWideStats.js)
│   ├── workers/        # worker_threads (statsWorker.js: proyección/agregados fuera del hilo principal)
│   ├── services/       # SerialService, TimingService, StatsWorkerClient, SocketService...
│   ├── middleware/      # i18n, control de acceso (accessControl)
│   ├── views/          # Plantillas EJS
│   ├── locales/        # Diccionario de textos: es / en / it (JSON)
│   └── config/
│       └── database.js # Inicialización del schema SQLite
├── public/             # CSS, JS estático, imágenes
├── database/           # Base de datos SQLite
└── tools/
    └── make-windows-bundle.sh  # Crea bundle offline para Windows
```

---

## Instalación y arranque (modo desarrollo)

```bash
# Clonar / descomprimir el proyecto
cd pitwall

# Instalar dependencias
npm install

# Arrancar servidor web (puerto 3000)
npm start

# Arrancar con recarga automática al modificar ficheros
npm run dev

# Arrancar como aplicación Electron (escritorio)
npm run electron
```

Acceder en el navegador: `http://localhost:3000`

---

## Variables de entorno

| Variable | Descripción | Valor por defecto |
|----------|-------------|-------------------|
| `PORT` | Puerto HTTP del servidor | `3000` |
| `PITWALL_DATA` | Ruta a la carpeta de datos (BD) | `./database` |
| `SESSION_SECRET` | Secreto para las sesiones Express | `pitwall-dev-secret` |
| `PITWALL_NO_WORKER` | Si vale `1`, desactiva el worker_thread que calcula la clasificación proyectada y los agregados de `laps` en un hilo aparte. Con el worker activo el cálculo pesado no bloquea el cronometraje cuando hay muchas pantallas conectadas | (sin definir) |

> En producción cambiar siempre `SESSION_SECRET` por un valor aleatorio largo.

---

## Base de datos

SQLite gestionado con `better-sqlite3`. El fichero se crea automáticamente en `database/pitwall.db` al primer arranque.

El schema se inicializa en `src/config/database.js`. No requiere migraciones manuales: las tablas se crean con `CREATE TABLE IF NOT EXISTS`.

**Para hacer backup** basta con copiar el fichero `database/pitwall.db`.  
**Para resetear** basta con borrarlo; se vuelve a crear vacío al reiniciar.

---

## Traducciones

La app habla **español** e **inglés**, y todo su texto sale de un diccionario, así que
se puede traducir a cualquier idioma. El **italiano** está en marcha.

**¿Quieres traducirla o revisar lo que ya hay?** No hace falta saber programar ni
usar Git: es rellenar una columna de una hoja de cálculo y mandar el fichero por
correo a **info.pitwall@gmail.com**.

Las instrucciones completas, el glosario de términos y el fichero de trabajo
están en **[`traducciones/`](traducciones/)**.

---

## Licencia

PitWall es **software libre** publicado bajo la **GNU Affero General Public License v3 (AGPLv3)** o, a tu elección, cualquier versión posterior.

Copyright © 2026 Víctor González Gómez.

Puedes **usar, estudiar, modificar y redistribuir** el software libremente. La obligación relevante de la AGPL: cualquier versión que **distribuyas o que ofrezcas a través de una red** (p. ej. sirviéndola por web) debe publicarse también bajo la AGPLv3 y poner su **código fuente completo a disposición** de los usuarios.

- Texto completo: [`LICENSE`](./LICENSE) · [gnu.org/licenses/agpl-3.0](https://www.gnu.org/licenses/agpl-3.0.html)
- Dentro de la app: enlaces **«Licencia (AGPLv3)»** y **«Código fuente»** en el pie de página, y la página `/eula`.

El software se ofrece SIN NINGUNA GARANTÍA. El nombre «PitWall» y el logotipo no forman parte de la licencia del código.

---

## Hardware

PitWall lee varias fuentes de cronometraje. Se elige en `/settings` → Fuente de datos.

### DS (DS-300, DS-200, DS-030, DS-080)
Cronómetros que se conectan por USB/RS-232 a un puerto COM. Cada circuito tiene un selector de **modelo**; al elegirlo, la velocidad pasa a la suya (DS-300: 56000 baudios; resto: 4800) y se puede cambiar a mano. El DS-080 lleva dos circuitos por un solo puerto (carriles 1–8 y 9–16). Solo el DS-300 está contrastado con aparato real; los otros tres siguen el documento de protocolo (`TicTacSlot-cuentavueltas-protocolos.md`). Manda la caja: el GO, la pausa y el fin llegan del propio DS.

**Un circuito:** elegir modelo, puerto serie, velocidad y número de carriles.
**Varios circuitos:** cada DS controla un circuito independiente y los carriles se numeran globalmente: el circuito 1 ocupa los carriles 1–N, el circuito 2 continúa desde N+1, etc. Se pueden añadir tantos como puertos USB haya.

### TicTac (interface TicTacSlot «Cuentavueltas»)
Es un dispositivo USB HID, no un puerto COM: PitWall lo **detecta solo** (VID `0x04D8`, PID `0x0001`) con el módulo opcional `node-hid`, y se reengancha si se desenchufa. En macOS puede pedir el permiso de «Monitorización de entrada»; en Linux hace falta una regla `udev`. El aparato solo manda cruces, así que **PitWall dirige la carrera**: GO con semáforo, pausa, reanudación, stop y fin por tiempo, tanto en mangas como en entrenos y pole. La opción «Puerto serie» de esa fuente sirve para el emulador (`emulador-tictac`) o su puente `hid-bridge.js`.

### BART
Cronómetro BLE/TCP (Slot.it/Policar vía puente). También lo dirige PitWall.

### Simulación
Modo de prueba que genera vueltas aleatorias sin hardware real. Configurable: número de carriles y tiempo medio de vuelta.

---

## App móvil

Aplicación React Native (Expo) que permite a los pilotos ver su clasificación en tiempo real y escuchar los tiempos de vuelta por voz.

**Repositorio:** `slotime-mobile/`

### Descubrimiento automático
La app escanea la subred WiFi buscando el servidor. El PC con PitWall y el móvil deben estar en la misma red WiFi.

### Arranque del servidor de desarrollo

```bash
cd slotime-mobile
npx expo start
```

Escanear el QR con Expo Go (iOS / Android).

### Bundle offline para Windows
Para ejecutar el servidor de desarrollo en un PC Windows sin internet:

```bash
# En el Mac (necesita internet, ejecutar una sola vez)
bash tools/make-windows-bundle.sh
```

Genera `dist/slotime-mobile-windows.zip`. En el PC Windows: extraer → `1-setup.bat` → `2-start.bat`.

---

## Compilar el ejecutable

### macOS
```bash
npm run dist:mac
# Genera: dist-app/PitWall-1.0.0-arm64.dmg
```

### Windows
```bash
npm run dist:win
# Genera: dist-app/PitWall Setup 1.0.0.exe
```

### Todas las plataformas
```bash
npm run dist
```

> **Nota:** Al compilar en macOS se generan binarios para arm64 (Apple Silicon) y x64 (Intel) automáticamente. Para compilar el instalador de Windows desde Mac se necesita Wine o hacerlo desde un PC Windows.

---

## Soporte y resolución de problemas

### El servidor no arranca — puerto en uso
```bash
# Ver qué proceso usa el puerto 3000
lsof -i :3000        # macOS / Linux
netstat -ano | findstr :3000   # Windows

# Matar el proceso
kill -9 <PID>        # macOS / Linux
taskkill /PID <PID> /F         # Windows
```

### El DS no se detecta
- Verificar que el driver USB-Serial está instalado (CH340 o similar)
- En macOS: comprobar que el puerto aparece en `/dev/tty.usbserial-*`
- En Windows: comprobar en Administrador de dispositivos que aparece como `COM*`
- Comprobar la velocidad: 56000 en el DS-300, 4800 en el resto; probar 9600 si no funciona

### El TicTac no se detecta
- Enchufarlo por USB y pulsar «Buscar puertos» en Ajustes → TicTac: debe salir «✓ TicTacSlot detectado por USB»
- Si dice «Lectura USB no disponible», falta el módulo `node-hid` en esa instalación
- En macOS, conceder el permiso de «Monitorización de entrada» a PitWall; en Linux, añadir la regla `udev`

### La app móvil no encuentra el servidor
- Verificar que el móvil y el PC están en la misma red WiFi
- Comprobar que el firewall del PC no bloquea el puerto 3000
- En Windows: permitir `node.exe` en el Firewall de Windows cuando lo solicite

### Resetear configuración de hardware
Editar o eliminar la entrada `serial_mode` en la base de datos, o acceder a `/settings` y guardar con modo simulación.

### Backup y restauración
- **Backup:** copiar `database/pitwall.db`
- **Restauración:** reemplazar ambos ficheros y reiniciar la aplicación

---

## Actualizar la aplicación

1. Descargar la nueva versión
2. Detener la aplicación
3. Reemplazar todos los ficheros **excepto** la carpeta `database/`
4. `npm install` (si se actualiza en modo desarrollo)
5. Reiniciar

La base de datos es compatible entre versiones mientras no se indique lo contrario en las notas de la versión.
