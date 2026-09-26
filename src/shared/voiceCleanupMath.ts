export const SCENE_START_PADDING_SECONDS = 0.1
export const SCENE_END_PADDING_SECONDS = 0.1
export const MIN_SPEECH_WINDOW_SECONDS = 0.05

export function cleanedDurationFromWindow(
  trimStart: number,
  trimEnd: number,
  sceneStartPadding = SCENE_START_PADDING_SECONDS,
  sceneEndPadding = SCENE_END_PADDING_SECONDS,
): number {
  return Number(
    Math.max(0.1, trimEnd - trimStart + sceneStartPadding + sceneEndPadding).toFixed(2),
  )
}

export function clampVoiceTrimEnd(
  trimStart: number,
  trimEnd: number,
  sourceDuration: number,
): number {
  const minEnd = trimStart + MIN_SPEECH_WINDOW_SECONDS
  const maxEnd = Math.max(minEnd, sourceDuration)
  return Number(Math.min(maxEnd, Math.max(minEnd, trimEnd)).toFixed(3))
}

export function clampVoiceTrimStart(
  trimStart: number,
  trimEnd: number,
  sourceDuration: number,
): number {
  const maxStart = Math.max(0, Math.min(sourceDuration, trimEnd) - MIN_SPEECH_WINDOW_SECONDS)
  return Number(Math.min(maxStart, Math.max(0, trimStart)).toFixed(3))
}

/** Map a cleaned-timeline end (waveform handle) back to raw trimEnd. */
export function rawTrimEndFromCleanedEnd(
  cleanedEndSeconds: number,
  trimStart: number,
  sceneStartPadding = SCENE_START_PADDING_SECONDS,
  sceneEndPadding = SCENE_END_PADDING_SECONDS,
): number {
  const speechLength = Math.max(
    MIN_SPEECH_WINDOW_SECONDS,
    cleanedEndSeconds - sceneStartPadding - sceneEndPadding,
  )
  return Number((trimStart + speechLength).toFixed(3))
}

/** Map a cleaned-timeline start (waveform handle) back to raw trimStart. */
export function rawTrimStartFromCleanedStart(
  cleanedStartSeconds: number,
  currentTrimStart: number,
  sceneStartPadding = SCENE_START_PADDING_SECONDS,
): number {
  const speechCut = Math.max(0, cleanedStartSeconds - sceneStartPadding)
  return Number((currentTrimStart + speechCut).toFixed(3))
}
