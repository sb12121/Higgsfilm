# Higgsfilm Studio

Higgsfilm is a local-first Windows desktop prototype for turning narration and creative briefs into approved visual scenes and mastered video exports.

## Current prototype

- Electron + React + TypeScript desktop shell
- Portable project folders with a `higgsfilm.json` manifest
- `.txt`/`.md` script import and sentence splitting
- Paste script text directly into the Script & voice workspace
- Teleprompter-style per-line microphone recording with a 3-second lead-in and Enter/Escape controls
- Editable visual bible and scene prompts
- ChatGPT creative copilot through the official locally authenticated Codex CLI
- Server-side Higgsfield image generation adapter
- Windows-encrypted Higgsfield credentials
- Local FFmpeg longform export at 1920×1080 / 30 fps
- Dialogue-first loudness normalization at -16 LUFS

## Run locally

```bash
npm install
npm run dev
```

The development environment expects `ffmpeg` to be available on `PATH`. You can set `FFMPEG_PATH` to a full executable path when needed.

## Higgsfield setup

Create API credentials in Higgsfield Cloud, then open **Connection settings** in the app. The key ID and secret are stored through Electron's Windows `safeStorage`; the renderer never receives the secret.

The initial adapter uses the documented asynchronous REST lifecycle:

1. Submit an image prompt to the configured model endpoint.
2. Store the returned request ID and status URL.
3. Poll until the request completes.
4. Download the output into the selected project folder.

The default REST endpoint is `higgsfield-ai/soul/v2/standard`, matching the current
Higgsfield API documentation. The visual bible and prompts are tuned for stickman and
cartoon scene generation. Keep the adapter configurable as Higgsfield model identifiers
evolve. REST API endpoint names differ from Higgsfield CLI model IDs.

## ChatGPT creative copilot

Higgsfilm uses the official Codex CLI for ChatGPT-authenticated text generation. This keeps OAuth and
refresh credentials inside Codex's own secure session rather than copying private tokens into the app.

```bash
codex login
codex login status
```

After Codex reports that it is logged in with ChatGPT, use the **Creative copilot** card on the
production board. Higgsfilm requests `gpt-5.6-luna` with `max` reasoning, and runs Codex in a
read-only, ephemeral mode for planning and prompt drafts. Override those defaults with
`CODEX_MODEL` or `CODEX_REASONING_EFFORT` if your account exposes different model names.

## Project layout

```text
MyVideoProject/
  higgsfilm.json
  script.txt
  scenes/
    001/
      voice.webm
      image-01.jpg
  exports/
```

## Next milestones

- Image storyboard approval and variant comparison
- Multitrack music, SFX, and deterministic text overlays
- Scene graph and agent approval checkpoints
- Higgsfield video-generation adapter
- 30-second 9:16 short export
- Windows packaging with a bundled FFmpeg build
