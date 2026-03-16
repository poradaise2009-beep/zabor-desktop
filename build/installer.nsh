!macro customInit
  ; === ВЫБОР: ДЛЯ КОГО УСТАНАВЛИВАТЬ ===
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Установить ZABOR для всех пользователей?$\n$\n\
    «Да» — для всех (нужны права администратора)$\n\
    «Нет» — только для вас (без прав администратора)" \
    IDYES _zabor_all_users

  ; --- Для текущего пользователя ---
  SetShellVarContext current
  StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"
  Goto _zabor_remove_old

  _zabor_all_users:
  ; --- Для всех пользователей ---
  SetShellVarContext all
  StrCpy $INSTDIR "$PROGRAMFILES64\${PRODUCT_NAME}"

  _zabor_remove_old:
  ; === УДАЛЕНИЕ СТАРОЙ ВЕРСИИ ===

  ; 1) Ищем per-machine установку
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString"
  StrCmp $R0 "" _zabor_try_user 0
  Goto _zabor_run_uninstall

  _zabor_try_user:
  ; 2) Ищем per-user установку
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "QuietUninstallString"
  StrCmp $R0 "" _zabor_try_name 0
  Goto _zabor_run_uninstall

  _zabor_try_name:
  ; 3) Fallback — ищем по имени продукта (per-machine)
  ReadRegStr $R0 HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "QuietUninstallString"
  StrCmp $R0 "" _zabor_try_name_user 0
  Goto _zabor_run_uninstall

  _zabor_try_name_user:
  ; 4) Fallback — ищем по имени продукта (per-user)
  ReadRegStr $R0 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${PRODUCT_NAME}" "QuietUninstallString"
  StrCmp $R0 "" _zabor_try_uninstall_string 0
  Goto _zabor_run_uninstall

  _zabor_try_uninstall_string:
  ; 5) Последний fallback — UninstallString вместо QuietUninstallString
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
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Обнаружена предыдущая версия ZABOR.$\nУдалить её перед установкой новой?" \
    IDNO _zabor_init_done

  ; Запускаем деинсталлятор и ждём завершения
  ExecWait $R0 $R1

  ; Если ExecWait не сработал — пробуем через cmd
  StrCmp $R1 "" 0 _zabor_wait
  nsExec::ExecToLog 'cmd /c $R0'

  _zabor_wait:
  ; Ждём пока файлы разблокируются
  Sleep 4000

  ; Принудительно чистим папки старой установки
  RMDir /r "$PROGRAMFILES64\${PRODUCT_NAME}"
  RMDir /r "$LOCALAPPDATA\Programs\${PRODUCT_NAME}"

  _zabor_init_done:
!macroend

!macro customUnInstall
  ; === ПОЛНАЯ ОЧИСТКА ПРИ УДАЛЕНИИ ===

  ; Данные приложения — Electron userData
  ; Имя папки = "name" из package.json = "zabor-desktop"
  RMDir /r "$APPDATA\zabor-desktop"
  RMDir /r "$LOCALAPPDATA\zabor-desktop"

  ; Вариации имени на случай переименования
  RMDir /r "$APPDATA\zabor"
  RMDir /r "$APPDATA\ZABOR"
  RMDir /r "$APPDATA\${PRODUCT_NAME}"
  RMDir /r "$LOCALAPPDATA\zabor"
  RMDir /r "$LOCALAPPDATA\ZABOR"
  RMDir /r "$LOCALAPPDATA\${PRODUCT_NAME}"

  ; Electron cache (Chromium)
  RMDir /r "$LOCALAPPDATA\Temp\zabor*"
  RMDir /r "$LOCALAPPDATA\Temp\${PRODUCT_NAME}*"

  ; Автозагрузка — снимаем если была
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${PRODUCT_NAME}"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "ZABOR"
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "zabor-desktop"

  ; Реестр приложения
  DeleteRegKey HKCU "Software\ZABOR"
  DeleteRegKey HKLM "Software\ZABOR"
  DeleteRegKey HKCU "Software\${PRODUCT_NAME}"
  DeleteRegKey HKLM "Software\${PRODUCT_NAME}"
  DeleteRegKey HKCU "Software\zabor-desktop"
!macroend