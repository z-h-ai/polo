!macro customInstall
  DetailPrint "Installing Polo terminal command..."
  ; Pass the inherited environment value explicitly. NSIS's $LOCALAPPDATA
  ; shell variable may resolve a known-folder value in a child process rather
  ; than the environment inherited by a per-user installer (notably in tests).
  ; Install and uninstall must therefore target the exact same managed bin.
  Push $R1
  ReadEnvStr $R1 "LOCALAPPDATA"
  StrCpy $R1 "$R1\Polo AI\bin"
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\resources\scripts\windows-terminal-integration.ps1" -Mode Install -InstallDir "$INSTDIR" -BinDir "$R1"'
  Pop $0
  ${If} $0 == 0
    ; Keep the exact target in the per-user install registry. NSIS INI
    ; round-trips can corrupt a Unicode LOCALAPPDATA path (for example, a
    ; non-ASCII Windows username), while registry strings preserve it for the
    ; uninstaller's separate process.
    WriteRegStr HKCU "${INSTALL_REGISTRY_KEY}" "PoloTerminalBinDir" "$R1"
  ${EndIf}
  Pop $R1
  ${If} $0 != 0
    ; A silent installer has no user who can dismiss a MessageBox. Returning a
    ; non-zero exit code makes CI and updater callers fail closed instead of
    ; hanging forever after terminal setup fails.
    IfSilent polo_terminal_setup_silent_failure
    MessageBox MB_ICONEXCLAMATION|MB_OK "Polo was installed, but terminal setup could not be completed. Another command named 'polo' may already exist. Run the repair action from Polo Settings after resolving the conflict."
    Goto polo_terminal_setup_finished
polo_terminal_setup_silent_failure:
    SetErrorLevel 1
    Quit
polo_terminal_setup_finished:
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing Polo terminal command..."
  Push $R1
  Push $R2
  StrCpy $R2 ""
  ReadRegStr $R1 HKCU "${INSTALL_REGISTRY_KEY}" "PoloTerminalBinDir"
  ${If} $R1 == ""
    ; Legacy installs predate the Unicode-safe registry value. Their
    ; conventional per-user location remains the safe fallback.
    ReadEnvStr $R1 "LOCALAPPDATA"
    StrCpy $R1 "$R1\Polo AI\bin"
  ${Else}
    StrCpy $R2 "-RequireOwnershipState"
  ${EndIf}
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\resources\scripts\windows-terminal-integration.ps1" -Mode Uninstall -InstallDir "$INSTDIR" -BinDir "$R1" $R2'
  Pop $0
  Pop $R2
  Pop $R1
  ${If} $0 != 0
    ; The terminal command is outside $INSTDIR.  Continuing after its guarded
    ; cleanup fails would claim a successful uninstall while leaving a managed
    ; command or PATH entry behind, so let callers retry instead.
    IfSilent polo_terminal_uninstall_silent_failure
    MessageBox MB_ICONEXCLAMATION|MB_OK "Polo could not remove its terminal command. Close any shells using 'polo' and try uninstalling again."
polo_terminal_uninstall_silent_failure:
    SetErrorLevel 1
    Quit
  ${EndIf}
!macroend
