const DEFAULT_WORDS_PER_MINUTE = 150

function stripLeadingTimestamp(value: string): string {
  return value
    .replace(
      /^\s*(?:\[\s*)?(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\s*[-–—]\s*\d{1,2}:\d{2})?(?:\s*\])?\s*/,
      '',
    )
    .trim()
}

function splitWithRegex(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9“"'])/)
    .map((part) => part.trim())
    .filter(Boolean)
}

export interface ParsedScriptLine {
  text: string
  paragraphIndex: number
}

export function splitIntoSentences(script: string): string[] {
  const normalized = script.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  const Segmenter = (
    Intl as typeof Intl & {
      Segmenter?: new (
        locales?: string | string[],
        options?: { granularity: 'sentence' },
      ) => { segment: (value: string) => Iterable<{ segment: string }> }
    }
  ).Segmenter

  const segments = Segmenter
    ? Array.from(new Segmenter('en', { granularity: 'sentence' }).segment(normalized)).map(
        ({ segment }) => segment,
      )
    : splitWithRegex(normalized)

  const cleaned = segments
    .map((segment) => stripLeadingTimestamp(segment.replace(/\s+/g, ' ').trim()))
    .filter(Boolean)

  return cleaned.length > 0 ? cleaned : splitWithRegex(normalized)
}

export type ScriptLineMode = 'sentences' | 'stanzas'

export function splitIntoScriptLines(script: string): ParsedScriptLine[] {
  const normalized = script.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  return normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .flatMap((paragraph, paragraphIndex) =>
      splitIntoSentences(paragraph).map((text) => ({ text, paragraphIndex })),
    )
}

export function splitIntoStanzaLines(script: string): ParsedScriptLine[] {
  const normalized = script.replace(/\r\n/g, '\n').trim()
  if (!normalized) return []

  // Expression stills: every newline is one scene, one still, and one recording take.
  // Trailing commas are spoken punctuation only — they do not merge lines into a shared stanza.
  return normalized
    .split('\n')
    .map((line) => stripLeadingTimestamp(line.replace(/\s+/g, ' ').trim()))
    .filter(Boolean)
    .map((text, paragraphIndex) => ({ text, paragraphIndex }))
}

export function splitScript(script: string, mode: ScriptLineMode = 'sentences'): ParsedScriptLine[] {
  return mode === 'stanzas' ? splitIntoStanzaLines(script) : splitIntoScriptLines(script)
}

export function estimateTimeline(
  sentences: string[],
  wordsPerMinute = DEFAULT_WORDS_PER_MINUTE,
): Array<{ startTime: number; endTime: number; duration: number }> {
  const secondsPerWord = 60 / Math.max(wordsPerMinute, 60)
  let cursor = 0

  return sentences.map((sentence) => {
    const wordCount = sentence.split(/\s+/).filter(Boolean).length
    const duration = Math.max(0.8, Number((wordCount * secondsPerWord).toFixed(2)))
    const startTime = Number(cursor.toFixed(2))
    const endTime = Number((cursor + duration).toFixed(2))
    cursor = endTime

    return { startTime, endTime, duration }
  })
}

export function secondsToTimestamp(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(wholeSeconds / 60)
  const remainder = wholeSeconds % 60
  return `${String(minutes).padStart(2, '0')}-${String(remainder).padStart(2, '0')}`
}
