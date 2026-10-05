@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 请先安装 Node.js 24，再运行本文件。
  pause
  exit /b 1
)
if not exist "node_modules\vite" (
  call npm ci
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络并参考 README.md。
    pause
    exit /b 1
  )
)
echo 网页地址：http://127.0.0.1:5173
echo 关闭本窗口即可停止预览。
call npm run dev:preview
pause
