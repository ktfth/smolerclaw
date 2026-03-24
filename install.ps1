# ─────────────────────────────────────────────────────────────
# smolerclaw installer for Windows
# Compiles the binary and installs to user PATH
# Usage: powershell -ExecutionPolicy Bypass -File install.ps1
# ─────────────────────────────────────────────────────────────

$ErrorActionPreference = "Stop"

$ProjectDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BinName = "smolerclaw.exe"
$InstallDir = Join-Path $env:LOCALAPPDATA "Microsoft\WindowsApps"
$InstallPath = Join-Path $InstallDir $BinName

Write-Host ""
Write-Host "  smolerclaw installer" -ForegroundColor Cyan
Write-Host "  ==================" -ForegroundColor Cyan
Write-Host ""

# ── Check bun ────────────────────────────────────────────────

Write-Host "[1/5] Checking bun..." -ForegroundColor Yellow
$bunPath = Get-Command bun -ErrorAction SilentlyContinue
if (-not $bunPath) {
    Write-Host "  ERROR: bun is not installed." -ForegroundColor Red
    Write-Host "  Install it: powershell -c 'irm bun.sh/install.ps1 | iex'"
    exit 1
}
$bunVersion = & bun --version 2>&1
Write-Host "  bun $bunVersion found." -ForegroundColor Green

# ── Install dependencies ─────────────────────────────────────

Write-Host "[2/5] Installing dependencies..." -ForegroundColor Yellow
Push-Location $ProjectDir
try {
    & bun install --frozen-lockfile 2>&1 | Out-Null
    Write-Host "  Dependencies installed." -ForegroundColor Green
} catch {
    Write-Host "  WARNING: bun install had issues, trying without --frozen-lockfile..." -ForegroundColor Yellow
    & bun install 2>&1 | Out-Null
}

# ── Typecheck + test ──────────────────────────────────────────

Write-Host "[3/5] Running checks..." -ForegroundColor Yellow
$typecheck = & bun run typecheck 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: TypeScript errors found:" -ForegroundColor Red
    Write-Host $typecheck
    Pop-Location
    exit 1
}

$testResult = & bun test 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "  WARNING: Some tests failed:" -ForegroundColor Yellow
    Write-Host ($testResult | Select-Object -Last 5)
} else {
    $passLine = $testResult | Select-String "pass"
    Write-Host "  Checks passed. $passLine" -ForegroundColor Green
}

# ── Compile binary ────────────────────────────────────────────

Write-Host "[4/5] Compiling binary..." -ForegroundColor Yellow

# Read version from package.json
$pkg = Get-Content (Join-Path $ProjectDir "package.json") | ConvertFrom-Json
$version = $pkg.version

& bun build src/index.ts --compile --outfile "dist/$BinName" --target bun-windows-x64 --define "BUILD_VERSION='`"$version`"'" 2>&1 | Out-Null

if (-not (Test-Path "dist/$BinName")) {
    Write-Host "  ERROR: Compilation failed." -ForegroundColor Red
    Pop-Location
    exit 1
}

$size = [math]::Round((Get-Item "dist/$BinName").Length / 1MB, 1)
Write-Host "  Compiled: dist/$BinName ($size MB)" -ForegroundColor Green

Pop-Location

# ── Install to PATH ───────────────────────────────────────────

Write-Host "[5/5] Installing to $InstallDir..." -ForegroundColor Yellow

if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

Copy-Item (Join-Path $ProjectDir "dist\$BinName") $InstallPath -Force
Write-Host "  Copied to: $InstallPath" -ForegroundColor Green

# Add to user PATH if not already there
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*$InstallDir*") {
    [Environment]::SetEnvironmentVariable("Path", "$userPath;$InstallDir", "User")
    Write-Host "  Added $InstallDir to user PATH." -ForegroundColor Green
    Write-Host "  NOTE: Restart your terminal for PATH changes to take effect." -ForegroundColor Yellow
} else {
    Write-Host "  $InstallDir already in PATH." -ForegroundColor Green
}

# ── Done ──────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Installation complete!" -ForegroundColor Cyan
Write-Host "  smolerclaw v$version" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Usage:" -ForegroundColor White
Write-Host "    smolerclaw                    # interactive mode"
Write-Host "    smolerclaw 'explain this'     # with prompt"
Write-Host "    smolerclaw -p '2+2'           # print mode"
Write-Host ""
Write-Host "  First run:" -ForegroundColor White
Write-Host "    set ANTHROPIC_API_KEY=sk-ant-..."
Write-Host "    smolerclaw"
Write-Host ""
