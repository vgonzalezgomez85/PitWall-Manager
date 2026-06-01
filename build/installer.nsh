; ──────────────────────────────────────────────────────────────────────────
; Voltrace Manager — hooks personalizados del instalador NSIS
;
; 1. customInstall: ofrece añadir exclusiones de Windows Defender para los
;    directorios donde la app escribe constantemente (carpeta de instalación
;    + datos del usuario en AppData). Defender en tiempo real escanea cada
;    escritura al .db / WAL / logs de debug, lo cual ralentiza mucho las
;    sesiones de cronometraje con ráfagas de vueltas. Excluir esas rutas
;    elimina el cuello sin reducir la seguridad real.
;
;    Como el installer es per-user (sin admin), las exclusiones se aplican
;    invocando PowerShell elevado vía UAC (verbo "runas"). Si el usuario
;    rechaza el UAC, no pasa nada: el instalador continúa.
;
; 2. customUnInstall: retira las exclusiones de Defender y pregunta si
;    quiere borrar también la BD/datos de usuario.
; ──────────────────────────────────────────────────────────────────────────

!macro customInstall
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "${PRODUCT_NAME}$\r$\n$\r$\n¿Añadir Voltrace Manager a las exclusiones de Windows Defender?$\r$\n$\r$\nDefender escanea en tiempo real cada escritura del .db y los logs. Excluyendo las carpetas de la app se eliminan ralentizaciones notables durante las carreras (ráfagas de vueltas, mangas largas, lectura de QR).$\r$\n$\r$\nSe pedirá permiso de administrador (UAC) sólo para este paso. Si rechazas, la instalación continúa igual y podrás añadirlas manualmente más tarde." \
    /SD IDNO IDNO skip_defender_add

    DetailPrint "Generando script de exclusión de Defender..."

    ; Escribe un .ps1 temporal con los Add-MpPreference. Sustituimos las
    ; rutas a nivel NSIS (no en PowerShell) para que la ruta del usuario
    ; instalador se preserve aunque el script corra elevado bajo otra cuenta.
    StrCpy $0 "$PLUGINSDIR\voltrace-defender-add.ps1"
    FileOpen $1 "$0" w
    FileWrite $1 "# Anade exclusiones de Defender para Voltrace Manager$\r$\n"
    FileWrite $1 "try {$\r$\n"
    FileWrite $1 '  Add-MpPreference -ExclusionPath "$APPDATA\${PRODUCT_NAME}" -ErrorAction SilentlyContinue$\r$\n'
    FileWrite $1 '  Add-MpPreference -ExclusionPath "$INSTDIR" -ErrorAction SilentlyContinue$\r$\n'
    FileWrite $1 "} catch {}$\r$\n"
    FileClose $1

    DetailPrint "Solicitando elevacion (UAC) para aplicar exclusiones..."
    ExecShellWait "runas" "powershell.exe" '-ExecutionPolicy Bypass -WindowStyle Hidden -File "$0"' SW_HIDE
    DetailPrint "Exclusiones de Defender configuradas."

  skip_defender_add:
!macroend

!macro customUnInstall
  ; ── 1. Retirar exclusiones de Defender en silencio ───────────────────
  StrCpy $0 "$PLUGINSDIR\voltrace-defender-remove.ps1"
  FileOpen $1 "$0" w
  FileWrite $1 "try {$\r$\n"
  FileWrite $1 '  Remove-MpPreference -ExclusionPath "$APPDATA\${PRODUCT_NAME}" -ErrorAction SilentlyContinue$\r$\n'
  FileWrite $1 '  Remove-MpPreference -ExclusionPath "$INSTDIR" -ErrorAction SilentlyContinue$\r$\n'
  FileWrite $1 "} catch {}$\r$\n"
  FileClose $1
  ExecShellWait "runas" "powershell.exe" '-ExecutionPolicy Bypass -WindowStyle Hidden -File "$0"' SW_HIDE

  ; ── 2. Borrar (opcional) datos de usuario ────────────────────────────
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "${PRODUCT_NAME}$\r$\n$\r$\n¿Quieres eliminar también los datos guardados (base de datos, carreras, equipos y configuración)?$\r$\n$\r$\nSelecciona NO si vas a reinstalar la app o quieres conservar tu historial.$\r$\n$\r$\nSelecciona SÍ para borrar todo (no se podrá recuperar)." \
    /SD IDNO IDNO skip_userdata

    ; Mata cualquier proceso aún vivo de la app. SQLite en WAL deja .db,
    ; .db-wal y .db-shm bloqueados mientras node siga corriendo; sin esto
    ; RMDir falla en silencio y la carpeta sobrevive a pesar de que el
    ; usuario haya dicho que SÍ.
    nsExec::ExecToLog 'taskkill /F /T /IM "${PRODUCT_NAME}.exe"'
    nsExec::ExecToLog 'taskkill /F /T /IM "Voltrace Manager.exe"'
    nsExec::ExecToLog 'taskkill /F /T /IM "node.exe"'
    Sleep 600

    ; Borra las dos rutas posibles: la usada por electron (productName) y
    ; la legacy basada en el name del package.json.
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
    RMDir /r "$APPDATA\slot-timer-pro"

    ; Verifica el resultado y avisa si quedaron ficheros bloqueados.
    IfFileExists "$APPDATA\${PRODUCT_NAME}\*.*" 0 done_clean
      MessageBox MB_OK|MB_ICONEXCLAMATION \
        "No se han podido eliminar todos los datos.$\r$\n$\r$\nCierra Voltrace Manager si sigue abierto y borra manualmente:$\r$\n$APPDATA\${PRODUCT_NAME}"
      Goto skip_userdata
    done_clean:
      DetailPrint "Datos de usuario eliminados: $APPDATA\${PRODUCT_NAME}"

  skip_userdata:
!macroend
