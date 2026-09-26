import type {
  ContinuityCanon,
  SceneDirectionRecord,
  SceneLedgerEntry,
  ScriptLine,
} from './types'

export interface SceneValidationContext {
  canon?: ContinuityCanon
  acceptedLedger?: SceneLedgerEntry[]
  narration: string
}

export interface ParsedSceneDirection {
  record: SceneDirectionRecord
  warnings: string[]
}

export class SceneBatchValidationError extends Error {
  readonly invalidLineIds: string[]
  readonly validRecords: SceneDirectionRecord[]

  constructor(
    message: string,
    invalidLineIds: string[],
    validRecords: SceneDirectionRecord[],
  ) {
    super(message)
    this.name = 'SceneBatchValidationError'
    this.invalidLineIds = invalidLineIds
    this.validRecords = validRecords
  }
}

export function parseSceneDirectionResponse(
  text: string,
  expectedLine: ScriptLine,
  sourceFingerprint: string,
  context: SceneValidationContext,
): ParsedSceneDirection {
  const payload = parseJsonDocument(text)
  if (Array.isArray(payload)) {
    throw new Error(`Scene ${expectedLine.index + 1} returned multiple directions instead of one.`)
  }
  if (!isRecord(payload)) {
    const direction = normalizeSceneDirectionText(text)
    if (!direction) {
      throw new Error(`Scene ${expectedLine.index + 1} returned an empty visual direction.`)
    }
    if (direction.length < 30) {
      throw new Error(`Scene ${expectedLine.index + 1} returned a visual direction that is too short.`)
    }
    const record: SceneDirectionRecord = {
      version: 1,
      lineId: expectedLine.id,
      sourceFingerprint,
      direction,
    }
    return {
      record,
      warnings: validateSceneDirection(record, context),
    }
  }

  const record = parseSceneRecordPayload(payload, expectedLine, sourceFingerprint)
  return {
    record,
    warnings: validateSceneDirection(record, context),
  }
}

export function parseSceneDirectionBatchResponse(
  text: string,
  expectedLines: ScriptLine[],
  sourceFingerprint: string,
  context: SceneValidationContext,
): SceneDirectionRecord[] {
  const payload = parseJsonDocument(text)
  if (!isRecord(payload) || !Array.isArray(payload.scenes)) {
    throw new Error('Paragraph batch did not return a scenes array.')
  }
  if (payload.scenes.length !== expectedLines.length) {
    throw new Error(
      `Paragraph batch returned ${payload.scenes.length} scene(s); expected exactly ${expectedLines.length}.`,
    )
  }

  const expectedById = new Map(expectedLines.map((line) => [line.id, line]))
  const seenIds = new Set<string>()
  const parsedById = new Map<string, SceneDirectionRecord>()
  const errors: string[] = []
  const invalidLineIds = new Set<string>()

  for (const row of payload.scenes) {
    if (!isRecord(row)) {
      errors.push('One batch item was not an object.')
      continue
    }
    const lineId = stringValue(row.lineId)
    if (!lineId || !expectedById.has(lineId)) {
      errors.push(`The batch returned an unknown line ID "${lineId || 'missing'}".`)
      continue
    }
    if (seenIds.has(lineId)) {
      errors.push(`The batch returned duplicate line ID "${lineId}".`)
      invalidLineIds.add(lineId)
      continue
    }
    seenIds.add(lineId)
    const line = expectedById.get(lineId)!
    try {
      const record = parseSceneRecordPayload(row, line, sourceFingerprint)
      parsedById.set(lineId, record)
    } catch (error) {
      invalidLineIds.add(lineId)
      errors.push(error instanceof Error ? error.message : `Scene ${line.index + 1} was invalid.`)
    }
  }

  const missingIds = expectedLines
    .map((line) => line.id)
    .filter((lineId) => !seenIds.has(lineId))
  if (missingIds.length > 0) {
    errors.push(`The batch omitted line ID(s): ${missingIds.join(', ')}.`)
    missingIds.forEach((lineId) => invalidLineIds.add(lineId))
  }
  const validIds = new Set<string>()
  for (const line of expectedLines) {
    const record = parsedById.get(line.id)
    if (!record) continue
    validIds.add(line.id)
  }
  if (errors.length > 0) {
    const validRecords = expectedLines
      .filter((line) => validIds.has(line.id) && !invalidLineIds.has(line.id))
      .map((line) => parsedById.get(line.id)!)
    throw new SceneBatchValidationError(
      `Paragraph batch failed validation: ${errors.join(' ')}`,
      [...invalidLineIds],
      validRecords,
    )
  }

  return expectedLines.map((line) => parsedById.get(line.id)!)
}

