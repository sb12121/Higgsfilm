# Higgsfilm setup

Higgsfilm is a local Windows app. There is no installer. Copy this whole folder to the other computer, install the tools below, then start the app from this folder.

Episode projects, guides, and the Bux expression library live inside this folder (`DoggoBux` and each project’s `higgsfilm.json`). They move with the copy.

## What does not move with the folder

- The ChatGPT login. Sign in again on the new computer.
- App settings. They are stored at `%APPDATA%\higgsfilm\higgsfilm-settings.json` and contain absolute paths from the old computer. Re-pick those paths in Settings after the first launch, or edit the copied settings file so every path points at this folder on the new machine.

## Install

1. Install [Node.js](https://nodejs.org/) (current LTS). `node` and `npm` must work in a new terminal.
2. Install [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) full build and add its `bin` folder to PATH. A new terminal must run `ffmpeg -version`.
3. Install the Codex CLI and confirm `codex` works in a new terminal:

   ```bash
   npm install -g @openai/codex
   codex --version
   ```

4. In this folder:

   ```bash
   npm install
   npm run dev
   ```

`FFMPEG_PATH` can be set to the full `ffmpeg.exe` path when FFmpeg is not on PATH.

## First launch

1. In the app, sign in to ChatGPT with the Codex login. On this computer, run `codex login` if you prefer the terminal. `codex login status` should report that ChatGPT is logged in.
2. Open Settings and set:
   - Channel folder
   - Expression library
   - Custom-image guide
   - Character sheet
   - Face and style references
   - Expression guide and shared expression background
3. Open a project by choosing its folder. Projects stay inside this Higgsfilm folder.

Per-step model settings (Astra, Sol, or Luna, reasoning, Fast or Standard) are in that settings file. Image drawing still happens inside Codex image generation. The step setting only chooses the model that calls the image tool.

## Optional tools

QWEN paragraph alignment needs Python and the local Whisper bridge:

```bash
python -m pip install -r scripts/requirements-qwen-align.txt
```

Set `QWEN_ALIGNMENT_PYTHON` when the Python you want is not the `python` command on PATH.

Higgsfield image generation uses credentials entered in Connection settings. Those secrets stay in the Windows credential store on each computer.

## Hand this folder to an agent

```text
This folder is Higgsfilm, a local Electron app. Install what it needs and start it.
- Install Node.js, FFmpeg on PATH, and the Codex CLI (`npm install -g @openai/codex`).
- In this folder run npm install, then npm run dev.
- Do not change project files under DoggoBux.
Settings live in %APPDATA%\higgsfilm\higgsfilm-settings.json. I will sign in to ChatGPT in the app myself and set the channel, expression, character sheet, and guide paths after it opens.
```
