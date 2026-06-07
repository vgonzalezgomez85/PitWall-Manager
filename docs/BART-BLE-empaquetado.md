# BART por BLE en la app empaquetada (Electron)

SlotTime arranca el servidor (`src/app.js`) como **proceso hijo `fork`** desde
`electron/main.js`. En la app empaquetada, `fork` lanza el binario de Electron en
modo Node (`ELECTRON_RUN_AS_NODE`), así que los módulos nativos del servidor
(incluido **noble**, el BLE) corren con el **runtime de Electron**.

## Qué se ha configurado

- **`asarUnpack`** incluye `**/node_modules/@abandonware/**/*` → los `.node` de
  noble (y `bluetooth-hci-socket` en Linux) quedan fuera del asar para poder
  cargarse. (`noble` usa N-API + prebuilds, ABI-estable, así que normalmente no
  necesita recompilarse; `npmRebuild: true` lo cubre igualmente.)
- **macOS — permiso de Bluetooth** (`mac.extendInfo`): se añade
  `NSBluetoothAlwaysUsageDescription` al Info.plist para que macOS muestre el
  diálogo de permiso de Bluetooth al conectar por BLE.
- **`build/entitlements.mac.plist`**: entitlements listos para cuando firmes/
  notarices (Bluetooth + hardened runtime + cargar `.node`). **No están
  activados** porque ahora `mac.identity` es `null` (build sin firmar).

## Cómo generar y probar (macOS)

```bash
# build sin firmar (rápido, solo la .app):
npx electron-builder --dir --mac --arm64
# → dist-app/mac-arm64/Voltrace Manager.app

# o el instalable:
npm run dist:mac
```

Al **primer arranque** y al conectar por BLE, macOS pedirá permiso de Bluetooth
(o concédelo en *Ajustes del sistema → Privacidad y seguridad → Bluetooth*).
Luego: Ajustes → fuente **BART** → Transporte **BLE** → Guardar, con el
emulador/Master anunciando.

> App **sin firmar**: Gatekeeper la bloqueará al abrirla (botón derecho → Abrir,
> o `xattr -dr com.apple.quarantine "Voltrace Manager.app"`). El permiso de
> Bluetooth en apps sin firmar es algo inestable; para distribución conviene
> firmar+notarizar (ver abajo).

## Para distribuir (firmado + notarizado)

1. Pon tu identidad en `build.mac.identity` (o variable `CSC_*`).
2. Activa hardened runtime + entitlements en `package.json` → `build.mac`:
   ```json
   "hardenedRuntime": true,
   "entitlements": "build/entitlements.mac.plist",
   "entitlementsInherit": "build/entitlements.mac.plist"
   ```
   `entitlementsInherit` es **clave**: el servidor corre como proceso hijo y
   hereda el entitlement de Bluetooth de ahí.
3. Notariza (electron-builder lo hace con `notarize: true` + credenciales Apple).

## Windows / Linux

- **Windows**: noble usa WinRT; el BLE suele requerir Windows 10+ y a veces un
  adaptador compatible. Más frágil que macOS — validar aparte.
- **Linux**: noble usa `@abandonware/bluetooth-hci-socket` (BlueZ); el binario
  necesita `cap_net_raw` (`setcap`) o ejecutarse con privilegios.

## Validación pendiente (requiere build real + dispositivo)

- [ ] Generar la .app y confirmar que `@abandonware/noble` aparece en
      `…/Resources/app.asar.unpacked/node_modules/@abandonware/noble`.
- [ ] Abrir la app, modo BART/BLE, y conectar con el Master real/emulador.
- [ ] Confirmar el diálogo de permiso de Bluetooth de macOS.
