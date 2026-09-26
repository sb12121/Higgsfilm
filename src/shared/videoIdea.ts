import { normalizeIdeaReview, normalizeIdeaEvidence, ideaReviewGaps, ideaDemandGaps } from './videoIdeaQuality'
import type {
  VideoIdeaBrief,
  VideoIdeaChecklist,
  VideoIdeaMessage,
  VideoIdeaPhase,
  VideoIdeaResearchResult,
  VideoIdeaSession,
  YouTubeChannelSnapshot,
  YouTubeVideoHit,
} from './types'

export const VIDEO_IDEA_PHASES: VideoIdeaPhase[] = [
  'idle',
  'audience',
  'demand',
  'research',
  'packaging',
  'consumption',
  'conversion',
  'locked',
]

export const VIDEO_IDEA_MAX_ROUNDS = 12
export const VIDEO_IDEA_MAX_RESEARCH_ROUNDS = 3

export interface VideoIdeaCoachTurn {
  message: string
  phase: VideoIdeaPhase
  locked: boolean
  awaitProducer: boolean
  researchQueries: string[]
  researchChannels: string[]
  idea: Partial<VideoIdeaBrief>
  checklist: Partial<VideoIdeaChecklist>
}

const EMPTY_BRIEF: VideoIdeaBrief = {
  ...normalizeIdeaReview({}),
  audience: '',
  awareness: '',
  subject: '',
  demandEvidence: '',
  failuresNoted: '',
  bridge: '',
  title: '',
  thumbnailConcept: '',
  clickReason: '',
  promisedExperience: '',
  scriptTopic: '',
  sameAudienceFit: '',
  cta: '',
}

const EMPTY_CHECKLIST: VideoIdeaChecklist = {
  audienceWritten: false,
  demandEvidence: false,
  failuresNoted: false,
  sameAudience: false,
  titleReady: false,
  thumbnailReady: false,
  experienceReady: false,
  ctaReady: false,
}

export function emptyVideoIdeaBrief(): VideoIdeaBrief {
  return { ...EMPTY_BRIEF }
}

export function emptyVideoIdeaChecklist(): VideoIdeaChecklist {
  return { ...EMPTY_CHECKLIST }
}

export function emptyVideoIdeaSession(seed = ''): VideoIdeaSession {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    phase: 'idle',
    locked: false,
    seed: seed.trim(),
    idea: emptyVideoIdeaBrief(),
    checklist: emptyVideoIdeaChecklist(),
    messages: [],
  }
}

export function normalizeVideoIdeaSession(value: unknown): VideoIdeaSession | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<VideoIdeaSession>
  const phase = VIDEO_IDEA_PHASES.includes(raw.phase as VideoIdeaPhase)
    ? (raw.phase as VideoIdeaPhase)
    : 'idle'
  const messages = Array.isArray(raw.messages)
    ? raw.messages.flatMap((message) => {
        if (!message || typeof message !== 'object') return []
        const item = message as Partial<VideoIdeaMessage>
        const role =
          item.role === 'user' || item.role === 'assistant' || item.role === 'research'
            ? item.role
            : null
        const text = typeof item.text === 'string' ? item.text.trim() : ''
        if (!role || !text) return []
        return [
          {
            id: typeof item.id === 'string' && item.id.trim() ? item.id.trim() : createIdeaMessageId(),
            role,
            text,
            createdAt:
              typeof item.createdAt === 'string' && item.createdAt.trim()
                ? item.createdAt
                : new Date().toISOString(),
          },
        ]
      })
    : []
  const locked = Boolean(raw.locked) && videoIdeaReadyForScript(normalizeBrief(raw.idea), normalizeChecklist(raw.checklist), normalizeIdeaEvidence(raw.evidence))
  return {
    version: 1,
    updatedAt:
      typeof raw.updatedAt === 'string' && raw.updatedAt.trim()
        ? raw.updatedAt
        : new Date().toISOString(),
    phase: phase === 'locked' && !locked ? 'research' : phase,
    locked,
    evidence: normalizeIdeaEvidence(raw.evidence),
    seed: typeof raw.seed === 'string' ? raw.seed.trim() : '',
    idea: normalizeBrief(raw.idea),
    checklist: normalizeChecklist(raw.checklist),
    messages,
  }
}

