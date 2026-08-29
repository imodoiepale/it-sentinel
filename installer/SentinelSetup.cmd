@echo off
setlocal EnableExtensions

rem ---------------------------------------------------------------------
rem  IT Sentinel - double-clickable enrollment launcher (no compiler needed)
rem
rem  Does the same job as SentinelSetup.exe, and for most teams it is the
rem  better artifact: a .cmd is plain text, so a suspicious teammate can open
rem  it in Notepad and read every line before running it, and it carries none
rem  of the unsigned-binary problem the .exe does. Windows will still warn
rem  about a downloaded .cmd - it is a single "Run anyway" on the SmartScreen
rem  Open File dialog rather than the two-click "More info" path the exe
rem  needs, and Defender does not treat it as a novel unsigned executable.
rem
rem  All this file does is hand off to Windows PowerShell, which then runs
rem  the same bootstrap.ps1 the one-liner on /enroll runs. It makes no
rem  decisions about the machine; install-sentinel-agent.ps1 still shows its
rem  full disclosure and still waits for a typed INSTALL.
rem
rem  Usage:
rem    double-click it, or
rem    SentinelSetup.cmd [branch-slug] [https://control-plane-url]
rem
rem  ASCII only, and it must stay that way. cmd.exe renders this file in the
rem  console's OEM code page, and a smart quote or an en-dash pasted in here
rem  shows up as mojibake on every machine with a different regional setting.
rem ---------------------------------------------------------------------

rem Compile-time default, same as the exe's. Public, not a secret.
set "SENTINEL_URL=https://it-sentinel-control-plane.onrender.com"
set "SENTINEL_BRANCH="

if not "%~1"=="" set "SENTINEL_BRANCH=%~1"
if not "%~2"=="" set "SENTINEL_URL=%~2"

title IT Sentinel - Setup

echo.
echo   IT SENTINEL - Setup
echo   -------------------
echo   Machine      : %COMPUTERNAME%
echo   Signed in as : %USERDOMAIN%\%USERNAME%
echo   Control plane: %SENTINEL_URL%
echo.
echo   This downloads bootstrap.ps1 from the control plane above and runs it.
echo   That script fetches the agent code and starts the real installer, which
echo   tells you exactly what it collects and what it changes and waits for you
echo   to type INSTALL before touching anything.
echo.
echo   Once this machine is enrolled an operator will be able to view and
echo   control the desktop. Do not enroll a personal laptop you would not
echo   want watched.
echo.

rem Absolute path, not the bare name. PATH on a machine we have never seen is
rem not something to bet an install on, and a powershell.exe planted earlier
rem on PATH than the real one is an old and effective trick. SystemRoot is
rem set by Windows itself and cannot be inherited from a caller's environment
rem the way PATH can.
set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=powershell.exe"

set /p "SENTINEL_OK=  Type ENROLL to continue, or anything else to stop: "
if /I not "%SENTINEL_OK%"=="ENROLL" goto :stopped

echo.

rem -Command with a scriptblock rather than -File, because the script is
rem being fetched rather than saved: this is exactly the form the enrollment
rem page generates, so a teammate reading both sees the same thing twice.
rem
rem The single quotes are PowerShell's literal-string quotes, so nothing
rem inside is expanded by PowerShell. cmd.exe still expands %VARS% before
rem PowerShell ever sees the line - which is fine here, because both values
rem come from this file's own defaults or from argv, and a slug or URL with a
rem quote in it is not a thing anybody will type by accident.
if defined SENTINEL_BRANCH (
  "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm '%SENTINEL_URL%/v1/enroll/bootstrap.ps1'))) -BranchSlug '%SENTINEL_BRANCH%' -ControlPlaneUrl '%SENTINEL_URL%'"
) else (
  "%PS%" -NoProfile -ExecutionPolicy Bypass -Command "& ([scriptblock]::Create((irm '%SENTINEL_URL%/v1/enroll/bootstrap.ps1'))) -ControlPlaneUrl '%SENTINEL_URL%'"
)

set "RC=%ERRORLEVEL%"

echo.
if "%RC%"=="0" (
  echo   == DONE ============================================================
  echo   Enrollment finished. This machine should appear in the Command Center
  echo   within a minute.
) else (
  echo   == THE INSTALLER STOPPED ===========================================
  echo   bootstrap.ps1 exited with code %RC%.
  echo.
  echo   The reason is in its own output above - scroll up. This file only
  echo   downloaded and started it, so there is nothing more it can tell you.
  echo.
  echo   If nothing at all appeared above, the download itself failed. Check:
  echo     - is this laptop online? Open %SENTINEL_URL%/healthz in a browser.
  echo     - a free-tier host can take ~50 seconds to wake from idle.
)

echo.
goto :done

:stopped
echo.
echo   Stopped. Nothing was downloaded and nothing on this machine changed.
set "RC=1"

:done
rem Always pause. Double-clicked, this window closes the instant the script
rem ends, and a window that vanishes on an error is indistinguishable from
rem one that did nothing at all.
echo.
pause
endlocal & exit /b %RC%
