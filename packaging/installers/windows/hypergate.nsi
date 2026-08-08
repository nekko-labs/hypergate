; Hypergate installer for Windows.
;
; Per-user by design: RequestExecutionLevel user, install under %LOCALAPPDATA%,
; HKCU only. Hypergate is a per-user logon agent whose managed MCP servers need
; the user's PATH, home directory, npx cache and keychain, so a machine-wide
; install would buy nothing and cost a UAC prompt.
;
; Built by scripts/build-installers.mjs, which passes:
;   /DVERSION=  /DARCH=  /DPAYLOAD=<dist-standalone>  /DOUTFILE=  /DICON=

!include "MUI2.nsh"
!include "FileFunc.nsh"
!include "LogicLib.nsh"
AllowSkipFiles off

!ifndef VERSION
  !error "VERSION must be defined"
!endif

Name "Hypergate ${VERSION}"
OutFile "${OUTFILE}"
Unicode true
RequestExecutionLevel user
SetCompressor /SOLID lzma
InstallDir "$LOCALAPPDATA\Programs\Hypergate"
InstallDirRegKey HKCU "Software\Hypergate" "InstallDir"
BrandingText "Nekko Labs"

VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "Hypergate"
VIAddVersionKey "FileDescription" "Local-first runtime and gateway for MCP servers"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "MIT"
VIAddVersionKey "CompanyName" "Nekko Labs"

!define UNINST_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\Hypergate"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\hypergate.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "app"
!define MUI_FINISHPAGE_RUN_TEXT "Open Hypergate now"
!define MUI_FINISHPAGE_LINK "hypergate.app"
!define MUI_FINISHPAGE_LINK_LOCATION "https://hypergate.app"

!insertmacro MUI_PAGE_LICENSE "${PAYLOAD}\LICENSE"
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

; Stop anything we are about to overwrite. An upgrade over a running tray would
; otherwise fail to replace the binary that is currently executing.
!macro StopHypergate PREFIX
  InitPluginsDir
  File "/oname=$PLUGINSDIR\stop.ps1" "${STOPSCRIPT}"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\stop.ps1" -Dir "${PREFIX}"'
  Pop $0
!macroend

Section "Hypergate (required)" SecCore
  SectionIn RO
  !insertmacro StopHypergate "$INSTDIR"

  SetOutPath "$INSTDIR"
  File "${PAYLOAD}\hypergate.exe"
  File "${PAYLOAD}\hypergated.exe"
  File "${PAYLOAD}\LICENSE"
  File "${PAYLOAD}\README.md"
  SetOutPath "$INSTDIR\web"
  File /r "${PAYLOAD}\web\*"
  SetOutPath "$INSTDIR"

  WriteRegStr HKCU "Software\Hypergate" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Hypergate" "Version" "${VERSION}"
  WriteUninstaller "$INSTDIR\uninstall.exe"

  ; Add/Remove Programs. Per-user, so HKCU rather than HKLM.
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayName" "Hypergate"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINST_KEY}" "Publisher" "Nekko Labs"
  WriteRegStr HKCU "${UNINST_KEY}" "URLInfoAbout" "https://hypergate.app"
  WriteRegStr HKCU "${UNINST_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINST_KEY}" "DisplayIcon" "$INSTDIR\hypergate.exe"
  WriteRegStr HKCU "${UNINST_KEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegStr HKCU "${UNINST_KEY}" "QuietUninstallString" '"$INSTDIR\uninstall.exe" /S'
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINST_KEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $0 $1 $2
  IntFmt $0 "0x%08X" $0
  WriteRegDWORD HKCU "${UNINST_KEY}" "EstimatedSize" "$0"

  ; The launcher is created by Hypergate itself rather than NSIS: it resolves
  ; known folders properly (a redirected OneDrive desktop is normal) and writes
  ; the multi-resolution icon from the same code that draws the tray icon.
  nsExec::ExecToLog '"$INSTDIR\hypergate.exe" shortcut install'
  Pop $0
SectionEnd

Section "Desktop icon" SecDesktop
  nsExec::ExecToLog '"$INSTDIR\hypergate.exe" shortcut install --desktop'
  Pop $0
SectionEnd

Section "Add to PATH (for the hypergate command)" SecPath
  ; A script file, not an inline -Command: nesting PowerShell quoting inside
  ; NSIS escaping inside a command line is where this silently goes wrong.
  InitPluginsDir
  File "/oname=$PLUGINSDIR\path.ps1" "${PATHSCRIPT}"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\path.ps1" -Action add -Dir "$INSTDIR"'
  Pop $0
SectionEnd

Section "Start at login" SecAutostart
  nsExec::ExecToLog '"$INSTDIR\hypergate.exe" autostart on'
  Pop $0
SectionEnd

LangString DESC_SecCore ${LANG_ENGLISH} "The Hypergate daemon, CLI and tray agent, plus the manager UI. Requires no other software."
LangString DESC_SecDesktop ${LANG_ENGLISH} "Put a Hypergate icon on the desktop as well as in the Start Menu."
LangString DESC_SecPath ${LANG_ENGLISH} "Add Hypergate to your PATH so `hypergate` works in any terminal."
LangString DESC_SecAutostart ${LANG_ENGLISH} "Start Hypergate automatically when you log in."

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SecCore} $(DESC_SecCore)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecDesktop} $(DESC_SecDesktop)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecPath} $(DESC_SecPath)
  !insertmacro MUI_DESCRIPTION_TEXT ${SecAutostart} $(DESC_SecAutostart)
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  ; Let Hypergate remove what Hypergate created, so the launcher and login item
  ; are cleaned up wherever they actually ended up.
  ${If} ${FileExists} "$INSTDIR\hypergate.exe"
    nsExec::Exec '"$INSTDIR\hypergate.exe" autostart off'
    Pop $0
    nsExec::Exec '"$INSTDIR\hypergate.exe" shortcut uninstall'
    Pop $0
  ${EndIf}
  !insertmacro StopHypergate "$INSTDIR"

  InitPluginsDir
  File "/oname=$PLUGINSDIR\path.ps1" "${PATHSCRIPT}"
  nsExec::ExecToLog 'powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\path.ps1" -Action remove -Dir "$INSTDIR"'
  Pop $0

  Delete "$INSTDIR\hypergate.exe"
  Delete "$INSTDIR\hypergated.exe"
  Delete "$INSTDIR\LICENSE"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR\web"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINST_KEY}"
  DeleteRegKey HKCU "Software\Hypergate"

  ; Deliberately left alone: %USERPROFILE%\.hypergate holds the user's server
  ; configs, usage history and OAuth grants. An uninstall must not throw away
  ; data an upgrade or reinstall would want back.
SectionEnd
