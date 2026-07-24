# Hypergate system-tray launcher (Windows).
#
# Puts a Hypergate icon in the taskbar notification area so you can see the
# daemon is running, open the manager UI, restart it, or quit. This is the
# lightweight interim desktop presence; a full Electron shell is planned.
#
# Launch it hidden with scripts\hypergate-tray.cmd (or `npm run tray`), and add a
# shortcut to that .cmd in your Startup folder (Win+R -> shell:startup) to have
# it run at login.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot                 # scripts\ -> repo root
$daemonJs = Join-Path $repo 'apps\daemon\dist\index.js'
$flyBin = Join-Path $env:USERPROFILE '.fly\bin'          # so catalog `flyctl` resolves
$port = 7777
$uiUrl = "http://localhost:$port/"

# Service preference: open the manager UI on launch, or stay in the tray?
# Managed from the app's Settings view; persisted in ~/.hypergate/settings.json.
$dataDir = if ($env:HYPERGATE_DIR) { $env:HYPERGATE_DIR } else { Join-Path $env:USERPROFILE '.hypergate' }
$settingsPath = Join-Path $dataDir 'settings.json'
$startMinimized = $true
try {
  if (Test-Path $settingsPath) {
    $cfg = Get-Content $settingsPath -Raw | ConvertFrom-Json
    if ($null -ne $cfg.startMinimized) { $startMinimized = [bool]$cfg.startMinimized }
  }
} catch { $startMinimized = $true }

function Test-Daemon {
  try {
    $r = Invoke-WebRequest -Uri "http://localhost:$port/health" -UseBasicParsing -TimeoutSec 2
    return $r.StatusCode -eq 200
  } catch { return $false }
}

$script:daemonProc = $null
function Start-Daemon {
  if (Test-Daemon) { return }                            # already up (started elsewhere)
  if (Test-Path $flyBin) { $env:PATH = "$env:PATH;$flyBin" }
  if (-not (Test-Path $daemonJs)) {
    [System.Windows.Forms.MessageBox]::Show("Build first: npm run build`n(missing $daemonJs)", 'Hypergate') | Out-Null
    return
  }
  $script:daemonProc = Start-Process -FilePath 'node' -ArgumentList "`"$daemonJs`"" -WindowStyle Hidden -PassThru
}

# Tray icon: the Hypergate mark (a violet->cyan warp-gate ring on deep space),
# drawn with GDI+ so there's no .ico asset to ship or rasterize.
function New-HypergateIcon {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $rect = New-Object System.Drawing.Rectangle 0, 0, 32, 32
  $grad = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    $rect,
    [System.Drawing.Color]::FromArgb(0x6d, 0x5e, 0xfc),
    [System.Drawing.Color]::FromArgb(0x22, 0xd3, 0xee), 45)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 9
  $path.AddArc(0, 0, $r, $r, 180, 90)
  $path.AddArc(32 - $r, 0, $r, $r, 270, 90)
  $path.AddArc(32 - $r, 32 - $r, $r, $r, 0, 90)
  $path.AddArc(0, 32 - $r, $r, $r, 90, 90)
  $path.CloseFigure()
  $dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0x0b, 0x0d, 0x1a))
  $g.FillPath($dark, $path)
  $pen = New-Object System.Drawing.Pen $grad, 4
  $g.DrawEllipse($pen, 7, 7, 18, 18)
  $core = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0xa5, 0xf3, 0xfc))
  $g.FillEllipse($core, 13, 13, 6, 6)
  $pen.Dispose()
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = New-HypergateIcon
$notify.Text = 'Hypergate'
$notify.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$openItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Open manager'
$openItem.add_Click({ Start-Process $uiUrl })
$restartItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Restart daemon'
$restartItem.add_Click({
    if ($script:daemonProc -and -not $script:daemonProc.HasExited) { $script:daemonProc.Kill() }
    Start-Sleep -Milliseconds 500
    Start-Daemon
    $notify.ShowBalloonTip(1500, 'Hypergate', 'Daemon restarted', [System.Windows.Forms.ToolTipIcon]::Info)
  })
$quitItem = New-Object System.Windows.Forms.ToolStripMenuItem 'Quit'
$quitItem.add_Click({
    $notify.Visible = $false
    if ($script:daemonProc -and -not $script:daemonProc.HasExited) { $script:daemonProc.Kill() }
    [System.Windows.Forms.Application]::Exit()
  })
$menu.Items.Add($openItem) | Out-Null
$menu.Items.Add($restartItem) | Out-Null
$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator)) | Out-Null
$menu.Items.Add($quitItem) | Out-Null
$notify.ContextMenuStrip = $menu
$notify.add_MouseDoubleClick({ Start-Process $uiUrl })

Start-Daemon
# Honor the "Start minimized" preference: when off, pop the manager UI on launch.
if (-not $startMinimized) { Start-Process $uiUrl }
$notify.ShowBalloonTip(2000, 'Hypergate', "Running - manager at $uiUrl", [System.Windows.Forms.ToolTipIcon]::Info)
[System.Windows.Forms.Application]::Run()
