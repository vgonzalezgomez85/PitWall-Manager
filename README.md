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
│   ├── services/       # SerialService, TimingService, SocketService...
│   ├── middleware/      # i18n, licenseGuard
│   ├── views/          # Plantillas EJS
│   ├── locales/        # Traducciones ES / EN (JSON)
│   └── config/
│       └── database.js # Inicialización del schema SQLite
├── public/             # CSS, JS estático, imágenes
├── database/           # Base de datos SQLite + fichero de licencia (generado en runtime)
├── legal/              # EULA en español e inglés
└── tools/
    ├── generate-license.js     # Generador de licencias (uso interno)
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
| `SLOTIME_DATA` | Ruta a la carpeta de datos (BD + licencia) | `./database` |
| `SESSION_SECRET` | Secreto para las sesiones Express | `slotime-dev-secret` |

> En producción cambiar siempre `SESSION_SECRET` por un valor aleatorio largo.

---

## Base de datos

SQLite gestionado con `better-sqlite3`. El fichero se crea automáticamente en `database/slotime.db` al primer arranque.

El schema se inicializa en `src/config/database.js`. No requiere migraciones manuales: las tablas se crean con `CREATE TABLE IF NOT EXISTS`.

**Para hacer backup** basta con copiar el fichero `database/slotime.db`.  
**Para resetear** basta con borrarlo; se vuelve a crear vacío al reiniciar.

---

## Licencias

### Tiers disponibles

| Tier | Módulos incluidos |
|------|-------------------|
| **Basic** (sin licencia) | Simulación, DS-300 single, entrenamiento, carreras (1 tanda / 1 manga) |
| **Club** | Todo Basic + carreras ilimitadas, exportar Excel, app móvil, pole position |
| **Pro** | Todo Club + multi-circuito DS-300, vista TV/proyector |

### Generar una licencia

```bash
node tools/generate-license.js \
  --tier club \
  --licensee "Nombre del cliente" \
  --hardware "aa:bb:cc:dd:ee:ff" \
  --expires 2027-12-31
```

| Parámetro | Descripción |
|-----------|-------------|
| `--tier` | `basic` / `club` / `pro` |
| `--licensee` | Nombre del titular |
| `--hardware` | MAC address del equipo, o `*` para cualquier equipo |
| `--expires` | Fecha de caducidad en formato `YYYY-MM-DD` |
| `--out` | (Opcional) Ruta del fichero de salida |

El resultado es un JSON firmado con HMAC-SHA256. El cliente lo pega en `/license` dentro de la aplicación.

El `SIGN_SECRET` usado para firmar está en `src/services/LicenseService.js`. **Nunca debe publicarse ni incluirse en repositorios públicos.**

### Cómo funciona la verificación

Al arrancar, la aplicación:
1. Lee `database/slotime.license`
2. Verifica la firma HMAC
3. Comprueba que el Hardware ID coincide con la MAC del equipo
4. Comprueba que la fecha de caducidad no ha pasado

Si cualquier comprobación falla, el tier cae a `basic` automáticamente.

---

## Hardware DS-300

El DS-300 es el cronómetro de carreras que se conecta por USB/RS-232.

### Single circuit (Basic / Club)
Configurar en `/settings`: seleccionar modo DS-300, elegir puerto serie, baud rate (4800 por defecto) y número de carriles.

### Multi-circuit (Pro)
Cada DS-300 controla un circuito independiente. Los carriles se numeran globalmente: el circuito 1 ocupa los carriles 1–N, el circuito 2 continúa desde N+1, etc.

Se pueden añadir hasta tantos circuitos como puertos USB haya disponibles.

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

### El DS-300 no se detecta
- Verificar que el driver USB-Serial está instalado (CH340 o similar)
- En macOS: comprobar que el puerto aparece en `/dev/tty.usbserial-*`
- En Windows: comprobar en Administrador de dispositivos que aparece como `COM*`
- Probar con baud rate 9600 si 4800 no funciona

### La app móvil no encuentra el servidor
- Verificar que el móvil y el PC están en la misma red WiFi
- Comprobar que el firewall del PC no bloquea el puerto 3000
- En Windows: permitir `node.exe` en el Firewall de Windows cuando lo solicite

### Resetear configuración de hardware
Editar o eliminar la entrada `serial_mode` en la base de datos, o acceder a `/settings` y guardar con modo simulación.

### Backup y restauración
- **Backup:** copiar `database/slotime.db` y `database/slotime.license`
- **Restauración:** reemplazar ambos ficheros y reiniciar la aplicación

---

## Actualizar la aplicación

1. Descargar la nueva versión
2. Detener la aplicación
3. Reemplazar todos los ficheros **excepto** la carpeta `database/`
4. `npm install` (si se actualiza en modo desarrollo)
5. Reiniciar

La base de datos es compatible entre versiones mientras no se indique lo contrario en las notas de la versión.
