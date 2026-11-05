@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Installing required packages...
  npm install
)
echo Starting Rally Badminton Tournament Manager...
npm start
pause
