# Ovolve Agent — 开发者预览模式
# 启动方式（与 Ovolve 一致）：
#   cd app/ui
#   npm run dev:electron
#
# 自动分配 Vite / 后端 / Bridge 端口，可与 Ovolve 等其他 Electron 项目并行运行。
$PSScriptRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $repoRoot

Write-Host "=== Ovolve Agent Developer Preview ===" -ForegroundColor Cyan
Write-Host "Workspace: $repoRoot" -ForegroundColor Gray

# 检查 node_modules
if (-not (Test-Path "$repoRoot\app\ui\node_modules")) {
    Write-Host "Installing UI dependencies..." -ForegroundColor Yellow
    Set-Location "$repoRoot\app\ui"
    npm install
    Set-Location $repoRoot
}

# 检查 .api_token（Vite 代理用）
if (-not (Test-Path "$repoRoot\app\.api_token")) {
    Write-Host "Generating API token..." -ForegroundColor Yellow
    $token = -join ((48..57) + (97..122) | Get-Random -Count 32 | ForEach-Object { [char]$_ })
    $token | Out-File -FilePath "$repoRoot\app\.api_token" -Encoding utf8
    Write-Host "Token written to app\.api_token" -ForegroundColor Gray
}

Write-Host "Starting Vite + Electron (dynamic ports)..." -ForegroundColor Green
Write-Host "  cd app\ui" -ForegroundColor Cyan
Write-Host "  npm run dev:electron" -ForegroundColor Cyan
Write-Host ""
Write-Host "Press Ctrl+C to stop" -ForegroundColor Gray
Write-Host ""

Set-Location "$repoRoot\app\ui"
npm run dev:electron
