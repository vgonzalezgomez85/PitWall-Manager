#!/bin/bash

# Script para arrancar SloTime Server
# Autor: Victor González
# Uso: ./start-server.sh

set -e

cd "$(dirname "$0")"

echo "🚀 Arrancando SloTime Server..."
echo ""

npm start
