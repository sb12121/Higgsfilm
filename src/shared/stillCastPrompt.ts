import type { ScriptLine, StillCastLibraryFolder } from './types'
import {
  type StillCastLineBeats,
  applyStillCastBeatsToLine,
  resolveStillCastFolder,
} from './stillCast'

export function buildStillCastPrompt(input: {
  paragraphLines: ScriptLine[]
  targetLines: ScriptLine[]
  folders: StillCastLibraryFolder[]
}): string {
  const lineBlock = input.paragraphLines
    .map(
      (line) =>
        `${line.id === input.targetLines.find((target) => target.id === line.id)?.id ? 'TARGET ' : ''}LINE ${line.index + 1} [${line.id}]: ${line.text}`,
    )
    .join('\n')
  const expressions = input.folders.filter((folder) => folder.kind !== 'custom')
  const catalog = expressions.map((folder) => `- ${folder.folderName}`).join('\n')
  const talking = expressions.filter((folder) =>
    /talk|neutral/i.test(`${folder.id} ${folder.folderName}`),
  )
  const talkingHint =
    talking.length > 1
      ? `For plain explanation and lists, use or alternate these talking stills: ${talking.map((folder) => folder.folderName).join(', ')}.`
      : talking.length === 1
        ? `Use ${talking[0]!.folderName} for plain explanation and lists.`
        : 'Use the calmest available expression for plain explanation.'

  return [
    'You are casting still images for a narrator video. The same character appears in every frame.',
    'Each TARGET line is already one visual beat. Do not split or rewrite the line. Choose exactly one folder name per TARGET line.',
    'Choose from this expression list. Use the folder name as the expression value:',
    catalog || '- Neutral Talking',
    talkingHint,
    'Put talking or neutral stills on longer holds and lists. Save stronger faces for punches, jokes, and turns. Do not repeat the same expression twice in a row unless no better folder exists.',
    'If a line already has a Custom scene picture, that comes from the script prefix. Always pick a talking-head expression here.',
    'Return JSON only, no markdown:',
    '{ "lines": [ { "lineId": "...", "expression": "Warm Smile" } ] }',
    'Include every TARGET line id. Do not invent line ids. Do not invent folder names.',
    '',
    'STANZA LINES:',
    lineBlock,
  ].join('\n')
}

export function parseStillCastResponse(
  text: string,
  expectedLines: ScriptLine[],
  folders: StillCastLibraryFolder[] = [],
): StillCastLineBeats[] {
  const payload = parseJsonObject(text)
  const rows = Array.isArray(payload.lines) ? payload.lines : Array.isArray(payload) ? payload : []
  const byId = new Map(expectedLines.map((line) => [line.id, line]))
  const parsed = new Map<string, string>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const raw = row as { lineId?: unknown; expression?: unknown; beats?: unknown }
    const lineId = typeof raw.lineId === 'string' ? raw.lineId.trim() : ''
    if (!byId.has(lineId)) continue
    let expression = typeof raw.expression === 'string' ? raw.expression : ''
    if (!expression && Array.isArray(raw.beats) && raw.beats[0] && typeof raw.beats[0] === 'object') {
      const beat = raw.beats[0] as { expression?: unknown }
      expression = typeof beat.expression === 'string' ? beat.expression : ''
    }
    parsed.set(lineId, resolveStillCastFolder(expression, folders)?.id || expression)
  }

  return expectedLines.map((line) => {
    const expression = parsed.get(line.id) || resolveStillCastFolder('neutral-talking', folders)?.id || 'neutral'
    return {
      lineId: line.id,
      beats: applyStillCastBeatsToLine(line, [{ text: line.text, expression }], folders).map((beat) => ({
        text: beat.text,
        expression: beat.expression,
      })),
    }
  })
}

function parseJsonObject(text: string): Record<string, unknown> {
  const trimmed = text.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fenced?.[1]?.trim() || trimmed
  const start = source.indexOf('{')
  const end = source.lastIndexOf('}')
  if (start < 0 || end <= start) {
    throw new Error('Still-cast response did not contain JSON.')
  }
  const parsed = JSON.parse(source.slice(start, end + 1)) as unknown
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Still-cast response was not a JSON object.')
  }
  return parsed as Record<string, unknown>
}
