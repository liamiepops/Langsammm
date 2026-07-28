#!/usr/bin/env pwsh
#
# Builds the wasm module, checks the manifests, and assembles the loadable
# folders.
#
#   ./build.ps1             development. Chrome loads extension/ directly,
#                           Firefox loads dist/firefox. Both keep alt+A.
#   ./build.ps1 -Release    also writes dist/chrome-release and
#                           dist/firefox-release with development-only
#                           features compiled out.

#   ./build.ps1 -Package    a clean release build, then the two zips AMO wants:
#                           the add-on and the reviewable source. Implies
#                           -Release.

param([switch]$Release, [switch]$Package)
if ($Package) { $Release = $true }

$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot

function New-Dist {
    param(
        [string]$Name,
        [string]$Manifest,
        [bool]$StripDev
    )

    $dist = Join-Path $PSScriptRoot "dist\$Name"
    if ($dist -notlike (Join-Path $PSScriptRoot 'dist\*')) { throw "refusing to touch $dist" }
    if (Test-Path $dist) { Remove-Item $dist -Recurse -Force }
    New-Item -ItemType Directory -Force $dist | Out-Null

    Copy-Item (Join-Path $PSScriptRoot 'extension\*') $dist -Recurse -Force
    # The Chrome build already ships manifest.json, so there is nothing to swap.
    if ($Manifest -ne 'manifest.json') {
        Copy-Item (Join-Path $dist $Manifest) (Join-Path $dist 'manifest.json') -Force
    }
    Remove-Item (Join-Path $dist 'manifest.firefox.json') -Force

    if ($StripDev) {
        # A silent miss here would ship a testing feature, so it fails loudly.
        $page = Join-Path $dist 'page.js'
        $src = Get-Content $page -Raw
        $needle = 'const DEV = true;'
        if (-not $src.Contains($needle)) { throw "could not find '$needle' in page.js" }
        $src.Replace($needle, 'const DEV = false;') | Set-Content $page -NoNewline
        $check = Get-Content $page -Raw
        if ($check.Contains($needle)) { throw 'failed to strip the DEV flag' }
    }

    $dev = if ($StripDev) { 'release' } else { 'dev, alt+A included' }
    Write-Host ("dist/$Name".PadRight(24) + $dev)
}

try {
    # An incremental build and a clean build of the same source produce
    # different bytes. Two clean builds agree exactly. So anything a reviewer
    # will try to reproduce has to come from a clean build, or the hash they
    # compute will not match the one submitted.
    if ($Package) {
        Write-Host 'cleaning, so the binary is reproducible from a fresh checkout'
        cargo clean
    }

    cargo test --quiet
    cargo build --release --target wasm32-unknown-unknown
    $src = Join-Path $PSScriptRoot 'target\wasm32-unknown-unknown\release\langsammm.wasm'
    $dst = Join-Path $PSScriptRoot 'extension\langsammm.wasm'
    Copy-Item $src $dst -Force
    $kb = [math]::Round((Get-Item $dst).Length / 1024, 1)
    Write-Host "extension/langsammm.wasm  $kb KB"

    node (Join-Path $PSScriptRoot 'tools\check-manifests.js')
    node (Join-Path $PSScriptRoot 'tools\worklet-harness.js') | Select-Object -Last 1

    # Chrome loads extension/ directly. Firefox needs its own manifest, because
    # the two browsers take different routes into the page's world.
    New-Dist -Name 'firefox' -Manifest 'manifest.firefox.json' -StripDev $false

    if ($Release) {
        New-Dist -Name 'chrome-release' -Manifest 'manifest.json' -StripDev $true
        New-Dist -Name 'firefox-release' -Manifest 'manifest.firefox.json' -StripDev $true
    }

    if ($Package) {
        $version = (Get-Content (Join-Path $PSScriptRoot 'extension\manifest.json') -Raw |
                    ConvertFrom-Json).version
        $sha = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
        $distRoot = Join-Path $PSScriptRoot 'dist'

        # 1. the add-on itself, built from the release folder so the testing
        #    hotkey is not in it. manifest.json has to sit at the zip root.
        $addon = Join-Path $distRoot "langsammm-$version-firefox.zip"
        if (Test-Path $addon) { Remove-Item $addon -Force }
        Compress-Archive -Path (Join-Path $distRoot 'firefox-release\*') -DestinationPath $addon

        # 2. the reviewable source. Everything needed to rebuild the binary and
        #    nothing that would make a reviewer hunt.
        $stage = Join-Path $distRoot 'source-stage'
        if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
        New-Item -ItemType Directory -Force $stage | Out-Null
        foreach ($item in 'src', 'tools', 'extension') {
            Copy-Item (Join-Path $PSScriptRoot $item) $stage -Recurse -Force
        }
        # The built artifact is excluded on purpose: the point is that they
        # produce it themselves and compare.
        Remove-Item (Join-Path $stage 'extension\langsammm.wasm') -Force -ErrorAction SilentlyContinue
        foreach ($f in 'Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'build.ps1', 'REVIEWERS.md', 'README.md') {
            Copy-Item (Join-Path $PSScriptRoot $f) $stage -Force
        }
        "$sha  extension/langsammm.wasm" | Set-Content (Join-Path $stage 'SHA256SUMS') -NoNewline

        $source = Join-Path $distRoot "langsammm-$version-source.zip"
        if (Test-Path $source) { Remove-Item $source -Force }
        Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $source
        Remove-Item $stage -Recurse -Force

        Write-Host ''
        Write-Host ("wasm sha256             " + $sha)
        foreach ($z in $addon, $source) {
            $kb = [math]::Round((Get-Item $z).Length / 1KB, 1)
            Write-Host ("{0,-32}{1} KB" -f (Split-Path $z -Leaf), $kb)
        }
    }
}
finally {
    Pop-Location
}
