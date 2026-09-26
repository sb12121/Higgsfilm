export interface WhisperWord {
  text: string
  start: number
  end: number
  confidence?: number
}

export interface AlignmentLine {
  id: string
  text: string
}

export interface QwenLineCue {
  lineId: string
  start: number
  end: number
  confidence: number
  mismatchCount: number
}

export type QwenAlignmentSeverity = 'exact' | 'localized' | 'severe'

export interface QwenLineVerification {
  lineId: string
  expectedText: string
  transcriptText: string
  confidence: number
  mismatchCount: number
  missingCount: number
  extraCount: number
  substitutionCount: number
}

export interface QwenAlignmentResult {
  transcript: string
  expectedTranscript: string
  severity: QwenAlignmentSeverity
  editDistance: number
  mismatchRate: number
  cues: QwenLineCue[]
  lines: QwenLineVerification[]
}

export const QWEN_LINE_CONFIDENCE_THRESHOLD = 0.75

export function shouldUseQwenLineFallback(line: QwenLineVerification): boolean {
  return line.mismatchCount > 0 || line.confidence <= QWEN_LINE_CONFIDENCE_THRESHOLD
}

interface ExpectedToken {
  token: string
  lineId: string
  lineIndex: number
}

interface ActualToken {
  token: string
  sourceIndex: number
  word: WhisperWord
}

interface Match {
  expectedIndex: number
  actualIndex: number
  exact: boolean
}

interface Mismatch {
  type: 'missing' | 'extra' | 'substitution'
  expectedIndex?: number
  actualIndex?: number
}

const CONTRACTIONS: Record<string, string> = {
  "aren't": 'are not',
  "can't": 'can not',
  "couldn't": 'could not',
  "didn't": 'did not',
  "doesn't": 'does not',
  "don't": 'do not',
  "hadn't": 'had not',
  "hasn't": 'has not',
  "haven't": 'have not',
  "he'd": 'he would',
  "he'll": 'he will',
  "he's": 'he is',
  "i'd": 'i would',
  "i'll": 'i will',
  "i'm": 'i am',
  "i've": 'i have',
  "isn't": 'is not',
  "it'll": 'it will',
  "it's": 'it is',
  "let's": 'let us',
  "mustn't": 'must not',
  "she'd": 'she would',
  "she'll": 'she will',
  "she's": 'she is',
  "shouldn't": 'should not',
  "that's": 'that is',
  "there's": 'there is',
  "they'd": 'they would',
  "they'll": 'they will',
  "they're": 'they are',
  "they've": 'they have',
  "wasn't": 'was not',
  "we'd": 'we would',
  "we'll": 'we will',
  "we're": 'we are',
  "we've": 'we have',
  "weren't": 'were not',
  "what's": 'what is',
  "won't": 'will not',
  "wouldn't": 'would not',
  "you'd": 'you would',
  "you'll": 'you will',
  "you're": 'you are',
  "you've": 'you have',
}

const TOKEN_ALIASES: Record<string, string> = {
  buck: 'bux',
  bucks: 'bux',
  by: 'buy',
  bye: 'buy',
}

