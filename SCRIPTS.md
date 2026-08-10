# Scripts de Arranque — PitWall

Scripts para facilitar el desarrollo y testing con PitWall + Emulador DS-300.

## Requerimientos

- **macOS** (los scripts están optimizados para macOS)
- `socat` instalado: `brew install socat`
- Node.js v18+ instalado

## Scripts

### 1. `start-server.sh` — Arrancar PitWall Server

```bash
./start-server.sh
```

**¿Qué hace?**
- Arranca el servidor Express de PitWall en `http://localhost:3000`
- Abre la aplicación web en el navegador automáticamente

**Logs:**
- La salida se muestra en la terminal
- Presiona `Ctrl+C` para detener el servidor

---

### 2. `start-emulators.sh` — Arrancar Emuladores DS-300

```bash
./start-emulators.sh
```

**¿Qué hace?**
- Te pide cuántos emuladores quieres arrancar (1-4)
- Para cada emulador:
  - Crea un par de puertos virtuales con `socat`
  - Arranca una instancia del emulador DS-300
  - Conecta el emulador a su puerto virtual

**Ejemplo:**

```
¿Cuántos emuladores quieres arrancar? (1-4): 2

[Emulador 1] Creando puertos virtuales...
✓ Puertos creados:
  Emulador: /dev/ttys000
  PitWall:  /dev/ttys003

[Emulador 1] Arrancando en puerto HTTP 3100...
[Emulador 1] Conectando puerto virtual...
✓ Emulador 1 listo en http://localhost:3100

[Emulador 2] Creando puertos virtuales...
✓ Puertos creados:
  Emulador: /dev/ttys004
  PitWall:  /dev/ttys005

[Emulador 2] Arrancando en puerto HTTP 3101...
✓ Emulador 2 listo en http://localhost:3101

═══════════════════════════════════════
✓ Todos los emuladores arrancados
═══════════════════════════════════════

Emuladores disponibles:
  Emulador 1: http://localhost:3100
    Puertos: /dev/ttys000 ↔ /dev/ttys003
  Emulador 2: http://localhost:3101
    Puertos: /dev/ttys004 ↔ /dev/ttys005
```

---

## Flujo de Trabajo Completo

### Setup Inicial (terminal 1)

```bash
cd ~/PitWall
./start-emulators.sh
# Responder: 2 (por ejemplo, para 2 circuitos)
```

### Arrancar servidor (terminal 2)

```bash
cd ~/PitWall
./start-server.sh
```

### Usar los emuladores

1. **Abre en el navegador:**
   - Emulador 1: `http://localhost:3100`
   - Emulador 2: `http://localhost:3101`
   - PitWall: `http://localhost:3000`

2. **Configura PitWall** (primera vez):
   - Ve a **Settings → Hardware**
   - Modo: `Modo Manual (Serial)`
   - Añade circuitos con los puertos que muestra el script:
     - Circuito 1: `/dev/ttys003` (baud 56000)
     - Circuito 2: `/dev/ttys005` (baud 56000)

3. **Inicia una carrera:**
   - En el emulador, presiona **GO**
   - Los datos aparecerán en tiempo real en PitWall

---

## Detener los procesos

### Detener emuladores
En la terminal donde corre `start-emulators.sh`:
```
Ctrl+C
```

### Detener servidor PitWall
En la terminal donde corre `start-server.sh`:
```
Ctrl+C
```

### Matar todos los procesos Node
Si algo se queda atascado:
```bash
killall node
killall socat
```

---

## Troubleshooting

### "Command not found: socat"
Instala socat:
```bash
brew install socat
```

### Puerto ya en uso
Si el puerto 3000 o 3100+ ya está en uso:
```bash
# Ver qué usa el puerto
lsof -i :3000

# Matar el proceso
kill -9 <PID>
```

### Emulador no se conecta a PitWall
- Verifica que `socat` está corriendo
- Comprueba que los puertos en Settings coinciden
- Reinicia ambos procesos

### Los puertos virtuales no se crean
En macOS 10.15+, potrebría haber restricciones de permisos.
Intenta con `sudo` si es necesario:
```bash
sudo ./start-emulators.sh
```

---

## Notas de desarrollo

- Los emuladores se guardan en `/tmp/ds300-emulator-N.log` (logs)
- Los PIDs se guardan en `/tmp/emulator-pids.txt` (para cleanup)
- Cada emulador usa un puerto HTTP único: 3100, 3101, 3102, 3103
- Los puertos seriales están emparejados: `socat` los conecta entre sí

---

## API REST del Emulador

Si quieres controlarlo programáticamente:

```bash
# Conectar puerto
curl -X POST http://localhost:3100/api/connect \
  -H "Content-Type: application/json" \
  -d '{"port":"/dev/ttys000","baud":56000}'

# Iniciar carrera
curl -X POST http://localhost:3100/api/go

# Detener carrera
curl -X POST http://localhost:3100/api/stop
```
