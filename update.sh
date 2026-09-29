#!/usr/bin/env bash
# ===============================================================================
# Yimly Home Assistant - Deployment and Update Manager (Linux / macOS)
# ===============================================================================
set -e

echo "==============================================================================="
echo "               YIMLY HOME ASSISTANT - PRODUCTION MANAGER"
echo "==============================================================================="
echo ""

# 1. Verify working directory
if [ ! -f "docker-compose.yml" ]; then
    echo "[ERROR] docker-compose.yml not found in current directory."
    echo "Please run update.sh from the root of the repository."
    exit 1
fi

# 2. Check Git availability
echo "[1/7] Checking Git installation..."
if command -v git >/dev/null 2>&1; then
    echo "[OK] Git is available."
    if [ -d ".git" ]; then
        echo "Checking for remote updates..."
        if git fetch origin >/dev/null 2>&1; then
            echo "Pulling latest changes from GitHub..."
            git pull --ff-only || echo "[WARNING] Fast-forward pull failed. Continuing with local changes."
        fi
    fi
else
    echo "[WARNING] Git command not found. Continuing with local files..."
fi
echo ""

# 3. Check Docker availability
echo "[2/7] Checking Docker engine status..."
if ! command -v docker >/dev/null 2>&1; then
    echo "[ERROR] Docker is not installed or not in PATH."
    exit 1
fi

if ! docker info >/dev/null 2>&1; then
    echo "[ERROR] Docker daemon is not running."
    exit 1
fi
echo "[OK] Docker daemon is running."

# Determine docker compose command
if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE_CMD="docker-compose"
else
    echo "[ERROR] Neither 'docker compose' nor 'docker-compose' found."
    exit 1
fi
echo "[OK] Using '$DOCKER_COMPOSE_CMD'."
echo ""

# 4. Verify Docker network cloudflared_bridge
echo "[3/7] Verifying Docker network 'cloudflared_bridge'..."
if ! docker network inspect cloudflared_bridge >/dev/null 2>&1; then
    echo "Network 'cloudflared_bridge' does not exist yet. Creating network..."
    docker network create cloudflared_bridge >/dev/null 2>&1 || true
    echo "[OK] Created Docker network 'cloudflared_bridge'."
else
    echo "[OK] Existing Docker network 'cloudflared_bridge' detected and preserved."
fi
echo ""

# 5. Prepare environment and directories
echo "[4/7] Preparing environment configuration and data directories..."
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        echo "Creating initial .env from .env.example..."
        cp .env.example .env
    else
        echo "APP_ENV=production" > .env
        echo "PORT=3000" >> .env
    fi
    echo "[OK] Created .env configuration."
else
    echo "[OK] Existing .env configuration preserved."
fi

mkdir -p data/uploads/profile_pictures
echo "[OK] Persistent storage directories verified."
echo ""

# 6. Build and Deploy
echo "[5/7] Building production Docker container(s)..."
$DOCKER_COMPOSE_CMD build
echo "[OK] Images built."
echo ""

echo "[6/7] Starting Yimly Home Assistant services..."
$DOCKER_COMPOSE_CMD up -d --remove-orphans
echo "[OK] Containers started."
echo ""

# 7. Health check
echo "[7/7] Waiting for Yimly Home Assistant to become healthy and ready..."
HEALTH_TIMEOUT=40
ELAPSED=0

while [ $ELAPSED -lt $HEALTH_TIMEOUT ]; do
    if docker exec yimly_home curl -s -f http://localhost:3000/api/config >/dev/null 2>&1 || curl -s -f http://localhost:3000/api/config >/dev/null 2>&1; then
        echo ""
        echo "==============================================================================="
        echo "           SUCCESS! YIMLY HOME ASSISTANT IS LIVE AND RUNNING"
        echo "==============================================================================="
        echo ""
        echo " Access Points:"
        echo " ---------------------------------------------------------------------------"
        echo " * Local Web UI:               http://localhost:3000"
        echo " * Network Access:             http://<YOUR-SERVER-IP>:3000"
        echo " * Cloudflare Target Service:  http://yimly_home:3000 (Network: cloudflared_bridge)"
        echo " * Cloudflare Public Hostname: https://family360.robinhort.link"
        echo " * Companion App Server URL:   https://family360.robinhort.link (or LAN IP)"
        echo " ---------------------------------------------------------------------------"
        echo ""
        echo " * First-time setup: Open http://localhost:3000 in your browser to create"
        echo "   your administrator account."
        echo " * Persistence: All user accounts, circles, and device trackers are saved"
        echo "   in persistent storage."
        echo ""
        echo " * To update in the future: Simply run ./update.sh again!"
        echo "==============================================================================="
        exit 0
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
    echo "Waiting for backend server initialization... (${ELAPSED}s/${HEALTH_TIMEOUT}s)"
done

echo "[WARNING] Health check timed out. Checking container logs:"
$DOCKER_COMPOSE_CMD logs --tail=25
exit 1
