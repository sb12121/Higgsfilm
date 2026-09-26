import { describe, expect, it } from 'vitest'
import {
  applyVideoIdeaCoachTurn,
  emptyVideoIdeaSession,
  normalizeVideoIdeaSession,
  parseVideoIdeaResponse,
  shouldContinueVideoIdeaCoach,
  videoIdeaReadyForScript,
} from './videoIdea'
import { recordIdeaResearch } from './videoIdeaQuality'
import type { VideoIdeaBrief, VideoIdeaChecklist, YouTubeVideoHit } from './types'

const videos: YouTubeVideoHit[] = [
  { videoId: 'valid-a', title: 'Prices and paychecks', channelName: 'Plain Money', channelId: 'UCplain12345678901234567', url: 'ignored' },
  { videoId: 'valid-b', title: 'Why groceries cost more', channelName: 'Everyday Economics', channelId: 'UCeveryday1234567890123', url: 'ignored' },
]

function completeIdea(overrides: Partial<VideoIdeaBrief> = {}): VideoIdeaBrief {
  return {
    ...emptyVideoIdeaSession().idea,
    audience: 'People who feel poorer as prices rise.',
    awareness: 'They see higher prices but may not know why.',
    subject: 'Purchasing power.',
    demandEvidence: 'https://www.youtube.com/watch?v=valid-a and https://www.youtube.com/watch?v=valid-b',
    failuresNoted: 'Generic definitions hide the everyday consequence.',
    title: 'Why Your Paycheck Buys Less',
    thumbnailConcept: 'Same paycheck beside a shrinking grocery bag.',
    clickReason: 'The unchanged paycheck and smaller bag make the loss visible.',
    promisedExperience: 'A short story shows where the buying power went.',
    scriptTopic: 'Compare one paycheck across two grocery trips.',
    sameAudienceFit: 'For the same viewer trying to understand rising costs.',
    cta: 'Subscribe for more plain money explanations.',
    candidateA: 'Explain the shrinking grocery basket.',
    candidateB: 'Show why the same paycheck buys less.',
    candidateC: 'Compare wages and prices over time.',
    selectedCandidate: 'B',
    selectionReason: 'The shrinking basket gives the clearest visual proof.',
    evidenceConfidence: 'high',
    evidenceLimitations: 'Public view counts do not reveal click-through or retention.',
    differentiation: 'A single grocery trip makes purchasing power concrete.',
    productionFit: 'A receipt and grocery props create a fast, feasible opening.',
    packagingAlternatives: '1) Same paycheck / smaller bag; 2) Empty cart / full receipt; 3) $100 / fewer groceries.',
    decision: 'produce',
    ...overrides,
  }
}

function completeChecklist(): VideoIdeaChecklist {
  return {
    audienceWritten: true, demandEvidence: true, failuresNoted: true, sameAudience: true,
    titleReady: true, thumbnailReady: true, experienceReady: true, ctaReady: true,
  }
}

