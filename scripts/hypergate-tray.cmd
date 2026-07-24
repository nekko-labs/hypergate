@echo off
rem Launch the Hypergate tray icon hidden (no console window).
start "" /b powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0hypergate-tray.ps1"
