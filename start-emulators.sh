#!/bin/bash

# Script para arrancar emuladores DS-300
# Permite arrancar múltiples instancias con puertos virtuales emparejados
# Autor: Victor González
# Uso: ./start-emulators.sh

EMULATOR_DIR="$(cd "$(dirname "$0")/.." && pwd)/ds300-emulator"
PIDS=()

# Colores para output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Validar que existe el emulador
if [ ! -f "$EMULATOR_DIR/emulator.js" ]; then
  echo -e "${RED}❌ Error: No se encontró $EMULATOR_DIR/emulator.js${NC}"
  exit 1
fi

# Preguntar cuántos emuladores arrancar
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${BLUE}DS-300 Emulator Launcher${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo ""

read -p "¿Cuántos emuladores quieres arrancar? (1-4): " NUM_EMULATORS

# Validar entrada
if ! [[ "$NUM_EMULATORS" =~ ^[1-4]$ ]]; then
  echo -e "${RED}❌ Por favor ingresa un número entre 1 y 4${NC}"
  exit 1
fi

echo ""
echo -e "${YELLOW}Arrancando $NUM_EMULATORS emulador(es)...${NC}"
echo ""

# Arrays para almacenar información de emuladores
declare -a EMULATOR_INFO

# Función para arrancar un emulador
launch_emulator() {
  local idx=$1
  local http_port=$((3100 + idx - 1))

  echo -e "${YELLOW}[Emulador $idx]${NC} Creando puertos virtuales..."

  # Crear par de puertos virtuales con socat
  local socat_output=$(socat -d -d pty,raw,echo=0 pty,raw,echo=0 2>&1)
  local pty1=$(echo "$socat_output" | grep "PTY is" | head -1 | awk '{print $NF}')
  local pty2=$(echo "$socat_output" | grep "PTY is" | tail -1 | awk '{print $NF}')

  if [ -z "$pty1" ] || [ -z "$pty2" ]; then
    echo -e "${RED}❌ Error creando puertos virtuales${NC}"
    return 1
  fi

  EMULATOR_INFO+=("$idx|$http_port|$pty1|$pty2")

  echo -e "${GREEN}✓ Puertos creados:${NC}"
  echo -e "  Emulador: ${BLUE}$pty1${NC}"
  echo -e "  PitWall:  ${BLUE}$pty2${NC}"
  echo ""

  echo -e "${YELLOW}[Emulador $idx]${NC} Arrancando en puerto HTTP ${BLUE}$http_port${NC}..."

  # Arrancar emulador en background
  (
    cd "$EMULATOR_DIR"
    DS_HTTP_PORT=$http_port node emulator.js > /tmp/ds300-emulator-$idx.log 2>&1 &
    echo $! >> /tmp/emulator-pids.txt
  )

  sleep 1

  # Conectar el puerto virtual al emulador
  echo -e "${YELLOW}[Emulador $idx]${NC} Conectando puerto virtual..."
  curl -s -X POST "http://localhost:$http_port/api/connect" \
    -H "Content-Type: application/json" \
    -d "{\"port\":\"$pty1\",\"baud\":56000}" > /dev/null 2>&1

  if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Emulador $idx listo en http://localhost:$http_port${NC}"
  else
    echo -e "${YELLOW}⚠ Emulador $idx arrancado (conecta manualmente si es necesario)${NC}"
  fi
  echo ""
}

# Limpiar archivo de PIDs previos
rm -f /tmp/emulator-pids.txt

# Crear y arrancar emuladores
for ((i=1; i<=NUM_EMULATORS; i++)); do
  launch_emulator $i
done

# Arrancar el Director de carrera (panel maestro multi-DS) — escanea 3100..310N
DIRECTOR_PORT=3099
DIRECTOR_SCAN="3100-$((3100 + NUM_EMULATORS - 1))"
echo -e "${YELLOW}[Director]${NC} Arrancando panel maestro en puerto HTTP ${BLUE}$DIRECTOR_PORT${NC}..."
(
  cd "$EMULATOR_DIR"
  DS_DIRECTOR_PORT=$DIRECTOR_PORT DS_DIRECTOR_SCAN=$DIRECTOR_SCAN node director.js > /tmp/ds300-director.log 2>&1 &
  echo $! >> /tmp/emulator-pids.txt
)
sleep 1
echo -e "${GREEN}✓ Director listo en http://localhost:$DIRECTOR_PORT${NC} (controla los $NUM_EMULATORS circuitos a la vez)"
echo ""

echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo -e "${GREEN}✓ Todos los emuladores arrancados${NC}"
echo -e "${BLUE}═══════════════════════════════════════${NC}"
echo ""
echo -e "🏁 ${GREEN}DIRECTOR DE CARRERA (GO/pausa/stop a todos a la vez):${NC} ${BLUE}http://localhost:$DIRECTOR_PORT${NC}"
echo ""
echo "Emuladores disponibles:"
for info in "${EMULATOR_INFO[@]}"; do
  IFS='|' read -r idx port pty1 pty2 <<< "$info"
  echo -e "  Emulador $idx: ${BLUE}http://localhost:$port${NC}"
  echo -e "    Puertos: $pty1 ↔ $pty2"
done
echo ""

echo -e "${YELLOW}Próximos pasos:${NC}"
echo "1. Abre los emuladores en el navegador"
echo "2. En otra terminal, arranca el servidor PitWall:"
echo -e "   ${BLUE}./start-server.sh${NC}"
echo ""
echo "3. Configura los puertos en PitWall → Settings → Hardware:"
for info in "${EMULATOR_INFO[@]}"; do
  IFS='|' read -r idx port pty1 pty2 <<< "$info"
  echo -e "   Circuito $idx: ${BLUE}$pty2${NC}"
done
echo ""

echo -e "${YELLOW}Para detener todos los emuladores:${NC}"
echo -e "  ${BLUE}killall node${NC}"
echo ""

# Mantener el script activo y capturar Ctrl+C
echo -e "${YELLOW}Presiona Ctrl+C para detener los emuladores${NC}"

trap 'cleanup' INT TERM

cleanup() {
  echo ""
  echo -e "${RED}Deteniendo emuladores...${NC}"
  if [ -f /tmp/emulator-pids.txt ]; then
    while read pid; do
      kill $pid 2>/dev/null || true
    done < /tmp/emulator-pids.txt
    rm /tmp/emulator-pids.txt
  fi
  killall socat 2>/dev/null || true
  echo -e "${GREEN}✓ Emuladores detenidos${NC}"
  exit 0
}

# Mantener el script activo
sleep infinity 2>/dev/null || while true; do sleep 1; done
