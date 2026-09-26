import { DOGGOBUX_SCRIPT_CLOSER } from './doggoBuxCloser'
import { parseStillCastScriptLine } from './stillCast'

export interface ScriptDraftReview {
  spokenText: string
  spokenWordCount: number
  sceneCount: number
  estimatedSeconds: number
  issues: Array<{ lineNumber: number; severity: 'error' | 'warning'; message: string }>
  canApply: boolean
}

export function reviewScriptDraft(
  script: string,
  options: { customOnly?: boolean } = {},
): ScriptDraftReview {
  const customOnly = Boolean(options.customOnly)
  const issues: ScriptDraftReview['issues'] = []
  const spokenLines: Array<{ lineNumber: number; text: string; isCloser: boolean }> = []
  const lines = script.replace(/\r\n/g, '\n').split('\n')
  const closerLines = new Set(
    DOGGOBUX_SCRIPT_CLOSER.map((line) => normalizeSpoken(parseStillCastScriptLine(line).text)),
  )
  let sceneCount = 0

  lines.forEach((sourceLine, index) => {
    const line = sourceLine.trim()
    if (!line) return
    const lineNumber = index + 1
    if (/^```/.test(line) || /^#{1,6}\s/.test(line)) {
      if (customOnly) {
        issues.push({ lineNumber, severity: 'error', message: 'Remove markdown headings and code fences from the script.' })
      }
      return
    }

    sceneCount += 1
    const isCustomLine = /^Custom\s*:/i.test(line)
    const hasAnyPrefix = /^[^:]{1,48}:/.test(line)
    if (customOnly && !isCustomLine) {
      issues.push({
        lineNumber,
        severity: 'error',
        message: hasAnyPrefix ? 'Every line must use the Custom: prefix.' : 'Every line must start with Custom: .',
      })
    }

    const parsed = parseStillCastScriptLine(line)
    const isCustom = parsed.expression === 'custom'
    if (customOnly && isCustomLine) {
      const payload = line.replace(/^Custom\s*:/i, '').trim()
      const spokenBeforeNote = payload.split('|', 1)[0]?.trim() || ''
      if (!spokenBeforeNote) {
        issues.push({ lineNumber, severity: 'error', message: 'Add spoken narration before the shot note.' })
      }
      if (!parsed.shotNote) {
        issues.push({ lineNumber, severity: 'error', message: 'Add an unspoken shot note after |.' })
      }
    }

    const payload = isCustomLine ? line.replace(/^Custom\s*:/i, '').trim() : ''
    const fallbackSpoken = isCustomLine ? payload.split('|', 1)[0]?.trim() || '' : parsed.text
    const text = isCustom && parsed.shotNote ? parsed.text : fallbackSpoken
    if (text.trim()) {
      spokenLines.push({
        lineNumber,
        text: text.trim(),
        isCloser: closerLines.has(normalizeSpoken(text)),
      })
    }
  })

  const seen = new Set<string>()
  for (const line of spokenLines) {
    const normalized = normalizeSpoken(line.text)
    if (seen.has(normalized)) {
      issues.push({ lineNumber: line.lineNumber, severity: 'warning', message: 'This spoken line repeats an earlier line; it may be an intentional callback.' })
    } else {
      seen.add(normalized)
    }
    if (!line.isCloser && countWords(line.text) > 13) {
      issues.push({ lineNumber: line.lineNumber, severity: 'warning', message: 'This take is unusually long; consider splitting it into shorter spoken lines.' })
    }
  }

  const spokenText = spokenLines.map(({ text }) => text).join('\n')
  const spokenWordCount = countWords(spokenText)
  const hasErrors = issues.some(({ severity }) => severity === 'error')
  return {
    spokenText,
    spokenWordCount,
    sceneCount,
    estimatedSeconds: (spokenWordCount / 150) * 60,
    issues,
    canApply: spokenWordCount > 0 && !hasErrors,
  }
}

function countWords(text: string): number {
  return text.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu)?.length || 0
}

function normalizeSpoken(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLocaleLowerCase()
}
