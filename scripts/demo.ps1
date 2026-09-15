# Ovolve MVP — Demo 脚本 (Windows)
# 一键起服务 + 预置一个会触发 5-Agent fan-out 的示例任务
$ErrorActionPreference = "Stop"

$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $PSScriptRoot

Write-Host "=== Ovolve MVP Demo ===" -ForegroundColor Cyan

# 1. 启动后端
Write-Host "[1/3] Starting Python backend..." -ForegroundColor Yellow
$env:PYTHONPATH = Join-Path $repoRoot "app\backend"
$env:PYTHONUNBUFFERED = "1"
$backend = Start-Process -FilePath "python" -ArgumentList (Join-Path $repoRoot "app\main.py"), "--server" -WindowStyle Minimized -PassThru

# 等待后端就绪
Write-Host "Waiting for backend..." -ForegroundColor Gray
$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:8765/api/health" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 1
}
if ($ready) { Write-Host "  Backend ready." -ForegroundColor Green }

# 2. 启动前端
Write-Host "[2/3] Starting Vite frontend..." -ForegroundColor Yellow
$frontend = Start-Process -FilePath "npm" -ArgumentList "run", "dev" -WorkingDirectory (Join-Path $repoRoot "app\ui") -WindowStyle Minimized -PassThru

Write-Host "Waiting for frontend..." -ForegroundColor Gray
for ($i = 0; $i -lt 30; $i++) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:5173/" -UseBasicParsing -TimeoutSec 2
        if ($r.StatusCode -eq 200) { break }
    } catch {}
    Start-Sleep -Seconds 1
}

Write-Host ""
Write-Host "=== Ovolve MVP is running ===" -ForegroundColor Cyan
Write-Host "  Frontend:  http://127.0.0.1:5173" -ForegroundColor White
Write-Host "  Backend:   http://127.0.0.1:8765" -ForegroundColor White
Write-Host ""
Write-Host "  Open http://127.0.0.1:5173 in your browser." -ForegroundColor Gray
Write-Host "  Send a message like:" -ForegroundColor Gray
Write-Host '  "给 example.py 加一个日志功能，然后审查并测试"' -ForegroundColor White
Write-Host "  to trigger a 5-Agent fan-out." -ForegroundColor Gray
Write-Host ""
Write-Host "  Press Ctrl+C to stop." -ForegroundColor Gray

# 3. 等待中断
try {
    Wait-Process -Id $backend.Id
} finally {
    Stop-Process -Id $backend.Id -Force -ErrorAction SilentlyContinue
    Stop-Process -Id $frontend.Id -Force -ErrorAction SilentlyContinue
}
