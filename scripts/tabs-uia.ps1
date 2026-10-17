# tabs-uia.ps1: Windows Terminal tab titles through UI Automation, for `tabs`
# (src/lib/tabs/capture.ts). JSON on stdout, nothing else.
#
#   -Hwnd <n>  one window: { hwnd, tabs: [title, ...] } in visual order
#   (none)     every Windows Terminal window: [{ hwnd, tabs: [...] }, ...]
param([long]$Hwnd = 0)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$tabCond = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)

function Read-Tabs($el) {
  $names = @()
  foreach ($t in $el.FindAll([Windows.Automation.TreeScope]::Descendants, $tabCond)) { $names += [string]$t.Current.Name }
  , $names
}

if ($Hwnd -ne 0) {
  $w = $A::FromHandle([IntPtr]$Hwnd)
  [Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 @{ hwnd = $Hwnd; tabs = (Read-Tabs $w) }))
  exit 0
}

$classCond = New-Object Windows.Automation.PropertyCondition($A::ClassNameProperty, 'CASCADIA_HOSTING_WINDOW_CLASS')
$out = @()
foreach ($w in $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, $classCond)) {
  $out += @{ hwnd = [long]$w.Current.NativeWindowHandle; tabs = (Read-Tabs $w) }
}
[Console]::Out.Write((ConvertTo-Json -Compress -Depth 4 -InputObject @($out)))
