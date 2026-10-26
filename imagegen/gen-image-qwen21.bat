@echo off
rem Pause the local LLM, draw with Qwen-Image 2.1, bring the LLM back with its KV, and open the image.
rem
rem Usage:  gen-image-qwen21.bat "A photograph of a woman in her thirties ..."            -> portrait, 1 image
rem         gen-image-qwen21.bat "A photograph of a woman in her thirties ..." landscape 2  -> landscape, 2 images (seed, seed+1)
rem Sizes: portrait (832x1248) / landscape (1248x832) / square (1024x1024). Output: <outputDir>\<time>-qwen21.png (imagegen config)
rem More options (seed, steps, cfg, sampler, output folder): see gen-image-qwen21.ps1.
setlocal
set "SIZEARG="
if not "%~2"=="" set "SIZEARG=-Size %~2"
set "COUNTARG="
if not "%~3"=="" set "COUNTARG=-Count %~3"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0gen-image-qwen21.ps1" -Prompt "%~1" %SIZEARG% %COUNTARG% -Open
if errorlevel 1 (
  echo.
  echo Failed. See the message above.
  pause
  exit /b 1
)
endlocal