describe('video idea quality gates', () => {
  it('allows a complete reviewed idea with two retrieved videos from separate channels', () => {
    expect(videoIdeaReadyForScript(completeIdea(), completeChecklist(), videos)).toBe(true)
  })

  it('rejects forged citations that are not in the research ledger', () => {
    const idea = completeIdea({
      demandEvidence: 'https://www.youtube.com/watch?v=made-up-a https://www.youtube.com/watch?v=made-up-b',
    })
    expect(videoIdeaReadyForScript(idea, completeChecklist(), videos)).toBe(false)
  })

  it('rejects two cited videos from the same channel', () => {
    const sameChannel = [videos[0]!, { ...videos[1]!, channelName: videos[0]!.channelName, channelId: videos[0]!.channelId }]
    expect(videoIdeaReadyForScript(completeIdea(), completeChecklist(), sameChannel)).toBe(false)

    const sameIdDifferentNames = videos.map((video, index) => ({
      ...video,
      channelName: `Display name ${index}`,
      channelId: videos[0]!.channelId,
    }))
    expect(videoIdeaReadyForScript(completeIdea(), completeChecklist(), sameIdDifferentNames)).toBe(false)

    const unknownChannels = videos.map(video => ({ ...video, channelName: 'Unknown channel', channelId: undefined }))
    expect(videoIdeaReadyForScript(completeIdea(), completeChecklist(), unknownChannels)).toBe(false)

    const oneKnownOneUnknown = [videos[0]!, { ...videos[1]!, channelName: 'Unknown channel', channelId: undefined }]
    expect(videoIdeaReadyForScript(completeIdea(), completeChecklist(), oneKnownOneUnknown)).toBe(false)

    const unknownNamesWithDistinctIds = videos.map(video => ({ ...video, channelName: 'Unknown channel' }))
    expect(videoIdeaReadyForScript(completeIdea(), completeChecklist(), unknownNamesWithDistinctIds)).toBe(true)

    const idAndNameThenNameOnly = [
      videos[0]!,
      { ...videos[1]!, channelName: videos[0]!.channelName, channelId: undefined },
    ]
    expect(videoIdeaReadyForScript(completeIdea(), completeChecklist(), idAndNameThenNameOnly)).toBe(false)
  })

  it('requires at least medium evidence confidence and an explicit produce decision', () => {
    expect(videoIdeaReadyForScript(completeIdea({ evidenceConfidence: 'low' }), completeChecklist(), videos)).toBe(false)
    expect(videoIdeaReadyForScript(completeIdea({ decision: 'revise' }), completeChecklist(), videos)).toBe(false)
    expect(videoIdeaReadyForScript(completeIdea({ decision: 'park' }), completeChecklist(), videos)).toBe(false)
  })

  it('normalizes persisted review data and retains a lock only when the evidence still validates', () => {
    const session = emptyVideoIdeaSession('prices')
    session.idea = completeIdea({ selectionReason: '  Evidence supports B.  ' })
    session.checklist = completeChecklist()
    session.evidence = videos
    session.phase = 'locked'
    session.locked = true

    const restored = normalizeVideoIdeaSession(JSON.parse(JSON.stringify(session)))!
    expect(restored.locked).toBe(true)
    expect(restored.idea.selectionReason).toBe('Evidence supports B.')
    expect(restored.evidence?.map(video => video.url)).toEqual([
      'https://www.youtube.com/watch?v=valid-a',
      'https://www.youtube.com/watch?v=valid-b',
    ])

    const invalid = normalizeVideoIdeaSession({ ...session, evidence: [] })!
    expect(invalid.locked).toBe(false)
    expect(invalid.phase).toBe('research')
  })

  it('keeps existing brief fields when coach output is partial and never treats coach claims as retrieved evidence', () => {
    const session = emptyVideoIdeaSession()
    session.idea = completeIdea({ title: 'Keep this researched title' })
    session.evidence = []
    const turn = parseVideoIdeaResponse(JSON.stringify({
      message: 'A quick partial update.', phase: 'locked', locked: true,
      idea: { title: '   ', demandEvidence: 'https://www.youtube.com/watch?v=forged-a https://www.youtube.com/watch?v=forged-b', decision: 'produce' },
      evidence: videos,
    }))
    const updated = applyVideoIdeaCoachTurn(session, turn)
    expect(updated.idea.title).toBe('Keep this researched title')
    expect(updated.evidence).toEqual([])
    expect(updated.locked).toBe(false)
  })

  it('adds evidence only from successful research results', () => {
    const session = emptyVideoIdeaSession()
    const result = recordIdeaResearch(session, {
      queries: [
        { query: 'failed query', videos: videos.slice(0, 1), error: 'request failed' },
        { query: 'successful query', videos: videos.slice(1) },
      ],
      channels: [
        { channel: 'missing', error: 'not found', snapshot: { channelId: 'UCmissing12345678901234567', name: 'Missing', url: '', videos: videos.slice(0, 1) } },
        { channel: 'found', snapshot: { channelId: 'UCfound12345678901234567', name: 'Found', url: '', videos: [{ ...videos[0]!, videoId: 'channel-hit' }] } },
      ],
    })
    expect(result.evidence?.map(video => video.videoId)).toEqual(['valid-b', 'channel-hit'])

    const failuresOnly = recordIdeaResearch(emptyVideoIdeaSession(), {
      queries: [{ query: 'failed query', videos: videos, error: 'request failed' }],
      channels: [{ channel: 'missing', error: 'not found', snapshot: { channelId: 'UCmissing12345678901234567', name: 'Missing', url: '', videos } }],
    })
    expect(failuresOnly.evidence).toEqual([])
  })

  it('invalidates prior demand review when the subject or selected candidate changes', () => {
    for (const patch of [
      { subject: 'A different topic: household debt.' },
      { selectedCandidate: 'A' },
    ]) {
      const session = emptyVideoIdeaSession()
      session.idea = completeIdea()
      session.checklist = completeChecklist()
      session.evidence = videos
      expect(videoIdeaReadyForScript(session.idea, session.checklist, session.evidence)).toBe(true)

      const updated = applyVideoIdeaCoachTurn(session, parseVideoIdeaResponse(JSON.stringify({
        message: 'Updating the demand review.', phase: 'demand', idea: patch,
      })))
      expect(videoIdeaReadyForScript(updated.idea, updated.checklist, updated.evidence)).toBe(false)
      expect(updated.idea.demandEvidence).toBe('')
      expect(updated.idea.decision).toBe('')
      expect(updated.checklist.demandEvidence).toBe(false)
    }
  })

  it('accepts fresh review fields supplied in the same turn that sets a selected candidate', () => {
    const session = emptyVideoIdeaSession()
    session.idea = completeIdea({
      candidateA: '', candidateB: '', candidateC: '', selectedCandidate: '',
      selectionReason: '', demandEvidence: '', evidenceConfidence: '', evidenceLimitations: '',
      differentiation: '', productionFit: '', packagingAlternatives: '', decision: '',
    })
    session.checklist = completeChecklist()
    session.evidence = videos

    const updated = applyVideoIdeaCoachTurn(session, parseVideoIdeaResponse(JSON.stringify({
      message: 'The comparison and review are complete.', phase: 'locked', locked: true,
      idea: completeIdea(), checklist: completeChecklist(),
    })))
    expect(updated.locked).toBe(true)
    expect(videoIdeaReadyForScript(updated.idea, updated.checklist, updated.evidence)).toBe(true)
  })

  it('stops the coach loop when the brief is fully ready but the response has not locked it', () => {
    const session = emptyVideoIdeaSession()
    session.idea = completeIdea()
    session.checklist = completeChecklist()
    session.evidence = videos
    expect(videoIdeaReadyForScript(session.idea, session.checklist, session.evidence)).toBe(true)

    const unlockedTurn = parseVideoIdeaResponse(JSON.stringify({
      message: 'The review is complete.', phase: 'packaging', locked: false, awaitProducer: false,
    }))
    expect(shouldContinueVideoIdeaCoach(session, unlockedTurn, 0)).toBe(false)
  })
})
