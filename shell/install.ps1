<#
.SYNOPSIS
    Wires destedtui's project picker into your PowerShell profile.

.DESCRIPTION
    Appends a small marked block that dot-sources shell\destedtui.ps1, which
    defines `proj` / `pj` and auto-launches the picker when a shell starts in
    the projects root. Re-running replaces the block in place, so it is safe to
    run as often as you like; -Uninstall removes it.

    If your $PROFILE is a symlink or a shim that dot-sources a profile living in
    another repo (the sals-powershell-setup layout), the block goes into the
    REAL file - otherwise the next `install.ps1` over there would wipe it.

.EXAMPLE
    destedtui --install-shell
    .\install.ps1 -Uninstall
    .\install.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'

$Begin = '#region destedtui ------------------------------------------------------------'
$End   = '#endregion destedtui ---------------------------------------------------------'

$integration = Join-Path (Split-Path $PSScriptRoot -Parent) 'shell\destedtui.ps1'
$integration = (Resolve-Path $integration).Path

function Write-Ok   { param($m) Write-Host "  $m" -ForegroundColor Green }
function Write-Step { param($m) Write-Host "  $m" -ForegroundColor Cyan }
function Write-Note { param($m) Write-Host "  $m" -ForegroundColor DarkGray }

# --- find the file that actually runs on startup -----------------------------
function Resolve-RealProfile {
    $path = $PROFILE.CurrentUserCurrentHost
    if (-not (Test-Path -LiteralPath $path)) { return $path }

    $item = Get-Item -LiteralPath $path -Force
    if ($item.LinkType -eq 'SymbolicLink' -and $item.Target) {
        $target = @($item.Target)[0]
        if (Test-Path -LiteralPath $target) { return (Resolve-Path $target).Path }
    }

    # A shim: two lines that dot-source the profile kept in a repo.
    $m = Select-String -LiteralPath $path -Pattern "^\s*\`$\w+\s*=\s*'([^']+\.ps1)'" |
         Select-Object -First 1
    if ($m -and (Test-Path -LiteralPath $m.Matches[0].Groups[1].Value)) {
        return (Resolve-Path $m.Matches[0].Groups[1].Value).Path
    }

    return $item.FullName
}

$profilePath = Resolve-RealProfile

Write-Host "`ndestedtui shell integration" -ForegroundColor Magenta
Write-Step "profile: $profilePath"
if ($profilePath -ne $PROFILE.CurrentUserCurrentHost) {
    Write-Note "(reached through $($PROFILE.CurrentUserCurrentHost))"
}

$dir = Split-Path $profilePath -Parent
if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }

$existing = if (Test-Path -LiteralPath $profilePath) { Get-Content -Raw -LiteralPath $profilePath } else { '' }
if ($null -eq $existing) { $existing = '' }

# Strip any previous block so this is idempotent rather than cumulative.
$pattern = [regex]::Escape($Begin) + '.*?' + [regex]::Escape($End) + '\r?\n?'
$stripped = [regex]::Replace($existing, $pattern, '', 'Singleline')
$had = $stripped -ne $existing

if ($Uninstall) {
    if (-not $had) { Write-Note "nothing installed, nothing to remove"; return }
    if ($PSCmdlet.ShouldProcess($profilePath, 'remove destedtui block')) {
        Set-Content -LiteralPath $profilePath -Value $stripped.TrimEnd() -Encoding UTF8
        Write-Ok "removed - open a new shell"
    }
    return
}

$block = @"
$Begin
# Project picker: ``proj`` (alias ``pj``) opens it, enter cds this shell there.
# Also auto-launches when a shell starts in the projects root.
#
# Deliberately near the TOP of the profile: the picker takes over the terminal
# until you choose, so everything above it is time you sit staring at nothing.
# Up here it paints in ~400ms and the rest of the profile loads once you've
# picked. It has to stay below any ``using`` statements, which PowerShell
# requires to be the first statements in the file.
#
# Managed by: destedtui --install-shell   (remove: install.ps1 -Uninstall)
if (Test-Path '$integration') { . '$integration' }
$End
"@

# Insert after the last `using` statement (PowerShell rejects anything before
# them), otherwise at the very top.
$lines = $stripped -split "`r?`n"
$insertAt = 0
for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match '^\s*using\s+(namespace|module|assembly)\s') { $insertAt = $i + 1 }
}

if ($PSCmdlet.ShouldProcess($profilePath, $(if ($had) { 'move destedtui block to the top' } else { 'add destedtui block' }))) {
    $head = if ($insertAt -gt 0) { $lines[0..($insertAt - 1)] } else { @() }
    $tail = if ($insertAt -lt $lines.Count) { $lines[$insertAt..($lines.Count - 1)] } else { @() }
    $out = @($head) + @('') + @($block -split "`r?`n") + @($tail)
    Set-Content -LiteralPath $profilePath -Value ($out -join "`r`n").TrimEnd() -Encoding UTF8
    Write-Ok $(if ($had) { "block moved to line $($insertAt + 2)" } else { "block added at line $($insertAt + 2)" })
}

Write-Host ""
Write-Note "sources: $integration"
Write-Note "root:    $(if ($env:DESTEDTUI_PROJECTS_ROOT) { $env:DESTEDTUI_PROJECTS_ROOT } else { 'G:\code' })"
Write-Host "  open a new shell in the projects root, or type " -NoNewline -ForegroundColor DarkGray
Write-Host "proj" -ForegroundColor Cyan
Write-Host ""
