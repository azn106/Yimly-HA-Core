@echo off

:: 1. Verify working directory
if not exist "docker-compose.yml" (
    echo [ERROR] docker-compose.yml not found in current directory.
    echo Please make sure you run update.bat from the root of the repository.
    echo.
    pause
    exit /b 1
)

:: 2. Update code from GitHub
echo [1/7] Updating code from GitHub...

where git >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Git is not installed or not available in PATH.
    pause
    exit /b 1
)

if not exist ".git" (
    echo [ERROR] This directory is not a Git repository.
    pause
    exit /b 1
)

echo Checking GitHub remote...
git remote -v
echo.

echo Fetching latest GitHub changes...
git fetch origin
if errorlevel 1 (
    echo.
    echo [ERROR] Could not fetch from GitHub.
    echo Deployment stopped. Existing production container was NOT changed.
    echo.
    pause
    exit /b 1
)

echo.
echo Synchronising local code with GitHub main...

:: Make sure the deployment uses exactly the GitHub main branch.
:: WARNING: this discards uncommitted LOCAL changes in the deployment folder.
:: It does NOT touch Docker persistent data.
git checkout main
if errorlevel 1 (
    echo [ERROR] Could not switch to main branch.
    pause
    exit /b 1
)

git reset --hard origin/main
if errorlevel 1 (
    echo.
    echo [ERROR] Could not synchronise with origin/main.
    echo Deployment stopped. Existing production container was NOT changed.
    echo.
    pause
    exit /b 1
)

git clean -fd
if errorlevel 1 (
    echo.
    echo [ERROR] Could not clean old repository files.
    echo Deployment stopped.
    echo.
    pause
    exit /b 1
)

echo [OK] Local deployment code now exactly matches GitHub main.
echo.

:: 3. Check Docker and Docker Compose availability
echo [2/7] Checking Docker engine status...

where docker >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker is not installed or not in PATH.
    pause
    exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Docker Desktop is not currently running.
    pause
    exit /b 1
)

echo [OK] Docker daemon is running.

set "DOCKER_COMPOSE_CMD=docker compose"

docker compose version >nul 2>&1
if errorlevel 1 (
    docker-compose version >nul 2>&1
    if not errorlevel 1 (
        set "DOCKER_COMPOSE_CMD=docker-compose"
    ) else (
        echo [ERROR] Docker Compose not found.
        pause
        exit /b 1
    )
)

echo [OK] Using '%DOCKER_COMPOSE_CMD%'.
echo.

:: 4. Cloudflare Bridge Network
echo [3/7] Verifying Docker network 'cloudflared_bridge'...

docker network inspect cloudflared_bridge >nul 2>&1

if errorlevel 1 (
    docker network create cloudflared_bridge >nul 2>&1
    if errorlevel 1 (
        echo [ERROR] Failed to create Docker network.
        pause
        exit /b 1
    )
    echo [OK] Created shared Docker network.
) else (
    echo [OK] Existing Docker network detected and preserved.
)

echo.

:: 5. Environment and persistent storage
echo [4/7] Preparing environment and persistent storage...

if not exist ".env" (
    if exist ".env.example" (
        copy .env.example .env >nul
    ) else (
        echo APP_ENV=production > .env
        echo PORT=3000 >> .env
    )
    echo [OK] Created .env.
) else (
    echo [OK] Existing .env preserved.
)

if not exist "data" mkdir data
if not exist "data\uploads" mkdir data\uploads
if not exist "data\uploads\profile_pictures" mkdir data\uploads\profile_pictures

echo [OK] Persistent storage verified.
echo.

:: 6. Build and force deployment
echo [5/7] Building production image from GitHub code...
echo.

%DOCKER_COMPOSE_CMD% build
if errorlevel 1 (
    echo.
    echo [ERROR] Docker build failed.
    echo Existing production container was NOT changed.
    echo.
    pause
    exit /b 1
)

echo.
echo [OK] Production image built successfully.
echo.

echo [6/7] Deploying newly built image...
echo.

%DOCKER_COMPOSE_CMD% down
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to stop existing services.
    pause
    exit /b 1
)

%DOCKER_COMPOSE_CMD% up -d --force-recreate --remove-orphans
if errorlevel 1 (
    echo.
    echo [ERROR] Failed to start production services.
    pause
    exit /b 1
)

echo.
echo [OK] New GitHub code is now deployed.
echo.

:: 7. Health check
echo [7/7] Waiting for Yimly Home Assistant to become ready...

set "HEALTH_TIMEOUT=40"
set "ELAPSED=0"

:HEALTH_LOOP

if %ELAPSED% GEQ %HEALTH_TIMEOUT% goto HEALTH_TIMEOUT

docker exec yimly-assistant curl -s -f http://localhost:3000/api/setup/status >nul 2>&1

if not errorlevel 1 goto HEALTHY

timeout /t 2 /nobreak >nul

set /a ELAPSED=%ELAPSED%+2

echo Waiting for backend... (%ELAPSED%s/%HEALTH_TIMEOUT%s)

goto HEALTH_LOOP

:HEALTH_TIMEOUT

echo.
echo [WARNING] Health check timed out after %HEALTH_TIMEOUT% seconds.
echo.
%DOCKER_COMPOSE_CMD% ps
echo.
%DOCKER_COMPOSE_CMD% logs --tail=25
echo.
pause
exit /b 1

:HEALTHY

echo.
echo ===============================================================================
echo       SUCCESS! GITHUB CODE DEPLOYED - YIMLY HOME ASSISTANT IS LIVE
echo ===============================================================================
echo.
echo  GitHub Repository:
echo  https://github.com/azn106/Yimly-Assistant
echo.
echo  Public URL:
echo  https://yimha.robinhort.link
echo.
echo  Local URL:
echo  http://localhost:3000
echo.
echo  Persistent data:
echo  ./data
echo.
echo  The deployment now uses GitHub main as the source of truth.
echo ===============================================================================
echo.

pause
