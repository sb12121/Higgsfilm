#!/usr/bin/env python3
"""Return Whisper word timestamps for a generated QWEN paragraph.

The Electron process owns the alignment contract; this helper deliberately
returns only JSON so the model/runtime can be replaced without changing the
timeline code.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path


def write_result(value: dict) -> None:
    sys.stdout.write(json.dumps(value, ensure_ascii=False))
    sys.stdout.flush()


def main() -> int:
    try:
        request = json.loads(sys.stdin.read() or "{}")
        from faster_whisper import WhisperModel
    except Exception as error:  # pragma: no cover - exercised by the host
        write_result(
            {
                "ok": False,
                "error": (
                    "Install faster-whisper in the configured Python runtime "
                    f"before using QWEN alignment: {error}"
                ),
            }
        )
        return 1

    if request.get("mode") == "status":
        write_result(
            {
                "ok": True,
                "model": request.get("model", "small.en"),
                "message": "Whisper alignment runtime is available; the model downloads on first alignment.",
            }
        )
        return 0

    audio_path = Path(str(request.get("audioPath", "")))
    if not audio_path.is_file():
        write_result({"ok": False, "error": f"Audio file does not exist: {audio_path}"})
        return 1

    model_name = str(request.get("model", "small.en"))
    language = request.get("language") or None
    device = os.environ.get("QWEN_ALIGNMENT_DEVICE", "auto")
    if device == "auto":
        try:
            import torch

            device = "cuda" if torch.cuda.is_available() else "cpu"
        except Exception:
            device = "cpu"
    compute_type = os.environ.get(
        "QWEN_ALIGNMENT_COMPUTE_TYPE",
        "float16" if device == "cuda" else "int8",
    )

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
        segments, info = model.transcribe(
            str(audio_path),
            language=language,
            beam_size=5,
            word_timestamps=True,
            vad_filter=False,
            condition_on_previous_text=False,
        )
        words = []
        transcript_parts = []
        for segment in segments:
            if segment.text:
                transcript_parts.append(segment.text.strip())
            for word in segment.words or []:
                text = (word.word or "").strip()
                if not text:
                    continue
                words.append(
                    {
                        "text": text,
                        "start": float(word.start),
                        "end": float(word.end),
                        "confidence": float(getattr(word, "probability", 0.75)),
                    }
                )
        write_result(
            {
                "ok": True,
                "language": getattr(info, "language", None),
                "transcript": " ".join(transcript_parts),
                "words": words,
            }
        )
        return 0
    except Exception as error:  # pragma: no cover - exercised by the host
        write_result({"ok": False, "error": f"Whisper alignment failed: {error}"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
