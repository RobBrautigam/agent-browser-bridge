@echo off
REM Native messaging host shim (Windows).
REM
REM Chromium cannot pass arguments to a bare node.exe in a native messaging
REM manifest, so the manifest points at this .cmd and Chromium launches it via
REM cmd.exe /c. It resolves its own folder (%~dp0, always absolute, trailing
REM backslash included) and hands every argument straight through: argv 1 is the
REM calling extension origin, argv 2 on Windows is --parent-window=<HWND>.
REM
REM STDOUT IS PROTOCOL. Nothing in this file may write to it, and nothing may
REM redirect it. @echo off is load bearing, not cosmetic.
setlocal EnableExtensions DisableDelayedExpansion
if not defined BRIDGE_NODE set "BRIDGE_NODE=node.exe"
"%BRIDGE_NODE%" "%~dp0index.mjs" %*
exit /b %ERRORLEVEL%
