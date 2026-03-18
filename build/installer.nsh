!macro customInit
  ; === УДАЛЕНИЕ СТАРОЙ ВЕРСИИ (АВТОМАТИЧЕСКИ) ===

  ; 1) per-machine
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString"
  StrCmp $R0 "" _zabor_try_user 0
  Goto _zabor_run_uninstall

  _zabor_try_user:
  ; 2) per-user
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString"
  StrCmp $R0 "" _zabor_try_name 0
  Goto _zabor_run_uninstall

  _zabor_try_name:
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "QuietUninstallString"
  StrCmp $R0 "" _zabor_try_name_user 0
  Goto _zabor_run_uninstall

  _zabor_try_name_user:
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "QuietUninstallString"
  StrCmp $R0 "" _zabor_try_us 0
  Goto _zabor_run_uninstall

  _zabor_try_us:
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  StrCmp $R0 "" _zabor_try_us_user 0
  StrCpy $R0 "$R0 /S"
  Goto _zabor_run_uninstall

  _zabor_try_us_user:
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "UninstallString"
  StrCmp $R0 "" _zabor_init_done 0
  StrCpy $R0 "$R0 /S"
  Goto _zabor_run_uninstall

  _zabor_run_uninstall:
  ; Тихое удаление без диалогов
  ExecWait $R0 $R1
  StrCmp $R1 "" 0 _zabor_wait
  nsExec::ExecToLog 'cmd /c $R0'

  _zabor_wait:
  Sleep 3000
  RMDir /r "$PROGRAMFILES64\${PRODUCT_NAME}"
  RMDir /r "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"

  _zabor_init_done:
!macroend

!macro customUnInstall
  RMDir /r "$APPDATA\zabor-desktop"
  RMDir /r "$LOCALAPPDATA\zabor-desktop"
  RMDir /r "$APPDATA\zabor"
  RMDir /r "$APPDATA\ZABOR"
  RMDir /r "$APPDATA\${PRODUCT_NAME}"
  RMDir /r "$LOCALAPPDATA\zabor"
  RMDir /r "$LOCALAPPDATA\ZABOR"
  RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}"
  RMDir /r "$LOCALAPPDATA\Temp\zabor*"
  RMDir /r "$LOCALAPPDATA\Temp\${PRODUCT_NAME}*"

  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ZABOR"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "zabor-desktop"

  DeleteRegKey HKCU "Software\ZABOR"
  DeleteRegKey HKLM "Software\ZABOR"
  DeleteRegKey HKCU "Software\${PRODUCT_NAME}"
  DeleteRegKey HKLM "Software\${PRODUCT_NAME}"
  DeleteRegKey HKCU "Software\zabor-desktop"
!macroend