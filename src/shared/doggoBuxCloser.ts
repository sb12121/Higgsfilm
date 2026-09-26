import { parseStillCastScriptLine } from './stillCast'

export const DOGGOBUX_SCRIPT_CLOSER = [
  "Custom: If Bux's mistake helped you understand this, like the video and tell us what you learned. | Full body, Bux smiles and holds a paper thumbs-up beside a comment card.",
  'Custom: Subscribe to see what Bux figures out next. | Full body, Bux points toward the viewer beside a paper Subscribe tag.',
  "Custom: And watch this next video to learn from another one of Bux's mistakes. | Full body, Bux points at a paper next-video card.",
] as const

const TRAILING_OUTRO_PATTERN =
  /\b(?:subscribe|like the video|leave a comment|terrible money decision|look at this video|watch this video|more terrible money)\b/i

export function isDoggoBuxChannel(channelName?: string, scriptBible?: string): boolean {
  return (
    /doggo|bux/i.test(channelName || '') ||
    /character is always bux|always use the name bux/i.test(scriptBible || '')
  )
}

export function ensureDoggoBuxScriptCloser(script: string): string {
  const normalized = script.replace(/\r\n/g, '\n').trim()
  if (!normalized) return script
  if (scriptEndsWithDoggoBuxCloser(normalized)) return normalized
  const withoutLlmOutro = stripTrailingChannelOutro(normalized)
  if (!withoutLlmOutro) return DOGGOBUX_SCRIPT_CLOSER.join('\n')
  return `${withoutLlmOutro}\n\n${DOGGOBUX_SCRIPT_CLOSER.join('\n')}`
}

export function scriptEndsWithDoggoBuxCloser(script: string): boolean {
  const spoken = spokenLines(script)
  if (spoken.length < DOGGOBUX_SCRIPT_CLOSER.length) return false
  const tail = spoken.slice(-DOGGOBUX_SCRIPT_CLOSER.length)
  return closerSpokenLines().every((expected, index) => tail[index] === expected)
}

function stripTrailingChannelOutro(script: string): string {
  const rawLines = script.replace(/\r\n/g, '\n').split('\n')
  while (rawLines.length > 0) {
    const last = rawLines[rawLines.length - 1]!.trim()
    if (!last) {
      rawLines.pop()
      continue
    }
    const spoken = parseStillCastScriptLine(last).text
    if (TRAILING_OUTRO_PATTERN.test(spoken) || closerSpokenLines().includes(normalizeSpoken(spoken))) {
      rawLines.pop()
      continue
    }
    break
  }
  return rawLines.join('\n').trim()
}

function spokenLines(script: string): string[] {
  return script
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeSpoken(parseStillCastScriptLine(line).text))
}

function closerSpokenLines(): string[] {
  return DOGGOBUX_SCRIPT_CLOSER.map((line) => normalizeSpoken(parseStillCastScriptLine(line).text))
}

function normalizeSpoken(value: string): string {
  return value
    .trim()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, ' ')
    .toLowerCase()
}
