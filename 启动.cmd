@echo off
chcp 65001 >nul
title llama.cpp 管理器
cd /d "%~dp0"

if not exist "node_modules\electron\dist\electron.exe" (
  echo [!] 未找到 Electron，正在安装依赖...
  call npm install --no-audit --no-fund
)

start "" "node_modules\electron\dist\electron.exe" .
