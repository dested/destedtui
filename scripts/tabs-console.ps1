# tabs-console.ps1: set the console title of other processes' consoles, for
# `tabs` (src/lib/tabs/capture.ts). Each Windows Terminal pane is a console;
# its tab shows that console's title, so stamping a unique title on a pane's
# shell tells us which tab it is.
#
# stdin:  [{ "pid": 123, "title": "new title" | null }, ...]   (null = only read it)
# stdout: [{ "pid": 123, "ok": true, "prior": "the title before" }, ...]
#
# Started with no console window of its own (Bun's windowsHide), so
# FreeConsole + AttachConsole never touch the terminal `tabs` runs in.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$req = @([Console]::In.ReadToEnd() | ConvertFrom-Json)

Add-Type -Namespace TabsCapture -Name Con -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError = true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern uint GetConsoleTitleW(System.Text.StringBuilder buf, uint size);
[DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern bool SetConsoleTitleW(string title);
'@

$out = @()
foreach ($r in $req) {
  $pid2 = [uint32]$r.pid
  [void][TabsCapture.Con]::FreeConsole()
  if (-not [TabsCapture.Con]::AttachConsole($pid2)) {
    $out += @{ pid = $pid2; ok = $false; prior = '' }
    continue
  }
  $sb = New-Object System.Text.StringBuilder 4096
  [void][TabsCapture.Con]::GetConsoleTitleW($sb, 4096)
  $ok = if ($null -eq $r.title) { $true } else { [TabsCapture.Con]::SetConsoleTitleW([string]$r.title) }
  $out += @{ pid = $pid2; ok = [bool]$ok; prior = $sb.ToString() }
}
[void][TabsCapture.Con]::FreeConsole()
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 3 -InputObject @($out)))
