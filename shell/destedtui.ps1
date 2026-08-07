# destedtui shell integration.
#
# Dot-source this from your PowerShell profile (destedtui --install-shell does
# that for you). It gives you:
#
#   proj / pj      open the project picker; enter cds the CURRENT shell there
#   dested         short alias for the destedtui bin (dested --backup, etc.)
#   term           jump straight into the terminal multiplexer, here
#   auto-launch    the picker opens by itself when a new shell starts in the
#                  projects root (that's Windows Terminal's startingDirectory)
#
# THE cd TRICK, because it is not obvious: a child process cannot change its
# parent shell's directory. So we hand destedtui a temp file via
# DESTEDTUI_CD_FILE, it writes the chosen path there before exiting, and we
# Set-Location to whatever came back. No file written = you pressed esc.
#
# Escape hatches:
#   $env:DESTEDTUI_NO_AUTOSTART = 1     turn the auto-launch off for a session
#   $env:DESTEDTUI_PROJECTS_ROOT        scan somewhere other than g:\code

$global:DestedTuiProjectsRoot = if ($env:DESTEDTUI_PROJECTS_ROOT) { $env:DESTEDTUI_PROJECTS_ROOT } else { 'G:\code' }

function proj {
    if (-not (Get-Command destedtui -ErrorAction SilentlyContinue)) {
        Write-Warning "destedtui is not on PATH - run 'bun link' in G:\code\destedtui"
        return
    }

    $cdFile = Join-Path ([System.IO.Path]::GetTempPath()) ("destedtui-cd-{0}.txt" -f [guid]::NewGuid().ToString('N'))
    $env:DESTEDTUI_CD_FILE = $cdFile
    try {
        destedtui --projects
    } finally {
        Remove-Item Env:\DESTEDTUI_CD_FILE -ErrorAction SilentlyContinue
    }

    if (Test-Path -LiteralPath $cdFile) {
        # Line 1 is the directory; an optional line 2 is a command to run there
        # (the card's dev / claude buttons). Running it HERE rather than inside
        # destedtui is the whole point: it gets your real interactive terminal.
        $lines  = @(Get-Content -LiteralPath $cdFile)
        $target = if ($lines.Count -gt 0) { $lines[0].Trim() } else { '' }
        $cmd    = if ($lines.Count -gt 1) { $lines[1].Trim() } else { '' }
        Remove-Item -LiteralPath $cdFile -Force -ErrorAction SilentlyContinue

        if ($target -and (Test-Path -LiteralPath $target)) {
            Set-Location -LiteralPath $target
            if ($cmd) { Invoke-Expression $cmd }
        }
    }
}

Set-Alias -Name pj -Value proj -Scope Global

# `dested` is just the bin under a shorter name, so the whole CLI is reachable
# without the `tui` tail: `dested --term`, `dested --backup`, `dested --local`.
Set-Alias -Name dested -Value destedtui -Scope Global

# `term` drops you straight into the terminal multiplexer, using THIS shell's
# directory for the panes it spawns — no cd handoff, you stay where you are.
function term {
    if (-not (Get-Command destedtui -ErrorAction SilentlyContinue)) {
        Write-Warning "destedtui is not on PATH - run 'bun link' in G:\code\destedtui"
        return
    }
    destedtui --term
}

function Test-DestedTuiAutostart {
    # $CommandLine is a parameter purely so this can be tested with a simulated
    # launch; nothing passes it in normal use.
    param(
        [string[]]$CommandLine = [Environment]::GetCommandLineArgs(),
        [string]$Location = (Get-Location).Path
    )

    if ($env:DESTEDTUI_NO_AUTOSTART) { return $false }
    # Only a real interactive console: never inside VS Code's PS host, an agent,
    # a build step, or `pwsh -Command ...` (all of which also load the profile).
    if ($Host.Name -ne 'ConsoleHost') { return $false }
    if (-not [Environment]::UserInteractive) { return $false }
    if ($env:CLAUDECODE -or $env:CI) { return $false }
    foreach ($a in $CommandLine) {
        if ($a -match '^-(c|Command|EncodedCommand|e|ec|f|File|NonInteractive|noni)$') { return $false }
    }
    if (-not (Get-Command destedtui -ErrorAction SilentlyContinue)) { return $false }
    # Only when the shell STARTED in the projects root itself. Opening a shell
    # inside a project means you already know where you're going.
    return ($Location.TrimEnd('\', '/') -ieq $global:DestedTuiProjectsRoot.TrimEnd('\', '/'))
}

if (Test-DestedTuiAutostart) { proj }
