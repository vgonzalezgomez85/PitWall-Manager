# PitWall — gestión y cronometraje de carreras de slot
# Copyright (C) 2026 Víctor González Gómez <vgonzalezgomez@outlook.es>
#
# Monitor de resistencia — toma una muestra cada N segundos de:
#   - RSS/working-set y CPU del proceso de PitWall (node.exe/PitWall.exe)
#   - Tamaño de database/pitwall.db y su -wal
#   - Espacio libre en disco de la unidad donde vive PitWall
#   - Nº de conexiones de socket.io activas (via /diagnostico, si el server responde)
# y lo va anotando en un CSV, para poder ver la evolución a lo largo de varias
# horas sin tener que vigilar el Administrador de tareas todo el rato.
#
# Uso:
#   powershell -ExecutionPolicy Bypass -File scripts\monitor-endurance.ps1 `
#     -PitWallDir "C:\ruta\a\PitWall" -IntervalSeconds 60 -Base "http://localhost:3000"
#
# Para de forma segura con Ctrl+C — el CSV queda escrito hasta la última muestra.

param(
  [string]$PitWallDir = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path,
  [int]$IntervalSeconds = 60,
  [string]$Base = "http://localhost:3000",
  [string]$OutCsv = ""
)

if ($OutCsv -eq "") {
  $ts = Get-Date -Format "yyyy-MM-dd_HHmmss"
  $OutCsv = Join-Path $PitWallDir "logs\endurance-$ts.csv"
}
New-Item -ItemType Directory -Force -Path (Split-Path $OutCsv) | Out-Null

$dbPath  = Join-Path $PitWallDir "database\pitwall.db"
$walPath = "$dbPath-wal"

"timestamp,rss_mb,cpu_pct,db_mb,wal_mb,free_disk_gb,conn_web,conn_mobile,http_ok" | Out-File -FilePath $OutCsv -Encoding utf8

Write-Host "Monitor de resistencia arrancado. Muestra cada $IntervalSeconds s -> $OutCsv"
Write-Host "Ctrl+C para parar."

$drive = (Get-Item $PitWallDir).PSDrive.Name

while ($true) {
  $now = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

  # Proceso de PitWall: puede ser node.exe (dev) o PitWall.exe (instalado).
  # Sumamos todas las instancias por si Electron tiene varios procesos hijos.
  $procs = Get-Process -Name "node","PitWall" -ErrorAction SilentlyContinue
  $rssMb = 0
  $cpuPct = 0
  if ($procs) {
    $rssMb = [math]::Round((($procs | Measure-Object WorkingSet64 -Sum).Sum) / 1MB, 1)
    $cpuTimes = ($procs | Measure-Object CPU -Sum).Sum
    $cpuPct = [math]::Round($cpuTimes, 1)   # acumulado, no instantáneo — ver tendencia, no valor absoluto
  }

  $dbMb  = if (Test-Path $dbPath)  { [math]::Round((Get-Item $dbPath).Length / 1MB, 2) }  else { -1 }
  $walMb = if (Test-Path $walPath) { [math]::Round((Get-Item $walPath).Length / 1MB, 2) } else { 0 }

  $freeGb = [math]::Round((Get-PSDrive $drive).Free / 1GB, 2)

  $connWeb = -1; $connMobile = -1; $httpOk = 0
  try {
    $r = Invoke-WebRequest -Uri "$Base/diagnostico" -UseBasicParsing -TimeoutSec 5
    $httpOk = 1
    if ($r.Content -match 'id="conn-web">(\d+)') { $connWeb = $matches[1] }
    if ($r.Content -match 'id="conn-mobile">(\d+)') { $connMobile = $matches[1] }
  } catch {
    $httpOk = 0
  }

  $line = "$now,$rssMb,$cpuPct,$dbMb,$walMb,$freeGb,$connWeb,$connMobile,$httpOk"
  $line | Out-File -FilePath $OutCsv -Encoding utf8 -Append
  Write-Host $line

  Start-Sleep -Seconds $IntervalSeconds
}
