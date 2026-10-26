@echo off
rem Start the Qwen-Image 2.1 ComfyUI (qwen.root in the imagegen config, 0.42.4) at http://127.0.0.1:<qwen.comfyPort>.
rem While it is open the local LLM is paused with its KV; press Enter here (or close the ComfyUI window) to bring the LLM back.
rem The workflow "qwen21-t2i" in the Workflows sidebar is the same graph that gen-image-qwen21 uses.
rem Usage:  comfyui-qwen21.bat        -> start only (open the URL yourself; an already open tab reconnects)
rem         comfyui-qwen21.bat open   -> also open it in the default browser
set "OPENARG="
if /i "%~1"=="open" set "OPENARG=-Open"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0comfyui-qwen21.ps1" %OPENARG%
if errorlevel 1 pause
