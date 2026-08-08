param(
  [Parameter(Mandatory = $true)][string]$Dir
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath($Dir).TrimEnd('\') + '\'
$names = @('hypergate.exe', 'hypergated.exe')

$processes = @(Get-CimInstance Win32_Process | Where-Object {
  $_.Name -in $names -and
  $_.ExecutablePath -and
  ([IO.Path]::GetFullPath($_.ExecutablePath)).StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
})

$running = @()
if ($processes.Count -eq 0) {
  exit 0
}

foreach ($process in $processes) {
  try {
    $local = Get-Process -Id $process.ProcessId -ErrorAction Stop
    if ($local.MainWindowHandle -ne 0) {
      [void]$local.CloseMainWindow()
    }
  } catch {
    # The process may have exited between the CIM query and this best-effort stop.
  }
}

$deadline = [DateTime]::UtcNow.AddSeconds(2)
do {
  Start-Sleep -Milliseconds 100
  $running = @($processes | Where-Object {
    Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue
  })
} while ($running.Count -gt 0 -and [DateTime]::UtcNow -lt $deadline)

foreach ($process in $running) {
  Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
}
exit 0
