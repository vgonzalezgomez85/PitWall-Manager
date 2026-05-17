; ──────────────────────────────────────────────────────────────────────────
; Voltrace Manager — custom NSIS uninstaller hook
;
; Al desinstalar, pregunta al usuario si quiere eliminar también la base de
; datos y la configuración (carrera, equipos, circuitos, etc.). Por defecto
; (botón "No") los datos se mantienen — útil cuando el usuario reinstala o
; actualiza la app.
; ──────────────────────────────────────────────────────────────────────────

!macro customUnInstall
  MessageBox MB_YESNO|MB_ICONQUESTION "${PRODUCT_NAME}$\r$\n$\r$\n¿Quieres eliminar también los datos guardados (base de datos, carreras, equipos y configuración)?$\r$\n$\r$\nSelecciona NO si vas a reinstalar la app o quieres conservar tu historial.$\r$\n$\r$\nSelecciona SÍ para borrar todo (no se podrá recuperar)." /SD IDNO IDNO skip_userdata
    ; El usuario eligió SÍ — borrar carpeta userData de Roaming
    RMDir /r "$APPDATA\${PRODUCT_NAME}"
    DetailPrint "Datos de usuario eliminados: $APPDATA\${PRODUCT_NAME}"
  skip_userdata:
!macroend
