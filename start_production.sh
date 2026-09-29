#!/usr/bin/env bash
# Production launcher for Yimly Home Core (Python FastAPI)
echo "Starting Production Yimly Home Core (Python FastAPI)..."
exec uvicorn app.main:app --host 0.0.0.0 --port 3000
