<#
.SYNOPSIS
  Build the signed Windows installer and the updater manifest (latest.json) for a GitHub release.

.EXAMPLE
  ./scripts/release.ps1                       # build the version already in package.json
  ./scripts/release.ps1 -Version 2.0.1 -Notes "Faster matcher"
  ./scripts/release.ps1 -Version 2.0.1 -Publish   # also create the GitHub release (needs gh)

  Output goes to v2/release/<version>/: ProjectP_<version>_x64-setup.exe, its .sig and latest.json.
  See docs/RELEASING.md.
#>
param(
    [string]$Version,
    [string]$Notes = "",
    [string]$KeyPath = "$HOME\.tauri\project-p.key",
    [string]$Repo = "HoangTrongPhi/P",
    [switch]$Publish
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$utf8 = New-Object System.Text.UTF8Encoding($false)  # no BOM: the updater parses latest.json strictly

function Set-FileText($path, $text) { [IO.File]::WriteAllText($path, $text, $utf8) }

# ---------------------------------------------------------------- version
$pkgPath = Join-Path $root "package.json"
$cargoPath = Join-Path $root "src-tauri\Cargo.toml"
$confPath = Join-Path $root "src-tauri\tauri.conf.json"

if ($Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$') { throw "Not a semver version: $Version" }
    $pkg = [IO.File]::ReadAllText($pkgPath)
    Set-FileText $pkgPath ([regex]::new('"version":\s*"[^"]+"').Replace($pkg, "`"version`": `"$Version`"", 1))
    $conf = [IO.File]::ReadAllText($confPath)
    Set-FileText $confPath ([regex]::new('"version":\s*"[^"]+"').Replace($conf, "`"version`": `"$Version`"", 1))
    $cargo = [IO.File]::ReadAllText($cargoPath)
    Set-FileText $cargoPath ([regex]::new('(?m)^version = "[^"]+"').Replace($cargo, "version = `"$Version`"", 1))
    Write-Host "Version set to $Version"
}
$Version = (Get-Content $pkgPath -Raw | ConvertFrom-Json).version

# ---------------------------------------------------------------- build
if (-not (Test-Path $KeyPath)) { throw "Signing key not found: $KeyPath (npx tauri signer generate -w `"$KeyPath`")" }
$env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($KeyPath).Trim()
if (-not $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD) { $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "" }

Push-Location $root
# Windows PowerShell turns the CLI's stderr progress lines into errors under "Stop"; judge by exit code.
$ErrorActionPreference = "Continue"
try {
    npm run tauri build
    if ($LASTEXITCODE -ne 0) { throw "tauri build failed ($LASTEXITCODE)" }
} finally {
    Pop-Location
    $ErrorActionPreference = "Stop"
}

# ---------------------------------------------------------------- collect
$nsisDir = Join-Path $root "src-tauri\target\release\bundle\nsis"
$setup = Get-ChildItem $nsisDir -Filter "*_${Version}_x64-setup.exe" | Select-Object -First 1
if (-not $setup) { throw "No installer for $Version in $nsisDir" }
$sigPath = "$($setup.FullName).sig"
if (-not (Test-Path $sigPath)) { throw "Missing signature $sigPath (is TAURI_SIGNING_PRIVATE_KEY set?)" }

$outDir = Join-Path $root "release\$Version"
New-Item -ItemType Directory -Force $outDir | Out-Null
# GitHub turns spaces in asset names into dots, so ship a space-free name the manifest can point at.
$assetName = "ProjectP_${Version}_x64-setup.exe"
Copy-Item $setup.FullName (Join-Path $outDir $assetName) -Force
Copy-Item $sigPath (Join-Path $outDir "$assetName.sig") -Force

$manifest = [ordered]@{
    version   = $Version
    notes     = $Notes
    pub_date  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    platforms = [ordered]@{
        "windows-x86_64" = [ordered]@{
            signature = [IO.File]::ReadAllText($sigPath).Trim()
            url       = "https://github.com/$Repo/releases/download/v$Version/$assetName"
        }
    }
}
Set-FileText (Join-Path $outDir "latest.json") ($manifest | ConvertTo-Json -Depth 5)

Write-Host ""
Write-Host "Release files in $outDir" -ForegroundColor Green
Get-ChildItem $outDir | ForEach-Object { Write-Host "  $($_.Name)  ($([math]::Round($_.Length / 1MB, 1)) MB)" }

# ---------------------------------------------------------------- publish
if ($Publish) {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) { throw "gh (GitHub CLI) is not installed; upload the three files by hand (docs/RELEASING.md)" }
    $files = Get-ChildItem $outDir | ForEach-Object { $_.FullName }
    $notesArg = if ($Notes) { $Notes } else { "Project P v$Version" }
    gh release create "v$Version" @files --repo $Repo --title "Project P v$Version" --notes $notesArg --latest
    if ($LASTEXITCODE -ne 0) { throw "gh release create failed" }
    Write-Host "Published https://github.com/$Repo/releases/tag/v$Version" -ForegroundColor Green
} else {
    Write-Host ""
    Write-Host "Next: create release v$Version on https://github.com/$Repo/releases/new and attach all three files (not marked pre-release)."
}
