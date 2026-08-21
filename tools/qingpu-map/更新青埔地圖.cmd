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

echo [1/7] Fetching OSM data ...
rem Pass --force to re-download instead of using the cache.
"%NODE%" "build\fetch-osm.mjs" %*
if errorlevel 1 goto :failed

echo.
echo [2/7] Building basemap ...
"%NODE%" "build\build-basemap.mjs"
if errorlevel 1 goto :failed

echo.
echo [3/7] Locating communities ...
rem Needs tools\qingpu-communities\data\communities.json.
rem If that file is missing, run its own updater first.
"%NODE%" "build\geocode-pins.mjs"
if errorlevel 1 goto :failed

echo.
echo [4/7] Refining pin positions ...
rem Cross-checks OSM address points against 591 and Sinyi coordinates.
rem Sinyi coordinates come from data/sinyi-xy.json. That file is NOT rebuilt here:
rem it hits sinyi.com.tw ~300 times at 2.4s each (about 12 minutes). Refresh it
rem only when new communities appear:  node build/fetch-sinyi-xy.mjs
rem Missing that file is fine - refine-pins just has one fewer source to cross-check.
rem Only moves a pin when two independent sources agree. Writes data/pins-review.json
rem listing the ones that still need a human eye (open the map, tick Calibration mode).
"%NODE%" "build\refine-pins.mjs"
if errorlevel 1 goto :failed

echo.
echo [5/7] Building road network graph ...
rem Used by the tour-route tool to estimate driving time between stops.
"%NODE%" "build\build-roadgraph.mjs"
if errorlevel 1 goto :failed

echo.
echo [6/7] Building offline single-file copy ...
rem Produces a single-file offline copy: double-click to open, no server needed.
echo.
echo [7/7] Regenerating LINE QR code ...
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