export function verifyQwenTranscript(
  lines: readonly AlignmentLine[],
  words: readonly WhisperWord[],
  duration: number,
  transcript = words.map((word) => word.text).join(' '),
): QwenAlignmentResult {
  const expectedTokens = lines.flatMap((line, lineIndex) =>
    tokenize(line.text).map((token) => ({
      token,
      lineId: line.id,
      lineIndex,
    })),
  )
  const actualTokens = words.flatMap((word, sourceIndex) =>
    tokenize(word.text).map((token) => ({ token, sourceIndex, word })),
  )
  const { matches, mismatches } = alignTokens(expectedTokens, actualTokens)
  const expectedCount = Math.max(1, expectedTokens.length)
  const mismatchRate = mismatches.length / Math.max(expectedCount, actualTokens.length, 1)
  const lineResults: QwenLineVerification[] = []
  const cues: QwenLineCue[] = []
  const matchByLine = new Map<number, Match[]>()
  const extraByLine = new Map<number, number>()
  for (const match of matches) {
    const lineIndex = expectedTokens[match.expectedIndex]?.lineIndex
    if (lineIndex === undefined) continue
    const existing = matchByLine.get(lineIndex) || []
    existing.push(match)
    matchByLine.set(lineIndex, existing)
  }
  for (const mismatch of mismatches) {
    if (mismatch.type !== 'extra' || mismatch.actualIndex === undefined) continue
    const lineIndex = lineIndexForExtra(
      mismatch.actualIndex,
      matches,
      expectedTokens,
      actualTokens,
      lines.length,
    )
    extraByLine.set(lineIndex, (extraByLine.get(lineIndex) || 0) + 1)
  }

  const boundaries: number[] = [0]
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const lineMatches = matchByLine.get(lineIndex) || []
    const expectedLineTokens = expectedTokens.filter((token) => token.lineIndex === lineIndex)
    const lineMismatches = mismatches.filter(
      (mismatch) => mismatch.expectedIndex !== undefined &&
        expectedTokens[mismatch.expectedIndex]?.lineIndex === lineIndex,
    )
    const firstWord = actualWordForMatch(lineMatches[0], actualTokens)
    const lastWord = actualWordForMatch(lineMatches[lineMatches.length - 1], actualTokens)
    const nextMatches = matchByLine.get(lineIndex + 1) || []
    const nextWord = actualWordForMatch(nextMatches[0], actualTokens)
    const lineStart = boundaries[lineIndex] || 0
    const lineEnd =
      lineIndex === lines.length - 1
        ? Math.max(lineStart, duration)
        : boundaryBetween(lastWord, nextWord, duration)
    if (lineEnd > lineStart) boundaries.push(lineEnd)

    const exactMatches = lineMatches.filter((match) => match.exact).length
    const coverage = lineMatches.length / Math.max(1, expectedLineTokens.length)
    const averageConfidence =
      lineMatches.length === 0
        ? 0
        : lineMatches.reduce(
            (sum, match) => sum + (actualTokens[match.actualIndex]?.word.confidence ?? 0.75),
            0,
          ) / lineMatches.length
    const confidence = clamp01(coverage * 0.55 + averageConfidence * 0.25 + (exactMatches / Math.max(1, lineMatches.length)) * 0.2)
    const extraCount = extraByLine.get(lineIndex) || 0
    const lineMismatchCount = lineMismatches.length + extraCount
    const transcriptText = transcriptTextForMatches(lineMatches, actualTokens)
    const missingCount = lineMismatches.filter((mismatch) => mismatch.type === 'missing').length
    const substitutionCount = lineMismatches.filter(
      (mismatch) => mismatch.type === 'substitution',
    ).length
    lineResults.push({
      lineId: lines[lineIndex]!.id,
      expectedText: lines[lineIndex]!.text,
      transcriptText,
      confidence,
      mismatchCount: lineMismatchCount,
      missingCount,
      extraCount,
      substitutionCount,
    })
    if (lineMatches.length > 0 && lineEnd > lineStart) {
      cues.push({
        lineId: lines[lineIndex]!.id,
        start: lineStart,
        end: lineEnd,
        confidence,
        mismatchCount: lineMismatchCount,
      })
    }
  }

  const severe =
    expectedTokens.length === 0 ||
    actualTokens.length === 0 ||
    mismatchRate > 0.22 ||
    lineResults.some((line) => line.confidence < 0.55 || line.missingCount > 2)
  const localized =
    !severe &&
    mismatches.length > 0 &&
    lineResults.filter((line) => line.mismatchCount > 0).length <= Math.max(1, Math.ceil(lines.length / 4))

  return {
    transcript,
    expectedTranscript: lines.map((line) => line.text).join('\n'),
    severity: severe ? 'severe' : localized ? 'localized' : 'exact',
    editDistance: mismatches.length,
    mismatchRate,
    cues,
    lines: lineResults,
  }
}

