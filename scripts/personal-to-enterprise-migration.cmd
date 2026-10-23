@echo off
setlocal

rem Personal to enterprise migration launcher for Windows.
rem With no arguments, the TypeScript CLI auto-detects Windows paths.
set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT="
set "EXIT_CODE=0"

rem Support a checked-out project and scripts copied into a project subdirectory.
for %%D in ("%SCRIPT_DIR%" "%SCRIPT_DIR%.." "%SCRIPT_DIR%..\.." "%SCRIPT_DIR%..\..\..") do (
  if not defined PROJECT_ROOT if exist "%%~fDpackage.json" if exist "%%~fDscripts\personal-to-enterprise-migration.ts" set "PROJECT_ROOT=%%~fD"
)
if not defined PROJECT_ROOT (
  echo This launcher is not standalone.
  echo It must be kept inside the complete MEA Cowork source project.
  echo Required files: package.json and scripts\personal-to-enterprise-migration.ts
  echo Copy the whole project, then run this file from its scripts directory.
  set "EXIT_CODE=1"
  goto :finish
)

where pnpm >nul 2>&1
if errorlevel 1 (
  echo pnpm was not found. Install pnpm or run this command from a Node.js environment.
  set "EXIT_CODE=1"
  goto :finish
)

pushd "%PROJECT_ROOT%"
if errorlevel 1 (
  echo Could not open the project directory: "%PROJECT_ROOT%"
  set "EXIT_CODE=1"
  goto :finish
)

pnpm --dir "%PROJECT_ROOT%" exec tsx scripts/personal-to-enterprise-migration.ts %*
set "EXIT_CODE=%ERRORLEVEL%"
popd

:finish
if "%MEACOWORK_MIGRATION_NO_PAUSE%"=="1" goto :end

echo.
if "%EXIT_CODE%"=="0" (
  echo Migration command finished successfully.
) else (
  echo Migration command failed with exit code %EXIT_CODE%.
)
pause

:end
exit /b %EXIT_CODE%
