#!/bin/bash
# Start ATEM MCP with persistent JWT security

cd "$(dirname "$0")"

# Load environment from .env
export JWT_SECRET="ae4019b402588226de76522157e649e290f0e90153eaa17abfa79b2e3757d0b8be8a382018847977eecdc725f0d29a089917b4debb3a7852bd6e332db7a737f8"
export TRANSPORT=http
export PORT=3017
export BASE_URL=https://atem-mcp.cochran.cloud

echo "🔐 Starting ATEM MCP with secure OAuth..."
echo "   JWT Secret: ${JWT_SECRET:0:16}..."
echo "   Public URL: $BASE_URL"

npm start
