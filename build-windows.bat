@echo off
chcp 65001 >nul
title PitWall - Generar instalador Windows
cd /d "%~dp0"

echo ==========================================================
echo   PitWall - Generador del instalador para Windows
echo ==========================================================
echo.

REM --- Comprobar que Node/npm estan instalados ---
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] No se encuentra Node.js.
  echo Instalalo desde https://nodejs.org ^(version LTS^) y marca
  echo la casilla "Tools for Native Modules" durante la instalacion.
  echo.
  pause
  exit /b 1
)

for /f "delims=" %%v in ('node -v') do echo Node detectado: %%v
echo.

REM --- Pedir la version del instalador ---
for /f "delims=" %%v in ('node -p "require('./package.json').version"') do set "CURVER=%%v"
echo Version actual: %CURVER%
set /p "NEWVER=Introduce la version a generar (Enter para mantener %CURVER%): "
if not "%NEWVER%"=="" (
  echo Estableciendo version %NEWVER% ...
  call npm version %NEWVER% --no-git-tag-version --allow-same-version
  if errorlevel 1 (
    echo.
    echo [ERROR] Version no valida. Usa el formato X.Y.Z ^(ej. 1.0.1^).
    echo.
    pause
    exit /b 1
  )
) else (
  set "NEWVER=%CURVER%"
)
echo Se generara el instalador version %NEWVER%.
echo.

echo [1/2] Instalando dependencias (puede tardar varios minutos la 1a vez)...
echo.
call npm install
if errorlevel 1 (
  echo.
  echo [ERROR] Fallo en "npm install".
  echo Si el error menciona node-gyp / Visual Studio / Python,
  echo faltan las herramientas de compilacion de modulos nativos.
  echo.
  pause
  exit /b 1
)

echo.
echo [2/2] Generando el instalador de Windows...
echo.
call npm run dist:win
if errorlevel 1 (
  echo.
  echo [ERROR] Fallo en "npm run dist:win".
  echo.
  pause
  exit /b 1
)

echo.
echo ==========================================================
echo   LISTO. El instalador esta en la carpeta: dist-app
echo     - PitWall Setup %NEWVER%.exe  ^(instalador con asistente^)
echo     - PitWall %NEWVER%.exe        ^(version portable^)
echo ==========================================================
echo.

REM --- Abrir la carpeta del resultado ---
if exist "dist-app" start "" explorer "dist-app"

pause
