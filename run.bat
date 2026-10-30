@echo off
setlocal
cd /d "%~dp0"

set "hang_launcher=python"
python -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if not errorlevel 1 goto launch

set "hang_launcher=py -3"
py -3 -c "import sys; sys.exit(sys.version_info < (3, 10))" >nul 2>&1
if not errorlevel 1 goto launch

echo Python 3.10 or newer was not found.
echo Install Python and enable "Add Python to PATH", then try again.
echo You can also open index.html to use browser-only storage.
pause
exit /b 1

:launch
%hang_launcher% "%~dp0server.py" %*
set "hang_exit=%errorlevel%"
if not "%hang_exit%"=="0" pause
exit /b %hang_exit%
