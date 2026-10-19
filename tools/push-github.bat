@echo off
chcp 65001 >nul
cd /d "%~dp0.."
echo Отправляю сайт на GitHub (ndzeone/ndze.fun)...
echo Если откроется окно входа GitHub - войди и нажми Authorize.
echo.
"C:\Program Files\Git\cmd\git.exe" push -u origin main
echo.
if errorlevel 1 (
  echo Не получилось. Скопируй текст ошибки выше и пришли его в чат.
) else (
  echo Готово! Деплой запустится сам: https://github.com/ndzeone/ndze.fun/actions
)
pause
