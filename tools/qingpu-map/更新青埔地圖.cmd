@echo off
setlocal
chcp 65001 >nul

rem ASCII only on purpose: cmd files garble Chinese characters.
rem Rebuilds the Qingpu map from OpenStreetMap + the community database.
rem Basemap source: OpenStreetMap contributors (ODbL).
rem Community source: MOI actual-price registration via tools/qingpu-communities.

set "ROOT=%~dp0"
set "NODE=%ROOT%..\..\.tools\node-v24.18.0-win-arm64\node.exe"

if not exist "%NODE%" (
  echo [ERROR] Portable Node not found at:
  echo   %NODE%
  echo Check the .tools folder in the project root.
  pause
  exit /b 1
)

cd /d "%ROOT%"

echo [1/6] Fetching OSM data ...
rem Pass --force to re-download instead of using the cache.
"%NODE%" "build\fetch-osm.mjs" %*
if errorlevel 1 goto :failed

echo.
echo [2/6] Building basemap ...
"%NODE%" "build\build-basemap.mjs"
if errorlevel 1 goto :failed

echo.
echo [3/6] Locating communities ...
rem Needs tools\qingpu-communities\data\communities.json.
rem If that file is missing, run its own updater first.
"%NODE%" "build\geocode-pins.mjs"
if errorlevel 1 goto :failed

echo.
echo [4/6] Building road network graph ...
rem Used by the tour-route tool to estimate driving time between stops.
"%NODE%" "build\build-roadgraph.mjs"
if errorlevel 1 goto :failed

echo.
echo [5/6] Building offline single-file copy ...
rem Produces a single-file offline copy: double-click to open, no server needed.
echo.
echo [6/6] Regenerating LINE QR code ...
rem Encodes the LINE URL and self-verifies by decoding it back.
"%NODE%" "build\make-qr.mjs"
if errorlevel 1 goto :failed
"%NODE%" "build\build-standalone.mjs"
if errorlevel 1 goto :failed

echo.
echo Done. Refresh the browser tab to see the new map.
echo Manual pin corrections in data\pins-manual.json are kept.
pause
exit /b 0

:failed
echo.
echo [ERROR] Build failed. See the messages above.
pause
exit /b 1
