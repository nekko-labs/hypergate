# Add or remove a directory from the *user* PATH.
#
# A separate script rather than an inline `powershell -Command` in the NSIS
# installer: nesting PowerShell quoting inside NSIS string escaping inside a
# command line is where this kind of thing goes wrong silently.
#
# SetEnvironmentVariable at User scope rather than a raw registry write, so the
# read-modify-write is handled for us and the WM_SETTINGCHANGE broadcast happens,
# which is what makes an already-open Explorer pick the change up.
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir
)

$ErrorActionPreference = 'Stop'

$current = [Environment]::GetEnvironmentVariable('Path', 'User')
if ($null -eq $current) { $current = '' }

# Split, drop empties, and compare case-insensitively without trailing slashes,
# so a reinstall cannot append a second copy of the same directory.
$normalise = { param($p) $p.Trim().TrimEnd('\') }
$target = & $normalise $Dir
$parts = $current -split ';' | Where-Object { $_.Trim() -ne '' }
$kept = $parts | Where-Object { (& $normalise $_) -ne $target }

$updated = switch ($Action) {
  'add' { (@($kept) + $target) -join ';' }
  'remove' { $kept -join ';' }
}

if ($updated -eq $current) {
  Write-Output "PATH already correct for $Action"
  exit 0
}

[Environment]::SetEnvironmentVariable('Path', $updated, 'User')
Write-Output "PATH ${Action}: $target"
