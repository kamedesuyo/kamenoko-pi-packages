@echo off
rem Draw SDXL on the dedicated 4060 with Strata; pause/resume legacy LLMs. Open the image.
rem
rem Usage:  gen-image.bat "1girl, fox ears, smile"                 -> portrait, 1 image
rem         gen-image.bat "1girl, fox ears, smile" landscape 4     -> landscape, 4 images (seed, seed+1, ...)
rem Sizes: portrait (832x1216) / landscape (1216x832) / square (1024x1024). Output: outputDir in the imagegen config
rem More options (seed, steps, output folder): see gen-image.ps1.
setlocal
set "SIZEARG="
if not "%~2"=="" set "SIZEARG=-Size %~2"
set "COUNTARG="
if not "%~3"=="" set "COUNTARG=-Count %~3"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gen-image.ps1" -Prompt "%~1" %SIZEARG% %COUNTARG% -Open
if errorlevel 1 (
  echo.
  echo Failed. See the message above.
  pause
  exit /b 1
)
endlocal
