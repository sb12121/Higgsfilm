import type { SceneLedgerEntry, ScriptLine } from './types'

export type SceneGenerationOutcome = 'pending' | 'complete' | 'failed' | 'cancelled'

export interface SceneGenerationJobPlan {
  paragraphIndex: number
  chunkIndex: number
  paragraphLineIds: string[]
  targetLineIds: string[]
}

export function buildSceneGenerationJobPlans(
  orderedLines: ScriptLine[],
  targetLineIds: string[],
  maxBatchLines = 8,
): SceneGenerationJobPlan[] {
  const targets = new Set(targetLineIds)
  const groups = new Map<number, { paragraphLines: ScriptLine[]; targetLines: ScriptLine[] }>()
  for (const line of orderedLines.slice().sort((left, right) => left.index - right.index)) {
    const paragraphIndex = Number.isInteger(line.paragraphIndex) && (line.paragraphIndex || 0) >= 0
      ? line.paragraphIndex || 0
      : 0
    const group = groups.get(paragraphIndex) || { paragraphLines: [], targetLines: [] }
    group.paragraphLines.push(line)
    if (targets.has(line.id)) group.targetLines.push(line)
    groups.set(paragraphIndex, group)
  }

  const plans: SceneGenerationJobPlan[] = []
  for (const [paragraphIndex, group] of [...groups.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    for (let offset = 0, chunkIndex = 0; offset < group.targetLines.length; offset += maxBatchLines, chunkIndex += 1) {
      const targetLines = group.targetLines.slice(offset, offset + maxBatchLines)
      plans.push({
        paragraphIndex,
        chunkIndex,
        paragraphLineIds: group.paragraphLines.map((line) => line.id),
        targetLineIds: targetLines.map((line) => line.id),
      })
    }
  }
  return plans
}

export function sceneGenerationWaves<T>(
  jobs: T[],
  maxWorkers = 5,
): T[][] {
  const safeWorkerCount = Math.max(1, Math.floor(maxWorkers))
  const waves: T[][] = []
  for (let offset = 0; offset < jobs.length; offset += safeWorkerCount) {
    waves.push(jobs.slice(offset, offset + safeWorkerCount))
  }
  return waves
}

export function mergeSceneLedgers(...ledgers: SceneLedgerEntry[][]): SceneLedgerEntry[] {
  const byLineId = new Map<string, SceneLedgerEntry>()
  for (const ledger of ledgers) {
    for (const entry of ledger) byLineId.set(entry.lineId, entry)
  }
  return [...byLineId.values()].sort((left, right) => left.lineIndex - right.lineIndex)
}

export function sceneLineMatchesSnapshot(current: ScriptLine, snapshot: ScriptLine): boolean {
  return (
    current.id === snapshot.id &&
    current.index === snapshot.index &&
    current.text === snapshot.text &&
    current.paragraphIndex === snapshot.paragraphIndex
  )
}