const SMALL_NUMBERS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
] as const

const TENS_NUMBERS = [
  '',
  '',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const

export function tokenize(text: string): string[] {
  const prepared = text
    .toLocaleLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\$(\d+(?:\.\d+)?)/g, (_, amount: string) => {
      const unit = Number(amount) === 1 ? 'dollar' : 'dollars'
      return `${amount} ${unit}`
    })
    .replace(/\ba hundred\b/g, 'one hundred')
    .replace(/\ba thousand\b/g, 'one thousand')
  const rawTokens = prepared.match(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*/gu) || []
  return rawTokens.flatMap((rawToken) => {
    const expansion = CONTRACTIONS[rawToken]
    const parts = expansion ? expansion.split(' ') : expandNumericToken(rawToken)
    return parts.map(canonicalToken)
  })
}

function expandNumericToken(token: string): string[] {
  if (!/^\d+$/.test(token)) return [token]
  const value = Number(token)
  if (!Number.isSafeInteger(value) || value < 0 || value > 9999) return [token]
  return numberToSpokenTokens(value)
}

function numberToSpokenTokens(value: number): string[] {
  if (value < 20) return [SMALL_NUMBERS[value]!]
  if (value < 100) {
    const tens = Math.floor(value / 10)
    const ones = value % 10
    return ones === 0 ? [TENS_NUMBERS[tens]!] : [TENS_NUMBERS[tens]!, SMALL_NUMBERS[ones]!]
  }
  if (value < 1000) {
    const hundreds = Math.floor(value / 100)
    const rest = value % 100
    const tokens = [SMALL_NUMBERS[hundreds]!, 'hundred']
    if (rest > 0) tokens.push(...numberToSpokenTokens(rest))
    return tokens
  }
  const thousands = Math.floor(value / 1000)
  const rest = value % 1000
  const tokens = [SMALL_NUMBERS[thousands]!, 'thousand']
  if (rest > 0) tokens.push(...numberToSpokenTokens(rest))
  return tokens
}

function transcriptTextForMatches(
  matches: readonly Match[],
  actualTokens: readonly ActualToken[],
): string {
  const sourceIndices = new Set<number>()
  return matches
    .map((match) => {
      const actual = actualTokens[match.actualIndex]
      if (!actual || sourceIndices.has(actual.sourceIndex)) return ''
      sourceIndices.add(actual.sourceIndex)
      return actual.word.text
    })
    .filter(Boolean)
    .join(' ')
}

