#!/bin/bash
# ATEM MCP Production Start Script
# This ensures the server starts with the correct configuration for Claude.ai

cd "$(dirname "$0")"

# Kill any existing processes on port 3017
echo "Stopping any existing ATEM MCP processes..."
pkill -f "node.*3017" 2>/dev/null || true
lsof -ti:3017 | xargs kill -9 2>/dev/null || true

# Start with production configuration
echo "Starting ATEM MCP Server on port 3017..."
TRANSPORT=http \
PORT=3017 \
BASE_URL=https://atem-mcp.cochran.cloud \
ATEM_HOST=192.168.6.136 \
npm start