function parseSceneRecordPayload(
  payload: Record<string, unknown>,
  expectedLine: ScriptLine,
  sourceFingerprint: string,
): SceneDirectionRecord {
  const returnedLineId = stringValue(payload.lineId).trim()
  if (returnedLineId && returnedLineId !== expectedLine.id) {
    throw new Error(`Scene ${expectedLine.index + 1} returned the wrong line ID.`)
  }

  const sceneValue = isRecord(payload.scene)
    ? payload.scene
    : isRecord(payload.record)
      ? payload.record
      : isRecord(payload.sceneRecord)
        ? payload.sceneRecord
        : payload
  const direction = normalizeSceneDirectionText(
    stringValue(
      sceneValue.direction ||
        sceneValue.prompt ||
        sceneValue.sceneDescription ||
        payload.direction ||
        payload.prompt,
    ),
  )
  if (!direction) {
    throw new Error(`Scene ${expectedLine.index + 1} returned an empty visual direction.`)
  }
  if (direction.length < 30) {
    throw new Error(`Scene ${expectedLine.index + 1} returned a visual direction that is too short.`)
  }

  return {
    version: 1,
    lineId: expectedLine.id,
    sourceFingerprint,
    direction,
    ...optionalSceneMetadata(sceneValue),
  }
}

function optionalSceneMetadata(value: Record<string, unknown>): Partial<SceneDirectionRecord> {
  const metadata: Partial<SceneDirectionRecord> = {}
  const focalSubject = stringValue(value.focalSubject).trim()
  const visualAction = stringValue(value.visualAction).trim()
  const shotType = stringValue(value.shotType).trim()
  const setting = stringValue(value.setting).trim()
  const propState = stringValue(value.propState).trim()
  const variationReason = stringValue(value.variationReason).trim()
  const visibleCharacters = stringArray(value.visibleCharacters)
  const visibleProps = stringArray(value.visibleProps)

  if (focalSubject) metadata.focalSubject = focalSubject
  if (visualAction) metadata.visualAction = visualAction
  if (shotType) metadata.shotType = shotType
  if (setting) metadata.setting = setting
  if (visibleCharacters.length > 0) metadata.visibleCharacters = visibleCharacters
  if (visibleProps.length > 0) metadata.visibleProps = visibleProps
  if (propState) metadata.propState = propState
  if (variationReason) metadata.variationReason = variationReason
  return metadata
}

