@echo off
REM Start the shared ComfyUI portable install with the H3Film low-lag settings.
set "COMFY_ROOT=%~dp0..\ComfyUI_windows_portable"
cd /d "%COMFY_ROOT%"

if not exist "python_embeded\python.exe" (
  echo ComfyUI portable not found at:
  echo   %COMFY_ROOT%
  pause
  exit /b 1
)

REM Keep VRAM available for Windows and prefer NVMe-backed model offload.
set PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True
if exist "%COMFY_ROOT%\disable_quickedit.ps1" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%COMFY_ROOT%\disable_quickedit.ps1"
)

call "%COMFY_ROOT%\run_nvidia_gpu_sage_sol_fp16.bat"
