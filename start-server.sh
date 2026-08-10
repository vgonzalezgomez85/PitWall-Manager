#!/bin/bash

# Script para arrancar PitWall Server
# Autor: Victor González
# Uso: ./start-server.sh

set -e

cd "$(dirname "$0")"

echo "🚀 Arrancando PitWall Server..."
echo ""

npm start