function alignTokens(
  expected: readonly ExpectedToken[],
  actual: readonly ActualToken[],
): { matches: Match[]; mismatches: Mismatch[] } {
  const rows = expected.length + 1
  const columns = actual.length + 1
  const costs = Array.from({ length: rows }, () => Array<number>(columns).fill(0))
  const operations = Array.from({ length: rows }, () => Array<'match' | 'delete' | 'insert'>(
    columns,
  ).fill('match'))
  for (let row = 1; row < rows; row += 1) {
    costs[row]![0] = row
    operations[row]![0] = 'delete'
  }
  for (let column = 1; column < columns; column += 1) {
    costs[0]![column] = column
    operations[0]![column] = 'insert'
  }

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const diagonal = costs[row - 1]![column - 1]! + tokenCost(
        expected[row - 1]!.token,
        actual[column - 1]!.token,
      )
      const deletion = costs[row - 1]![column]! + 1
      const insertion = costs[row]![column - 1]! + 1
      if (diagonal <= deletion && diagonal <= insertion) {
        costs[row]![column] = diagonal
        operations[row]![column] = 'match'
      } else if (deletion <= insertion) {
        costs[row]![column] = deletion
        operations[row]![column] = 'delete'
      } else {
        costs[row]![column] = insertion
        operations[row]![column] = 'insert'
      }
    }
  }

  const matches: Match[] = []
  const mismatches: Mismatch[] = []
  let row = expected.length
  let column = actual.length
  while (row > 0 || column > 0) {
    const operation = operations[row]?.[column] || (row > 0 ? 'delete' : 'insert')
    if (operation === 'match' && row > 0 && column > 0) {
      const expectedToken = expected[row - 1]!.token
      const actualToken = actual[column - 1]!.token
      const exact = expectedToken === actualToken || canonicalToken(expectedToken) === canonicalToken(actualToken)
      matches.unshift({ expectedIndex: row - 1, actualIndex: column - 1, exact })
      if (!exact) {
        mismatches.unshift({
          type: 'substitution',
          expectedIndex: row - 1,
          actualIndex: column - 1,
        })
      }
      row -= 1
      column -= 1
    } else if (operation === 'delete' && row > 0) {
      mismatches.unshift({ type: 'missing', expectedIndex: row - 1 })
      row -= 1
    } else {
      mismatches.unshift({ type: 'extra', actualIndex: column - 1 })
      column -= 1
    }
  }
  return { matches, mismatches }
}

function tokenCost(expected: string, actual: string): number {
  if (expected === actual) return 0
  if (canonicalToken(expected) === canonicalToken(actual)) return 0
  if (expected.length >= 4 && actual.length >= 4 && editDistance(expected, actual) <= 1) return 0.45
  return 1.25
}

function canonicalToken(token: string): string {
  return TOKEN_ALIASES[token] || token
}

function editDistance(left: string, right: string): number {
  const row = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = row[0]!
    row[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const previous = row[rightIndex]!
      row[rightIndex] = Math.min(
        row[rightIndex]! + 1,
        row[rightIndex - 1]! + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      )
      diagonal = previous
    }
  }
  return row[right.length]!
}

function actualWordForMatch(
  match: Match | undefined,
  actualTokens: readonly ActualToken[],
): WhisperWord | undefined {
  return match ? actualTokens[match.actualIndex]?.word : undefined
}

function boundaryBetween(
  current: WhisperWord | undefined,
  next: WhisperWord | undefined,
  duration: number,
): number {
  if (!current) return next ? Math.max(0, next.start) : duration
  if (!next) return Math.min(duration, Math.max(0, current.end))
  if (next.start <= current.end) return Math.min(duration, current.end)
  const gap = next.start - current.end
  return Math.min(duration, current.end + (gap >= 0.08 ? gap / 2 : 0))
}

function lineIndexForExtra(
  actualIndex: number,
  matches: readonly Match[],
  expectedTokens: readonly ExpectedToken[],
  actualTokens: readonly ActualToken[],
  lineCount: number,
): number {
  const previous = [...matches]
    .reverse()
    .find((match) => match.actualIndex < actualIndex)
  const next = matches.find((match) => match.actualIndex > actualIndex)
  const previousLine = previous
    ? expectedTokens[previous.expectedIndex]?.lineIndex
    : undefined
  const nextLine = next ? expectedTokens[next.expectedIndex]?.lineIndex : undefined
  if (previousLine !== undefined && nextLine !== undefined && previousLine !== nextLine) {
    const previousWord = previous ? actualTokens[previous.actualIndex]?.word : undefined
    const nextWord = next ? actualTokens[next.actualIndex]?.word : undefined
    const extraWord = actualTokens[actualIndex]?.word
    if (previousWord && nextWord && extraWord) {
      const midpoint = previousWord.end + (nextWord.start - previousWord.end) / 2
      return extraWord.start <= midpoint ? previousLine : nextLine
    }
    return previousLine
  }
  return Math.min(lineCount - 1, Math.max(0, previousLine ?? nextLine ?? 0))
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}
