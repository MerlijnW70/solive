@echo off
set tries=0
:run
wsl.exe -d solive --cd "%~dp0.." -- %*
set code=%errorlevel%
if not "%code%"=="-1" exit /b %code%
set /a tries+=1
if %tries% geq 3 exit /b %code%
ping -n 6 127.0.0.1 >nul
goto run
