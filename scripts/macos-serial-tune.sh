#!/usr/bin/env bash
# PitWall — macOS USB-Serial tuning
# Run once to reduce byte loss on USB-Serial adapters (FTDI / PL2303 / CH340).
# Requires sudo.

set -e

echo "=== PitWall macOS Serial Tuning ==="
echo

# 1) Disable USB selective suspend (avoids micro-disconnects)
echo "[1/3] Disabling USB sleep (selective suspend)..."
sudo pmset -a usbsleep 0 || true

# 2) Disable system sleep while plugged in
echo "[2/3] Keeping the machine awake while running (charger)..."
sudo pmset -c sleep 0 disksleep 0 displaysleep 30 || true

# 3) FTDI latency timer → 1ms (vs default 16ms). No-op if no FTDI present.
echo "[3/3] FTDI latency timer (if applicable)..."
if [ -d /System/Library/Extensions/AppleUSBFTDI.kext ] || ls /Library/Extensions/FTDIUSBSerialDriver.kext 2>/dev/null; then
  sudo defaults write /Library/Preferences/com.FTDI.driver.FTDIUSBSerialDriver LatencyTimer -int 1 || true
  echo "  → Set FTDI LatencyTimer=1ms (unplug+replug the adapter to apply)"
else
  echo "  → No FTDI driver found, skipping."
fi

echo
echo "=== Done. Recommended next steps ==="
echo " 1. Unplug and replug the USB-Serial adapter."
echo " 2. Close apps that monopolise USB (Bluetooth keyboard sync, iCloud Drive sync, etc.)."
echo " 3. Use a USB 2.0 port directly on the Mac, not through a hub or dock."
echo " 4. Keep cable runs short (<1m) and well-shielded."
