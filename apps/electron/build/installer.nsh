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
    ; Keep the exact target beside the installed app. The uninstaller runs in
    ; a new process and must not rediscover a potentially different profile.
    WriteINIStr "$INSTDIR\polo-terminal-integration.ini" "terminal" "binDir" "$R1"
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

!macro customUnInit
  DetailPrint "Removing Polo terminal command..."
  Push $R1
  Push $R2
  Push $R3
  Push $R4
  StrCpy $R2 ""
  ReadEnvStr $R3 "POLO_NSIS_UNINSTALL_TRACE_FILE"
  ReadINIStr $R1 "$INSTDIR\polo-terminal-integration.ini" "terminal" "binDir"
  ${If} $R1 == ""
    ; Legacy installs predate the persisted target. Their conventional
    ; per-user location remains the safe fallback.
    ReadEnvStr $R1 "LOCALAPPDATA"
    StrCpy $R1 "$R1\Polo AI\bin"
  ${Else}
    StrCpy $R2 "-RequireOwnershipState"
  ${EndIf}
  ${If} $R3 != ""
    ClearErrors
    FileOpen $R4 "$R3" w
    ${IfNot} ${Errors}
      FileWrite $R4 "customUnInit entered$\r$\ninstDir=$INSTDIR$\r$\nbinDir=$R1$\r$\n"
      FileClose $R4
    ${EndIf}
  ${EndIf}
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\resources\scripts\windows-terminal-integration.ps1" -Mode Uninstall -InstallDir "$INSTDIR" -BinDir "$R1" $R2'
  Pop $0
  ${If} $R3 != ""
    ClearErrors
    FileOpen $R4 "$R3" a
    ${IfNot} ${Errors}
      FileWrite $R4 "exitCode=$0$\r$\n"
      FileClose $R4
    ${EndIf}
  ${EndIf}
  Pop $R4
  Pop $R3
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
    Abort
  ${EndIf}
!macroend