export function createIdeaMessageId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') return globalThis.crypto.randomUUID()
  return `idea-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

export function appendVideoIdeaMessage(
  session: VideoIdeaSession,
  role: VideoIdeaMessage['role'],
  text: string,
): VideoIdeaSession {
  const trimmed = text.trim()
  if (!trimmed) return session
  return touchVideoIdeaSession({
    ...session,
    messages: [
      ...session.messages,
      {
        id: createIdeaMessageId(),
        role,
        text: trimmed,
        createdAt: new Date().toISOString(),
      },
    ],
  })
}

export function touchVideoIdeaSession(session: VideoIdeaSession): VideoIdeaSession {
  return { ...session, version: 1, updatedAt: new Date().toISOString() }
}

export function mergeVideoIdeaBrief(
  current: VideoIdeaBrief,
  patch: Partial<VideoIdeaBrief> | undefined,
): VideoIdeaBrief {
  if (!patch) return { ...current }
  const next = { ...current }
  for (const key of Object.keys(EMPTY_BRIEF) as Array<keyof VideoIdeaBrief>) {
    const value = patch[key]
    if (typeof value === 'string' && value.trim()) next[key] = value.trim()
  }
  return next
}

export function mergeVideoIdeaChecklist(
  current: VideoIdeaChecklist,
  patch: Partial<VideoIdeaChecklist> | undefined,
): VideoIdeaChecklist {
  if (!patch) return { ...current }
  const next = { ...current }
  for (const key of Object.keys(EMPTY_CHECKLIST) as Array<keyof VideoIdeaChecklist>) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key] as boolean
  }
  return next
}

export function applyVideoIdeaCoachTurn(
  session: VideoIdeaSession,
  turn: VideoIdeaCoachTurn,
): VideoIdeaSession {
  let idea = mergeVideoIdeaBrief(session.idea, turn.idea)
  let checklist = mergeVideoIdeaChecklist(session.checklist, turn.checklist)
  const selectionChanged =
    session.idea.subject.trim() !== idea.subject.trim() ||
    session.idea.selectedCandidate?.trim().toUpperCase() !== idea.selectedCandidate?.trim().toUpperCase() ||
    (['candidateA', 'candidateB', 'candidateC'] as const).some(
      (key) => (session.idea[key] || '').trim() !== (idea[key] || '').trim(),
    )
  const hadSelectionBasis = Boolean(
    session.idea.subject.trim() || session.idea.selectedCandidate?.trim() ||
    session.idea.candidateA?.trim() || session.idea.candidateB?.trim() || session.idea.candidateC?.trim(),
  )
  if (selectionChanged && hadSelectionBasis) {
    // Drop inherited conclusions for the old basis, while accepting explicit fresh review in this turn.
    const keepFresh = <K extends keyof VideoIdeaBrief>(key: K): VideoIdeaBrief[K] =>
      typeof turn.idea[key] === 'string' && (turn.idea[key] as string).trim()
        ? idea[key]
        : '' as VideoIdeaBrief[K]
    idea = {
      ...idea,
      selectionReason: keepFresh('selectionReason'),
      demandEvidence: keepFresh('demandEvidence'),
      failuresNoted: keepFresh('failuresNoted'),
      sameAudienceFit: keepFresh('sameAudienceFit'),
      evidenceConfidence: keepFresh('evidenceConfidence'),
      evidenceLimitations: keepFresh('evidenceLimitations'),
      differentiation: keepFresh('differentiation'),
      productionFit: keepFresh('productionFit'),
      packagingAlternatives: keepFresh('packagingAlternatives'),
      title: keepFresh('title'),
      thumbnailConcept: keepFresh('thumbnailConcept'),
      clickReason: keepFresh('clickReason'),
      promisedExperience: keepFresh('promisedExperience'),
      scriptTopic: keepFresh('scriptTopic'),
      cta: keepFresh('cta'),
      decision: keepFresh('decision'),
    }
    checklist = {
      ...checklist,
      audienceWritten: turn.checklist.audienceWritten === true,
      demandEvidence: turn.checklist.demandEvidence === true,
      failuresNoted: turn.checklist.failuresNoted === true,
      sameAudience: turn.checklist.sameAudience === true,
      titleReady: turn.checklist.titleReady === true,
      thumbnailReady: turn.checklist.thumbnailReady === true,
      experienceReady: turn.checklist.experienceReady === true,
      ctaReady: turn.checklist.ctaReady === true,
    }
  }
  const locked = turn.locked && videoIdeaReadyForScript(idea, checklist, session.evidence)
  const phase = locked
    ? 'locked'
    : turn.phase === 'locked'
      ? 'packaging'
      : turn.phase || session.phase
  return touchVideoIdeaSession({
    ...session,
    phase,
    locked,
    idea,
    checklist: locked
      ? {
          audienceWritten: true,
          demandEvidence: true,
          failuresNoted: checklist.failuresNoted,
          sameAudience: true,
          titleReady: true,
          thumbnailReady: true,
          experienceReady: true,
          ctaReady: true,
        }
      : checklist,
    messages: turn.message.trim()
      ? [
          ...session.messages,
          {
            id: createIdeaMessageId(),
            role: 'assistant',
            text: turn.message.trim(),
            createdAt: new Date().toISOString(),
          },
        ]
      : session.messages,
  })
}

/**
 * If the last coach bubble is raw/truncated JSON (parse used to fall back to dumping it),
 * re-parse and apply the brief so the producer is not stuck.
 */
export function recoverVideoIdeaFromRawAssistantMessage(
  session: VideoIdeaSession,
): VideoIdeaSession {
  const last = session.messages.at(-1)
  if (!last || last.role !== 'assistant' || !looksLikeJsonObject(last.text)) return session
  const turn = parseVideoIdeaResponse(last.text)
  const recoveredSomething =
    Boolean(turn.idea.title?.trim()) ||
    Boolean(turn.idea.demandEvidence?.trim()) ||
    Boolean(turn.idea.scriptTopic?.trim()) ||
    Boolean(turn.idea.cta?.trim()) ||
    turn.locked ||
    Object.values(turn.checklist).some(Boolean)
  if (!recoveredSomething) return session
  if (turn.message.trim() === last.text.trim()) return session
  const withoutRaw = touchVideoIdeaSession({
    ...session,
    messages: session.messages.slice(0, -1),
  })
  return applyVideoIdeaCoachTurn(withoutRaw, turn)
}

export function videoIdeaReadyForScript(
  idea: VideoIdeaBrief,
  checklist: VideoIdeaChecklist = emptyVideoIdeaChecklist(),
  evidence: YouTubeVideoHit[] = [],
): boolean {
  return Boolean(
    idea.audience.trim() && idea.awareness.trim() && idea.subject.trim() &&
    idea.title.trim() && idea.thumbnailConcept.trim() && idea.clickReason.trim() &&
    idea.promisedExperience.trim() && idea.scriptTopic.trim() && idea.cta.trim() &&
    idea.demandEvidence.trim() && idea.failuresNoted.trim() && idea.sameAudienceFit.trim() &&
    Object.values(normalizeChecklist(checklist)).every(Boolean) &&
    ideaReviewGaps(idea, evidence).length === 0
  )
}

export function videoIdeaDemandComplete(session: VideoIdeaSession): boolean {
  return Boolean(
    ideaDemandGaps(session.idea, session.evidence).length === 0 &&
    session.idea.audience.trim() &&
      session.idea.demandEvidence.trim() &&
      session.idea.failuresNoted.trim() &&
      session.idea.sameAudienceFit.trim() &&
      session.checklist.audienceWritten &&
      session.checklist.demandEvidence &&
      session.checklist.failuresNoted &&
      session.checklist.sameAudience,
  )
}

export function videoIdeaPackagingComplete(session: VideoIdeaSession): boolean {
  return Boolean(
    session.idea.title.trim() &&
      session.idea.thumbnailConcept.trim() &&
      session.idea.clickReason.trim() &&
      session.idea.promisedExperience.trim() &&
      session.idea.scriptTopic.trim() &&
      session.idea.cta.trim(),
  )
}

export function unpaidVideoIdeaGates(session: VideoIdeaSession): string[] {
  const unpaid: string[] = ideaReviewGaps(session.idea, session.evidence)
  if (!session.checklist.audienceWritten || !session.idea.audience.trim()) unpaid.push('audience')
  if (!session.checklist.demandEvidence || !session.idea.demandEvidence.trim()) {
    unpaid.push('demand evidence')
  }
  if (!session.checklist.failuresNoted || !session.idea.failuresNoted.trim()) unpaid.push('failures noted')
  if (!session.checklist.sameAudience || !session.idea.sameAudienceFit.trim()) unpaid.push('same audience')
  if (!session.checklist.thumbnailReady || !session.idea.thumbnailConcept.trim()) unpaid.push('thumbnail')
  if (!session.checklist.titleReady || !session.idea.title.trim()) unpaid.push('title')
  if (!session.idea.clickReason.trim()) unpaid.push('click reason')
  if (!session.checklist.experienceReady || !session.idea.promisedExperience.trim()) {
    unpaid.push('promised experience')
  }
  if (!session.idea.scriptTopic.trim()) unpaid.push('episode sequence')
  if (!session.checklist.ctaReady || !session.idea.cta.trim()) unpaid.push('cta')
  return unpaid
}

export function shouldAllowVideoIdeaResearch(
  session: VideoIdeaSession,
  researchRoundsUsed: number,
): boolean {
  if (researchRoundsUsed >= VIDEO_IDEA_MAX_RESEARCH_ROUNDS) return false
  if (videoIdeaDemandComplete(session)) return false
  return true
}

export function shouldContinueVideoIdeaCoach(
  session: VideoIdeaSession,
  turn: VideoIdeaCoachTurn,
  researchRoundsUsed: number,
): boolean {
  if (session.locked || videoIdeaReadyForScript(session.idea, session.checklist, session.evidence)) return false
  const decision = session.idea.decision?.trim().toLowerCase()
  if (decision === 'revise' || decision === 'park') return false
  if (turn.awaitProducer) return false
  const wantsResearch = turn.researchQueries.length > 0 || turn.researchChannels.length > 0
  const researchAllowed = shouldAllowVideoIdeaResearch(session, researchRoundsUsed)
  if (decision === 'research' && (!wantsResearch || !researchAllowed)) return false
  if (wantsResearch) return researchAllowed
  return videoIdeaDemandComplete(session)
}

export function composeScriptTopicFromIdea(idea: VideoIdeaBrief): string {
  const lines = [
    idea.title.trim() && `Title: ${idea.title.trim()}`,
    idea.thumbnailConcept.trim() && `Thumbnail: ${idea.thumbnailConcept.trim()}`,
    idea.clickReason.trim() && `Click reason: ${idea.clickReason.trim()}`,
    idea.audience.trim() && `Audience: ${idea.audience.trim()}`,
    idea.awareness.trim() && `Awareness: ${idea.awareness.trim()}`,
    idea.subject.trim() && `Subject: ${idea.subject.trim()}`,
    idea.bridge.trim() && `Bridge: ${idea.bridge.trim()}`,
    idea.demandEvidence.trim() && `Demand: ${idea.demandEvidence.trim()}`,
    idea.sameAudienceFit.trim() && `Same-audience fit: ${idea.sameAudienceFit.trim()}`,
    idea.promisedExperience.trim() && `Promised experience: ${idea.promisedExperience.trim()}`,
    idea.scriptTopic.trim() && `Episode sequence: ${idea.scriptTopic.trim()}`,
    idea.differentiation?.trim() && `Distinctive contribution: ${idea.differentiation.trim()}`,
    idea.productionFit?.trim() && `Production and opening: ${idea.productionFit.trim()}`,
    idea.evidenceLimitations?.trim() && `Evidence limitations: ${idea.evidenceLimitations.trim()}`,
    idea.cta.trim() && `CTA: ${idea.cta.trim()}`,
  ].filter(Boolean)
  return lines.join('\n')
}

export function parseVideoIdeaResponse(raw: string): VideoIdeaCoachTurn {
  const fallback: VideoIdeaCoachTurn = {
    message: raw.trim(),
    phase: 'demand',
    locked: false,
    awaitProducer: false,
    researchQueries: [],
    researchChannels: [],
    idea: {},
    checklist: {},
  }
  const parsed = extractJsonObject(raw)
  if (!parsed) return fallback
  const message =
    readString(parsed.message) ||
    readString(parsed.reply) ||
    readString(parsed.coach) ||
    // Avoid dumping the whole JSON blob into chat when the message field is missing.
    (looksLikeJsonObject(fallback.message) ? '' : fallback.message)
  const phaseValue = readString(parsed.phase).toLowerCase()
  const phase = VIDEO_IDEA_PHASES.includes(phaseValue as VideoIdeaPhase)
    ? (phaseValue as VideoIdeaPhase)
    : 'demand'
  const ideaSource =
    parsed.idea && typeof parsed.idea === 'object' ? (parsed.idea as Record<string, unknown>) : parsed
  const checklistSource =
    parsed.checklist && typeof parsed.checklist === 'object'
      ? parsed.checklist
      : ideaSource.checklist && typeof ideaSource.checklist === 'object'
        ? ideaSource.checklist
        : undefined
  return {
    message: message || 'Continue with the next idea gate.',
    phase,
    locked: parsed.locked === true || phase === 'locked',
    awaitProducer: parsed.awaitProducer === true,
    researchQueries: readStringList(parsed.researchQueries).slice(0, 4),
    researchChannels: readStringList(parsed.researchChannels).slice(0, 3),
    idea: {
      ...normalizeIdeaReview(ideaSource),
      audience: readString(ideaSource.audience),
      awareness: readString(ideaSource.awareness),
      subject: readString(ideaSource.subject),
      demandEvidence: readString(ideaSource.demandEvidence),
      failuresNoted: readString(ideaSource.failuresNoted),
      bridge: readString(ideaSource.bridge),
      title: readString(ideaSource.title),
      thumbnailConcept: readString(ideaSource.thumbnailConcept),
      clickReason: readString(ideaSource.clickReason),
      promisedExperience: readString(ideaSource.promisedExperience),
      scriptTopic: readString(ideaSource.scriptTopic),
      sameAudienceFit: readString(ideaSource.sameAudienceFit),
      cta: readString(ideaSource.cta),
    },
    checklist: readChecklist(checklistSource),
  }
}

export function formatVideoIdeaResearch(result: VideoIdeaResearchResult): string {
  const blocks: string[] = ['Research provides public titles, links, view counts, publication labels, and durations where available. Traffic sources, CTR, retention, comments, viewer satisfaction, and thumbnail appearance are NOT verified by this tool. Search order is relevance order, not a performance ranking. Compare dates and formats; raw views do not establish an outlier.']
  for (const query of result.queries) {
    if (query.error) {
      blocks.push(`SEARCH "${query.query}" failed: ${query.error}`)
      continue
    }
    blocks.push(`SEARCH "${query.query}"`)
    if (query.videos.length === 0) {
      blocks.push('No videos returned.')
      continue
    }
    blocks.push(query.videos.map((video, index) => formatVideoHit(video, index)).join('\n'))
  }
  for (const channel of result.channels) {
    if (channel.error) {
      blocks.push(`CHANNEL "${channel.channel}" failed: ${channel.error}`)
      continue
    }
    const snapshot = channel.snapshot
    if (!snapshot) {
      blocks.push(`CHANNEL "${channel.channel}": no snapshot.`)
      continue
    }
    blocks.push(`CHANNEL ${snapshot.name}${snapshot.handle ? ` (${snapshot.handle})` : ''} · ${snapshot.url}`)
    if (snapshot.videos.length === 0) {
      blocks.push('No recent videos returned.')
      continue
    }
    blocks.push(snapshot.videos.map((video, index) => formatVideoHit(video, index)).join('\n'))
  }
  return blocks.join('\n\n').trim()
}

export function formatVideoHit(video: YouTubeVideoHit, index: number): string {
  const views = video.viewCountText || (video.viewCount != null ? `${video.viewCount} views` : 'unknown views')
  const published = video.published ? ` · ${video.published}` : ''
  const duration = video.duration ? ` · ${video.duration}` : ''
  const description = video.description ? `\n    ${video.description}` : ''
  return `${index + 1}. ${video.title} — ${video.channelName} · ${views}${published}${duration}\n    ${video.url}${description}`
}

/** Deterministic channel-identity brief from a YouTube snapshot (not episode demand proof). */
export function composeChannelBriefFromSnapshot(snapshot: YouTubeChannelSnapshot): string {
  const header = [
    snapshot.name.trim(),
    snapshot.handle?.trim(),
    snapshot.url.trim(),
  ]
    .filter(Boolean)
    .join(' · ')
  if (snapshot.videos.length === 0) {
    return `${header}\nNo recent videos returned.`
  }
  return [
    header,
    'Recent uploads (channel identity and recurring formats — not demand proof for a new episode):',
    snapshot.videos.map((video, index) => formatVideoHit(video, index)).join('\n'),
  ].join('\n')
}

export function newerVideoIdeaSession(
  incoming: VideoIdeaSession | undefined,
  current: VideoIdeaSession | undefined,
): VideoIdeaSession | undefined {
  if (!incoming) return current
  if (!current) return incoming
  const incomingTime = Date.parse(incoming.updatedAt) || 0
  const currentTime = Date.parse(current.updatedAt) || 0
  return currentTime > incomingTime ? current : incoming
}

function normalizeBrief(value: unknown): VideoIdeaBrief {
  const source = value && typeof value === 'object' ? (value as Partial<VideoIdeaBrief>) : {}
  return {
    ...normalizeIdeaReview(source),
    audience: readString(source.audience),
    awareness: readString(source.awareness),
    subject: readString(source.subject),
    demandEvidence: readString(source.demandEvidence),
    failuresNoted: readString(source.failuresNoted),
    bridge: readString(source.bridge),
    title: readString(source.title),
    thumbnailConcept: readString(source.thumbnailConcept),
    clickReason: readString(source.clickReason),
    promisedExperience: readString(source.promisedExperience),
    scriptTopic: readString(source.scriptTopic),
    sameAudienceFit: readString(source.sameAudienceFit),
    cta: readString(source.cta),
  }
}

function normalizeChecklist(value: unknown): VideoIdeaChecklist {
  const source = value && typeof value === 'object' ? (value as Partial<VideoIdeaChecklist>) : {}
  return {
    audienceWritten: source.audienceWritten === true,
    demandEvidence: source.demandEvidence === true,
    failuresNoted: source.failuresNoted === true,
    sameAudience: source.sameAudience === true,
    titleReady: source.titleReady === true,
    thumbnailReady: source.thumbnailReady === true,
    experienceReady: source.experienceReady === true,
    ctaReady: source.ctaReady === true,
  }
}

function readChecklist(value: unknown): Partial<VideoIdeaChecklist> {
  if (!value || typeof value !== 'object') return {}
  const source = value as Record<string, unknown>
  const next: Partial<VideoIdeaChecklist> = {}
  for (const key of Object.keys(EMPTY_CHECKLIST) as Array<keyof VideoIdeaChecklist>) {
    if (typeof source[key] === 'boolean') next[key] = source[key] as boolean
  }
  return next
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim()
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const source = fenced?.[1]?.trim() || trimmed
  const start = source.indexOf('{')
  if (start < 0) return null
  const end = source.lastIndexOf('}')
  const candidates = [
    end > start ? source.slice(start, end + 1) : '',
    source.slice(start),
  ].filter(Boolean)
  for (const candidate of candidates) {
    const parsed = tryParseJsonObject(candidate) || tryParseJsonObject(repairTruncatedJson(candidate))
    if (parsed) return parsed
  }
  return null
}

function tryParseJsonObject(source: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(source) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Close open strings/braces/brackets so truncated coach JSON can still be recovered. */
export function repairTruncatedJson(source: string): string {
  let inString = false
  let escape = false
  const stack: string[] = []
  for (const ch of source) {
    if (inString) {
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      continue
    }
    if (ch === '{' || ch === '[') stack.push(ch)
    else if (ch === '}' || ch === ']') stack.pop()
  }
  let repaired = source.trimEnd()
  // Drop a dangling trailing comma before we close the object.
  repaired = repaired.replace(/,\s*$/, '')
  if (inString) repaired += '"'
  while (stack.length > 0) {
    const open = stack.pop()
    repaired += open === '{' ? '}' : ']'
  }
  return repaired
}

function looksLikeJsonObject(value: string): boolean {
  const trimmed = value.trim()
  return trimmed.startsWith('{') && trimmed.includes('"')
}
