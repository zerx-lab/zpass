; Custom NSIS hooks for the ZPass Windows installer.
; -----------------------------------------------------------------------------
; Why this exists
;
; ZPass ships two long-lived helper binaries next to the main zpass.exe inside
; the install tree (resources\bin\<os>-<arch>\):
;
;   - zpass-native-host.exe : browser Native Messaging host. Spawned by the
;     browser (Chrome/Edge/Firefox) on connectNative and kept alive while the
;     extension popup / native port is open. Its lifecycle is NOT controlled by
;     the ZPass GUI, so closing the GUI before upgrading does NOT stop it.
;   - zpass-agent.exe       : SSH agent daemon. Supervised by the GUI but
;     intentionally allowed to outlive it.
;
; electron-builder's built-in "close running app" logic only targets the main
; executable (zpass.exe); it does not enumerate child processes under
; resources\bin\. If either helper is still running during an install/upgrade
; or uninstall, Windows holds a file lock on the .exe and NSIS fails to
; overwrite/delete it ("file in use" / cannot replace), aborting the operation.
;
; Fix: forcibly terminate both helpers before the installer touches files.
; taskkill /F /IM kills by image name (per-user processes need no elevation in
; a per-user install). Missing processes make taskkill exit non-zero (128); we
; intentionally ignore the return code so a not-running helper is a no-op.
; -----------------------------------------------------------------------------

!macro killZpassHelpers
  ; nsExec::Exec runs taskkill without flashing a console window. /T also kills
  ; child process trees. Pop discards the exit code (128 when not running).
  DetailPrint "Stopping ZPass background helpers..."
  nsExec::Exec 'taskkill /F /T /IM zpass-native-host.exe'
  Pop $0
  nsExec::Exec 'taskkill /F /T /IM zpass-agent.exe'
  Pop $0
!macroend

; Runs early in the install wizard, before files are written. Releases any file
; lock the helpers hold so the overwrite/upgrade can replace them.
!macro customInit
  !insertmacro killZpassHelpers
!macroend

; Runs at the start of uninstall, before files are deleted. Same lock-release
; rationale: a helper left running would block removal of its own .exe.
!macro customUnInit
  !insertmacro killZpassHelpers
!macroend
