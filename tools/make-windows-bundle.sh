#!/bin/bash
# Crea un bundle offline para Windows con Node.js portable + caché npm.
# Ejecutar en Mac (necesita internet). El PC Windows destino no necesita internet.

set -e

NODE_VERSION="20.19.2"
NODE_ZIP="node-v${NODE_VERSION}-win-x64.zip"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ZIP}"

MOBILE_SRC="/Users/victor/slotime-mobile"
OUT_DIR="/Users/victor/SloTime/dist/slotime-mobile-windows"
CACHE_DIR="${OUT_DIR}/npm-cache"

echo ""
echo "┌─────────────────────────────────────────────┐"
echo "│  SloTime Mobile — Windows Bundle Creator    │"
echo "└─────────────────────────────────────────────┘"
echo ""

# ── Limpieza ──────────────────────────────────────────────────────────────────
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR" "$CACHE_DIR"

# ── 1. Node.js portable para Windows ─────────────────────────────────────────
echo "▸ Descargando Node.js ${NODE_VERSION} para Windows..."
NODE_CACHE="/tmp/${NODE_ZIP}"
if [ ! -f "$NODE_CACHE" ]; then
  curl -L --progress-bar "$NODE_URL" -o "$NODE_CACHE"
else
  echo "  (usando descarga en caché)"
fi
cp "$NODE_CACHE" "$OUT_DIR/$NODE_ZIP"
echo "  ✓ Node.js listo"

# ── 2. Copiar código fuente (sin node_modules) ────────────────────────────────
echo "▸ Copiando proyecto slotime-mobile..."
rsync -a \
  --exclude='node_modules' \
  --exclude='.expo' \
  --exclude='dist' \
  --exclude='*.log' \
  "$MOBILE_SRC/" "$OUT_DIR/slotime-mobile/"
echo "  ✓ Código copiado"

# ── 3. Rellenar caché npm (tarballs independientes de plataforma) ──────────────
echo "▸ Descargando paquetes al caché npm (puede tardar varios minutos)..."
cd "$MOBILE_SRC"
npm install --cache "$CACHE_DIR" --prefer-offline 2>/dev/null || \
npm install --cache "$CACHE_DIR"
echo "  ✓ Caché npm listo"

# ── 4. Scripts para Windows ───────────────────────────────────────────────────
echo "▸ Creando scripts Windows..."

cat > "$OUT_DIR/1-setup.bat" << 'EOF'
@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0"

echo.
echo  SloTime Mobile - Setup
echo  ========================
echo.

:: Extraer Node.js portable si no existe
if not exist "%ROOT%node\" (
  echo  Extrayendo Node.js portable...
  for %%f in ("%ROOT%node-v*-win-x64.zip") do (
    powershell -NoProfile -Command "Expand-Archive -Path '%%f' -DestinationPath '%ROOT%node-tmp' -Force"
  )
  for /d %%d in ("%ROOT%node-tmp\node-v*") do (
    move "%%d" "%ROOT%node" >nul
  )
  rmdir /q "%ROOT%node-tmp" 2>nul
  echo  Node.js extraido correctamente.
) else (
  echo  Node.js ya esta instalado.
)

set "PATH=%ROOT%node;%ROOT%node\node_modules\npm\bin;%PATH%"

:: Instalar dependencias desde cache offline
echo.
echo  Instalando dependencias (sin internet)...
cd /d "%ROOT%slotime-mobile"
"%ROOT%node\npm.cmd" install --cache "%ROOT%npm-cache" --prefer-offline --no-audit --no-fund --loglevel=error

echo.
echo  ====================================
echo   Instalacion completada.
echo   Ejecuta  2-start.bat  para iniciar.
echo  ====================================
echo.
pause
EOF

cat > "$OUT_DIR/2-start.bat" << 'EOF'
@echo off
setlocal
set "ROOT=%~dp0"
set "PATH=%ROOT%node;%ROOT%node\node_modules\npm\bin;%PATH%"

echo.
echo  SloTime Mobile - Servidor Expo
echo  ================================
echo  Escanea el QR con Expo Go en el iPhone.
echo  El iPhone y este PC deben estar en la misma WiFi.
echo  Pulsa Ctrl+C para detener.
echo.

cd /d "%ROOT%slotime-mobile"
"%ROOT%node\node.exe" node_modules\.bin\expo start
EOF

echo "  ✓ Scripts creados"

# ── 5. Instrucciones ──────────────────────────────────────────────────────────
cat > "$OUT_DIR/LEEME.txt" << 'EOF'
SloTime Mobile — Servidor Expo para Windows
===========================================

PRIMERA VEZ:
  1. Extrae esta carpeta completa (ej: C:\SloTime-Mobile\)
  2. Ejecuta  1-setup.bat  (instala Node.js y dependencias, sin internet)

CADA VEZ QUE QUIERAS USARLO:
  1. Ejecuta  2-start.bat
  2. Escanea el codigo QR con Expo Go en el iPhone
  3. El iPhone y el PC deben estar en la misma red WiFi
  4. La app descubrira SloTime automaticamente en la red

REQUISITOS:
  - Windows 10/11 x64
  - iPhone con Expo Go instalado (App Store, gratis)
  - Misma red WiFi que el PC con SloTime
EOF

# ── 6. Comprimir ──────────────────────────────────────────────────────────────
echo "▸ Comprimiendo..."
cd /Users/victor/SloTime/dist
zip -r -q "slotime-mobile-windows.zip" "slotime-mobile-windows/"
ZIP_SIZE=$(du -sh "slotime-mobile-windows.zip" | cut -f1)
echo "  ✓ ZIP creado: dist/slotime-mobile-windows.zip (${ZIP_SIZE})"

echo ""
echo "┌─────────────────────────────────────────────────────────────────┐"
echo "│  Listo. Copia este fichero al PC Windows:                       │"
echo "│  /Users/victor/SloTime/dist/slotime-mobile-windows.zip         │"
echo "│                                                                 │"
echo "│  En Windows:  extraer → 1-setup.bat → 2-start.bat              │"
echo "└─────────────────────────────────────────────────────────────────┘"
echo ""
