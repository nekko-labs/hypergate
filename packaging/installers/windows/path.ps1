# Add or remove a directory from the *user* PATH.
#
# A separate script rather than an inline `powershell -Command` in the NSIS
# installer: nesting PowerShell quoting inside NSIS string escaping inside a
# command line is where this kind of thing goes wrong silently.
#
# Read and write the raw HKCU value: the environment API expands REG_EXPAND_SZ,
# which would permanently bake variables such as %USERPROFILE% into PATH.
param(
  [Parameter(Mandatory = $true)][ValidateSet('add', 'remove')][string]$Action,
  [Parameter(Mandatory = $true)][string]$Dir
)

$ErrorActionPreference = 'Stop'

$key = [Microsoft.Win32.RegistryKey]::OpenBaseKey(
  [Microsoft.Win32.RegistryHive]::CurrentUser,
  [Microsoft.Win32.RegistryView]::Default
).OpenSubKey('Environment', $true)
if ($null -eq $key) {
  throw 'Could not open HKCU\Environment'
}
try {
  $current = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
  if ($null -eq $current) { $current = '' }
  $kind = [Microsoft.Win32.RegistryValueKind]::String
  try { $kind = $key.GetValueKind('Path') } catch {}

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

$key.SetValue('Path', $updated, $kind)
} finally {
  $key.Dispose()
}

if (-not ('Hypergate.NativeMethods' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
namespace Hypergate {
  public static class NativeMethods {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern IntPtr SendMessageTimeout(
      IntPtr hWnd, uint msg, UIntPtr wParam, string lParam,
      uint flags, uint timeout, out UIntPtr result);
  }
}
'@
}
[UIntPtr]$result = [UIntPtr]::Zero
[void][Hypergate.NativeMethods]::SendMessageTimeout(
  [IntPtr]0xffff, 0x001A, [UIntPtr]::Zero, 'Environment',
  0x0002, 5000, [ref]$result
)
Write-Output "PATH ${Action}: $target"
