import type { VideoIdeaBrief, VideoIdeaResearchResult, VideoIdeaSession, YouTubeVideoHit } from './types'

export const IDEA_REVIEW_FIELDS = {
  candidateA: 'Candidate A - problem, angle, appeal, risks',
  candidateB: 'Candidate B - problem, angle, appeal, risks',
  candidateC: 'Candidate C - problem, angle, appeal, risks',
  selectedCandidate: 'Selected candidate (A, B, or C)',
  selectionReason: 'Why this candidate wins',
  evidenceConfidence: 'Evidence confidence (low, medium, high)',
  evidenceLimitations: 'Evidence limitations and unknowns',
  differentiation: 'Why choose our version',
  productionFit: 'Opening, visual payoff, and production feasibility',
  packagingAlternatives: 'Three title and thumbnail pairs',
  decision: 'Decision (produce, revise, research, park)',
} as const

export function normalizeIdeaReview(raw: Partial<VideoIdeaBrief>): Partial<VideoIdeaBrief> {
  return Object.fromEntries(Object.keys(IDEA_REVIEW_FIELDS).map(key => {
    const value = raw[key as keyof VideoIdeaBrief]
    return [key, typeof value === 'string' ? value.trim() : '']
  }))
}

export function normalizeIdeaEvidence(value: unknown): YouTubeVideoHit[] {
  if (!Array.isArray(value)) return []
  const hits = new Map<string, YouTubeVideoHit>()
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue
    const v = raw as YouTubeVideoHit
    if (typeof v.videoId !== 'string' || !/^[\w-]+$/.test(v.videoId) ||
        typeof v.title !== 'string' || typeof v.channelName !== 'string') continue
    hits.set(v.videoId, {
      videoId: v.videoId, title: v.title, channelName: v.channelName,
      url: `https://www.youtube.com/watch?v=${v.videoId}`,
      channelId: typeof v.channelId === 'string' ? v.channelId : undefined,
      published: typeof v.published === 'string' ? v.published : undefined,
      duration: typeof v.duration === 'string' ? v.duration : undefined,
      viewCount: typeof v.viewCount === 'number' && Number.isFinite(v.viewCount) ? v.viewCount : undefined,
      viewCountText: typeof v.viewCountText === 'string' ? v.viewCountText : undefined,
    })
  }
  return [...hits.values()].slice(-150)
}

/** Only research results, never coach output, populate the evidence ledger. */
export function recordIdeaResearch(session: VideoIdeaSession, result: VideoIdeaResearchResult): VideoIdeaSession {
  return { ...session, evidence: normalizeIdeaEvidence([
    ...(session.evidence || []),
    ...result.queries.filter(q => !q.error).flatMap(q => q.videos),
    ...result.channels.filter(c => !c.error).flatMap(c => c.snapshot?.videos || []),
  ]) }
}

export function citedIdeaEvidence(idea: VideoIdeaBrief, evidence: YouTubeVideoHit[] = []): YouTubeVideoHit[] {
  const urls = new Set(idea.demandEvidence.match(/https:\/\/www\.youtube\.com\/watch\?v=[\w-]+/g) || [])
  return normalizeIdeaEvidence(evidence).filter(v => urls.has(v.url))
}

export function ideaDemandGaps(idea: VideoIdeaBrief, evidence: YouTubeVideoHit[] = []): string[] {
  const gaps: string[] = []
  const candidates = [idea.candidateA, idea.candidateB, idea.candidateC].map(v => v?.trim() || '')
  if (candidates.some(v => !v) || new Set(candidates.map(v => v.toLowerCase())).size < 3) gaps.push('three distinct candidates')
  if (!['A', 'B', 'C'].includes(idea.selectedCandidate?.trim() || '')) gaps.push('selected candidate A, B, or C')
  if (!idea.selectionReason?.trim()) gaps.push('candidate comparison and selection reason')
  const cited = citedIdeaEvidence(idea, evidence)
  if (cited.length < 2 || distinctKnownChannelCount(cited) < 2) gaps.push('two researched video citations from different channels')
  if (!['medium', 'high'].includes(idea.evidenceConfidence?.trim().toLowerCase() || '')) gaps.push('sufficient evidence confidence')
  if (!idea.evidenceLimitations?.trim()) gaps.push('evidence limitations')
  return gaps
}

function distinctKnownChannelCount(videos: YouTubeVideoHit[]): number {
  const parents: number[] = videos.map((_, index) => index)
  const find = (index: number): number => {
    if (parents[index] !== index) parents[index] = find(parents[index])
    return parents[index]
  }
  const union = (left: number, right: number) => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parents[b] = a
  }
  const idOwners = new Map<string, number>()
  const nameOwners = new Map<string, number>()
  const known = new Set<number>()
  videos.forEach((video, index) => {
    const id = video.channelId?.trim().toLowerCase() || ''
    const rawName = (video.channelName || '').trim().toLowerCase().replace(/^@/, '').replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
    const name = /^(unknown( channel)?|channel unknown|not available|n a|none|channel)$/.test(rawName) ? '' : rawName
    if (id) {
      known.add(index)
      const prior = idOwners.get(id)
      if (prior !== undefined) union(index, prior)
      else idOwners.set(id, index)
    }
    if (name) {
      known.add(index)
      const prior = nameOwners.get(name)
      if (prior !== undefined) union(index, prior)
      else nameOwners.set(name, index)
    }
  })
  return new Set([...known].map(find)).size
}

export function ideaReviewGaps(idea: VideoIdeaBrief, evidence: YouTubeVideoHit[] = []): string[] {
  const gaps = ideaDemandGaps(idea, evidence)
  for (const key of ['differentiation', 'productionFit', 'packagingAlternatives'] as const) {
    if (!idea[key]?.trim()) gaps.push(IDEA_REVIEW_FIELDS[key].toLowerCase())
  }
  if (idea.decision?.trim().toLowerCase() !== 'produce') gaps.push('decision to produce')
  return gaps
}
