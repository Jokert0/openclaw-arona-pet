@echo off
setlocal
pushd "%~dp0" || exit /b 1
where npm.cmd >nul 2>&1 || goto :no_node
if exist "node_modules\@openclaw\gateway-client\package.json" if exist "node_modules\electron\package.json" goto :start
call npm.cmd ci || goto :failed
:start
call npm.cmd start || goto :failed
popd
exit /b 0
:no_node
echo Please install Node.js 24 with npm, then run this launcher again.
:failed
pause
popd
exit /b 1
