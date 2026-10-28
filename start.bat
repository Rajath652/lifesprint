@echo off
cd /d "%~dp0"
start "" http://localhost:4000
node server.js
