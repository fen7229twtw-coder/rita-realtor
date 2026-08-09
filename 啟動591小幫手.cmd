@echo off
REM ============================================================
REM  591 helper for the buyer-match tool.
REM  Keep this window open while you use the 591 search.
REM  ASCII only on purpose: cmd files garble Chinese characters.
REM ============================================================
title 591 Helper - buyer-match

set "ROOT=%~dp0"
set "NODE=%ROOT%.tools\node-v24.18.0-win-arm64\node.exe"

if not exist "%NODE%" (
  echo.
  echo   [ERROR] Node.js not found at:
  echo   %NODE%
  echo.
  echo   The portable Node folder is missing or was renamed.
  echo.
  pause
  exit /b 1
)

set PORT=8899

echo.
echo   591 helper is starting...
echo.
echo   Tool:  https://fen7229twtw-coder.github.io/rita-realtor/tools/buyer-match/
echo   Local: http://localhost:%PORT%/tools/buyer-match/
echo.
echo   Leave this window OPEN while you search 591.
echo   Close it when you are done.
echo.

"%NODE%" "%ROOT%.claude\serve-dev.mjs"

echo.
echo   Helper stopped.
pause
