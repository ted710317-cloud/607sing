@echo off
chcp 65001 >nul
title 班級雲端 YouTube 點歌系統 - 啟動器

echo ===================================================
echo 🎵 班級雲端 YouTube 點歌系統 (Classroom Jukebox)
echo ===================================================
echo 正在檢查執行環境...

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [錯誤] 系統未安裝 Node.js！請先至 https://nodejs.org 安裝後再執行。
    pause
    exit /b
)

if not exist "node_modules\" (
    echo [初始化] 首次執行，正在自動安裝所需依賴套件...
    call npm install
)

echo [啟動中] 正在開啟點歌伺服器...
start "" http://localhost:3000/player.html
call npm start

pause
