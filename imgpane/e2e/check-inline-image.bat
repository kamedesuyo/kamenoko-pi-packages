@echo off
rem Check that inline images in pi (WezTerm + Herdr + pi + image-pane.ts) still work, e.g. after updating pi or Herdr.
rem Runs in a throwaway Herdr workspace in the background. Add -WithLLM to also test images in tool results (uses the LLM briefly).
setlocal
where pwsh >nul 2>nul
if %errorlevel%==0 (
  pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-inline-image.ps1" %*
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0check-inline-image.ps1" %*
)
exit /b %errorlevel%