export function validateSceneDirection(
  record: SceneDirectionRecord,
  context: SceneValidationContext,
): string[] {
  const warnings: string[] = []
  const direction = record.direction.trim()
  const normalizedDirection = normalizeForComparison(direction)
  const normalizedNarration = normalizeForComparison(context.narration)

  if (record.version !== 1) warnings.push('The scene record version is unsupported.')
  if (!record.lineId.trim()) warnings.push('The scene record is missing its line ID.')
  if (!record.sourceFingerprint.trim()) {
    warnings.push('The scene record is missing its source fingerprint.')
  }
  if (direction.length < 30) {
    warnings.push('The scene direction is too short to render independently.')
  }
  if (statedSceneCharacterCount(direction) === undefined) {
    warnings.push(
      'The scene direction should state the exact character count as "Exactly N characters" with N from 0 to 3.',
    )
  }
  if (sceneExceedsCharacterCap(direction, record.visibleCharacters)) {
    warnings.push('The scene direction includes more than three characters.')
  }
  if (normalizedNarration.length > 24 && normalizedDirection.includes(normalizedNarration)) {
    warnings.push('The scene direction copies the narration instead of interpreting it visually.')
  }
  if (/\n\s*(?:style|characters|setting|palette|camera|avoid)\s*:/i.test(direction)) {
    warnings.push('The scene direction contains a copied visual-bible block.')
  }
  if (
    /\b(?:the same|same as before|as before|recurring character|recurring subject|familiar character|previous scene|earlier scene)\b/i.test(
      direction,
    )
  ) {
    warnings.push('The scene direction uses vague continuity shorthand.')
  }
  if (
    /\b(?:he|she|they|them|his|her|their|him|it|its|this|that|these|those)\b/i.test(
      direction,
    )
  ) {
    warnings.push('The scene direction contains a pronoun that may need concrete resolution.')
  }
  if (/[?→←💭]/u.test(direction)) {
    warnings.push('The scene direction contains an unexplained symbol or overlay.')
  }

  const canonSubject = context.canon?.subject.trim()
  if (canonSubject) {
    const subjectWords = meaningfulWords(canonSubject)
    const sceneMentionsAnAnimal =
      /\b(?:dog|puppy|retriever|animal|cat|kitten|horse|bird|rabbit)\b/i.test(
        `${record.focalSubject || ''} ${record.visualAction || ''} ${direction}`,
      )
    const missingSubjectWords = subjectWords.filter(
      (word) => !normalizedDirection.includes(word),
    )
    if (sceneMentionsAnAnimal && subjectWords.length > 0 && missingSubjectWords.length > 0) {
      warnings.push(
        'The scene direction changes the established animal identity or omits its concrete appearance.',
      )
    }
  }

  const action = `${record.focalSubject || ''} ${record.visualAction || ''}`.toLowerCase()
  const animalMentioned = /\b(?:dog|puppy|retriever|animal|cat|horse)\b/.test(action)
  const carryVerb =
    /\b(?:carry|carries|carrying|retrieve|retrieves|retrieving|bring|brings|bringing|fetch|fetches|fetching|hold|holds|holding|pick up|picks up|pickup)\b/.test(
      action,
    )
  const animalCarryPlanned = animalMentioned && carryVerb
  const animalCarryMentioned = /\b(?:dog|puppy|retriever|animal|cat|horse)\b\s+(?:is\s+)?(?:carrying|retrieving|bringing|fetching|holding|carries|retrieves|brings|fetches|holds)\b/i.test(
    direction,
  )
  const animalMouthCarry =
    /\b(?:dog|puppy|retriever|animal|cat|horse)\b[\s\S]{0,160}\b(?:carry|carries|carrying|retrieve|retrieves|retrieving|bring|brings|bringing|fetch|fetches|fetching|hold|holds|holding)\b[\s\S]{0,100}\b(?:mouth|jaws|teeth)\b/i.test(
      direction,
    ) ||
    /\b(?:mouth|jaws|teeth)\b[\s\S]{0,80}\b(?:holds|grips|clamps|carries|carrying|retrieves|retrieving|brings|bringing|fetches|fetching|between)\b/i.test(
      direction,
    ) ||
    /\b(?:clamped|gripped|grips)\b[\s\S]{0,40}\b(?:teeth|mouth|jaws)\b/i.test(direction)
  const animalMouthAction =
    /\b(?:dog|puppy|retriever|animal|cat|horse)\b[\s\S]{0,120}\b(?:mouth|jaws|teeth)\b[\s\S]{0,80}\b(?:holds|grips|clamps|carries|carrying|retrieves|retrieving|brings|bringing|fetches|fetching|around|between)\b/i.test(
      direction,
    ) ||
    /\b(?:in|between|from)\s+(?:the\s+)?(?:dog|puppy|retriever|animal|cat|horse)(?:'s)?\s+(?:mouth|jaws|teeth)\b/i.test(
      direction,
    )
  if (animalCarryPlanned && !animalMouthCarry) {
    warnings.push('An animal carrying an object should carry it visibly in its natural mouth or jaws.')
  }
  if (!animalCarryPlanned && (animalCarryMentioned || animalMouthAction)) {
    warnings.push(
      'The direction may invent an animal carrying or mouth action that the planned action does not call for.',
    )
  }
  if (
    /\b(?:animal|dog|puppy|retriever|cat|horse)\b[\s\S]{0,120}\b(?:human arms?|human hands?|extra arms?|extra hands?|upright)\b/i.test(
      direction,
    )
  ) {
    warnings.push('The scene direction requests human or extra anatomy for an animal.')
  }

  const recent = context.acceptedLedger?.slice(-3) || []
  const previous = recent[recent.length - 1]
  if (previous) {
    if (record.direction.trim().toLowerCase() === previous.direction.trim().toLowerCase()) {
      warnings.push('The scene direction exactly repeats an earlier accepted direction.')
    }
  }

  return warnings
}

