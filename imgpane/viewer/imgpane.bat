@echo off
rem imgpane: show images that agents make or read, in a Windows Terminal split pane (Sixel).
rem
rem Usage:  imgpane.bat              split the current Windows Terminal tab and open the viewer on the right
rem         imgpane.bat show A.png   send images to the viewer (works even when the viewer is not open)
rem         imgpane.bat view         run the viewer in this console
rem         imgpane.bat hook         for Claude Code / Codex hooks: read the hook JSON on stdin and send image paths
rem Keys in the viewer: left/right  Home/End  o open  c copy path  r redraw  q quit
rem
rem Python (with Pillow and numpy): IMGPANE_PYTHON, else the first line of %LOCALAPPDATA%\imgpane\python.txt, else python on PATH.
setlocal
set "PY=%IMGPANE_PYTHON%"
if not defined PY if exist "%LOCALAPPDATA%\imgpane\python.txt" set /p PY=<"%LOCALAPPDATA%\imgpane\python.txt"
if not defined PY set "PY=python"
if /i "%~1"=="show" goto run
if /i "%~1"=="view" goto run
if /i "%~1"=="hook" goto run
if defined WT_SESSION (
  wt.exe -w 0 split-pane -V --size 0.4 --title imgpane cmd /c "%~f0" view
  exit /b
)
"%PY%" -s "%~dp0imgpane.py" view
exit /b
:run
"%PY%" -s "%~dp0imgpane.py" %*
