!macro customInstall
  DetailPrint "Installing Polo terminal command..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\resources\scripts\windows-terminal-integration.ps1" -Mode Install -InstallDir "$INSTDIR"'
  Pop $0
  ${If} $0 != 0
    MessageBox MB_ICONEXCLAMATION|MB_OK "Polo was installed, but terminal setup could not be completed. Another command named 'polo' may already exist. Run the repair action from Polo Settings after resolving the conflict."
  ${EndIf}
!macroend

!macro customUnInstall
  DetailPrint "Removing Polo terminal command..."
  nsExec::ExecToLog 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\resources\app\resources\scripts\windows-terminal-integration.ps1" -Mode Uninstall -InstallDir "$INSTDIR"'
  Pop $0
!macroend