const CAST_COUNT_WORDS: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  '0': 0,
  '1': 1,
  '2': 2,
  '3': 3,
}

const STATED_CAST_PATTERN =
  /\bexactly\s+(zero|one|two|three|0|1|2|3)\s+characters?\b/i

export function statedSceneCharacterCount(text: string): number | undefined {
  const match = text.match(STATED_CAST_PATTERN)
  if (!match?.[1]) return undefined
  return CAST_COUNT_WORDS[match[1].toLowerCase()]
}

export function sceneExceedsCharacterCap(
  direction: string,
  visibleCharacters?: string[],
): boolean {
  if ((visibleCharacters?.length || 0) > 3) return true
  return /\bexactly\s+(?:four|five|six|seven|eight|nine|ten|[4-9]|\d{2,})\s+characters?\b/i.test(
    direction,
  )
}

export function sceneLedgerEntry(
  line: ScriptLine,
  record: SceneDirectionRecord,
): SceneLedgerEntry {
  return {
    lineId: line.id,
    lineIndex: line.index,
    direction: record.direction,
    focalSubject: record.focalSubject,
    visualAction: record.visualAction,
    shotType: record.shotType,
    setting: record.setting,
    propState: record.propState,
    variationReason: record.variationReason,
  }
}

export function parseContinuityCanonResponse(
  text: string,
  sourceFingerprint: string,
): ContinuityCanon {
  const payload = parseJsonDocument(text)
  const summary = isRecord(payload)
    ? stringValue(payload.summary || payload.continuityCanon || payload.canon)
    : ''
  const plainSummary = summary || normalizePlainSummary(text)
  const object = isRecord(payload) ? payload : {}
  return {
    version: 1,
    sourceFingerprint,
    summary: plainSummary.slice(0, 6000),
    subject: stringValue(object.subject || object.recurringSubject),
    cast: stringArray(object.cast || object.characters),
    locations: stringArray(object.locations || object.settings),
    props: stringArray(object.props || object.importantProps),
    visualMotifs: stringArray(object.visualMotifs || object.motifs),
  }
}

export function compactLedger(ledger: SceneLedgerEntry[]): string {
  if (ledger.length === 0) return 'No earlier scene has been accepted yet.'
  return ledger
    .map(
      (entry) =>
        `SCENE ${entry.lineIndex + 1} (${entry.lineId}): ${entry.direction}`,
    )
    .join('\n')
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
    : []
}

export function normalizeSceneDirectionText(value: string): string {
  return value
    .trim()
    .replace(/^```(?:text|plaintext|markdown)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .replace(/^#{1,6}\s*(?:visual\s+)?(?:scene\s+)?(?:direction|prompt)\s*:?\s*/i, '')
    .replace(/^(?:visual\s+)?(?:scene\s+)?(?:direction|prompt)\s*:\s*/i, '')
    .replace(/^["“](.*)["”]$/s, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

function normalizePlainSummary(value: string): string {
  return value
    .replace(/```(?:json|text|plaintext|markdown)?/gi, '')
    .replace(/```/g, '')
    .replace(/^(?:summary|continuity canon|script summary)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function meaningfulWords(value: string): string[] {
  return normalizeForComparison(value)
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !/^(?:the|and|with|from|main|subject)$/.test(word))
}

function normalizeForComparison(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseJsonDocument(text: string): unknown {
  const trimmed = text.trim()
  const candidates = [
    trimmed.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, ''),
    sliceJson(trimmed, '{', '}'),
    sliceJson(trimmed, '[', ']'),
  ].filter((candidate) => candidate.length > 1)

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate)
    } catch {
      // Try the next JSON boundary if the model added a short preamble.
    }
  }
  return null
}

function sliceJson(value: string, startToken: string, endToken: string): string {
  const start = value.indexOf(startToken)
  const end = value.lastIndexOf(endToken)
  return start >= 0 && end > start ? value.slice(start, end + 1) : ''
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}
