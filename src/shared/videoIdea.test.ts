import { describe, expect, it } from 'vitest'
import {
  applyVideoIdeaCoachTurn,
  composeChannelBriefFromSnapshot,
  composeScriptTopicFromIdea,
  emptyVideoIdeaSession,
  formatVideoIdeaResearch,
  mergeVideoIdeaBrief,
  newerVideoIdeaSession,
  normalizeVideoIdeaSession,
  parseVideoIdeaResponse,
  recoverVideoIdeaFromRawAssistantMessage,
  shouldAllowVideoIdeaResearch,
  shouldContinueVideoIdeaCoach,
  unpaidVideoIdeaGates,
  videoIdeaDemandComplete,
  videoIdeaPackagingComplete,
  videoIdeaReadyForScript,
} from './videoIdea'
import { composeVideoIdeaPrompt } from './videoIdeaPrompt'
import { emptyVisualBible } from './channelProfiles'

const researchedVideos = [
  {
    videoId: 'research-a', title: 'Why prices keep rising', channelName: 'Plain Money',
    channelId: 'UCplainmoney1234567890123', url: 'https://www.youtube.com/watch?v=research-a',
  },
  {
    videoId: 'research-b', title: 'The shrinking paycheck', channelName: 'Everyday Economics',
    channelId: 'UCeveryday12345678901234', url: 'https://www.youtube.com/watch?v=research-b',
  },
]

function reviewedDemandSession() {
  const session = emptyVideoIdeaSession()
  session.evidence = researchedVideos
  session.idea.candidateA = 'A: explain the grocery receipt squeeze.'
  session.idea.candidateB = 'B: show why a saved dollar buys less.'
  session.idea.candidateC = 'C: compare wages with everyday prices.'
  session.idea.selectedCandidate = 'B'
  session.idea.selectionReason = 'It gives the clearest visible change for the target viewer.'
  session.idea.evidenceConfidence = 'medium'
  session.idea.evidenceLimitations = 'Public views do not show click-through or retention.'
  session.idea.demandEvidence = 'Related videos: https://www.youtube.com/watch?v=research-a and https://www.youtube.com/watch?v=research-b'
  session.idea.audience = 'People who feel poorer as prices rise.'
  session.idea.failuresNoted = 'Generic inflation definitions lack a visible personal consequence.'
  session.idea.sameAudienceFit = 'Same money-confused viewer.'
  session.checklist.audienceWritten = true
  session.checklist.demandEvidence = true
  session.checklist.failuresNoted = true
  session.checklist.sameAudience = true
  return session
}

describe('video idea coach', () => {
  it('parses a fenced coach turn and merges the idea brief', () => {
    const turn = parseVideoIdeaResponse(
      [
        '```json',
        JSON.stringify({
          message: 'People already watch why money buys less. Next we package it.',
          phase: 'packaging',
          locked: false,
          researchQueries: ['why is everything so expensive', 'why money loses value'],
          idea: {
            audience: 'People who feel poorer even when the paycheck looks the same.',
            subject: 'Inflation / purchasing power',
            demandEvidence: 'Multiple cost-of-living explainers outperform their own channels.',
            title: 'Why Does Money Lose Value',
          },
          checklist: { audienceWritten: true, demandEvidence: true },
        }),
        '```',
      ].join('\n'),
    )

    expect(turn.phase).toBe('packaging')
    expect(turn.researchQueries).toEqual([
      'why is everything so expensive',
      'why money loses value',
    ])
    expect(turn.idea.title).toBe('Why Does Money Lose Value')

    const session = applyVideoIdeaCoachTurn(emptyVideoIdeaSession('inflation'), turn)
    expect(session.idea.audience).toContain('paycheck')
    expect(session.checklist.demandEvidence).toBe(true)
    expect(session.locked).toBe(false)
    expect(session.messages.at(-1)?.text).toContain('package it')
  })

  it('does not lock until demand, packaging, promised experience, and CTA exist', () => {
    const turn = parseVideoIdeaResponse(
      JSON.stringify({
        message: 'Lock it.',
        phase: 'locked',
        locked: true,
        idea: { title: 'Why Does Money Lose Value', demandEvidence: 'Search demand exists.' },
      }),
    )
    const session = applyVideoIdeaCoachTurn(emptyVideoIdeaSession(), turn)
    expect(session.locked).toBe(false)
    expect(session.phase).not.toBe('locked')
  })

  it('builds a script-creator topic from the locked viewer-decision brief', () => {
    const topic = composeScriptTopicFromIdea({
      audience: 'People confused by rising prices.',
      awareness: 'They feel poorer. They do not yet value the word inflation.',
      subject: 'Inflation',
      demandEvidence: 'Why is everything so expensive outliers across several channels.',
      failuresNoted: '3-point list versions underperformed dense walkthroughs.',
      bridge: 'If you do not understand inflation, you do not understand getting poorer.',
      title: 'Why Does Money Lose Value',
      thumbnailConcept: 'Bux stares at $100 while treat bags shrink.',
      clickReason: 'The number stays 100 while the bags shrink, so they choose the video that shows the trap.',
      promisedExperience: 'A dense teaching story that pays the shrinking-treats click, then names inflation.',
      scriptTopic: 'Bux feels rich, treats get more expensive, mattress cash still says 100.',
      sameAudienceFit: 'Same money-confused viewer as the rest of DoggoBux.',
      cta: 'Subscribe for more terrible money decisions.',
    })
    expect(topic).toContain('Title: Why Does Money Lose Value')
    expect(topic).toContain('Thumbnail:')
    expect(topic).toContain('Click reason:')
    expect(topic).toContain('Promised experience:')
    expect(topic).toContain('Episode sequence:')
    expect(topic).toContain('CTA:')
    const readyIdea = {
      audience: 'a',
      awareness: 'They notice grocery prices rising.',
      subject: 'b',
      demandEvidence: 'https://www.youtube.com/watch?v=research-a https://www.youtube.com/watch?v=research-b',
      failuresNoted: 'Generic definitions lack a visible consequence.',
      bridge: '',
      title: 'Title',
      thumbnailConcept: 'Thumb',
      clickReason: 'Clearer reason than the alternatives.',
      promisedExperience: 'Pay the click with a short teaching story.',
      scriptTopic: 'Angle',
      sameAudienceFit: 'Same target viewer.',
      cta: 'Subscribe for the next explanation.',
      candidateA: 'Receipt squeeze', candidateB: 'Shrinking dollar', candidateC: 'Wages versus prices',
      selectedCandidate: 'B', selectionReason: 'The clearest visible change.',
      evidenceConfidence: 'high', evidenceLimitations: 'Views do not establish satisfaction.',
      differentiation: 'A concrete story about one unchanged dollar.',
      productionFit: 'Open on a receipt; simple props and animation.',
      packagingAlternatives: '1. A / receipt; 2. B / dollar; 3. C / wage chart.',
      decision: 'produce',
    }
    const readyChecklist = {
      audienceWritten: true, demandEvidence: true, failuresNoted: true, sameAudience: true,
      titleReady: true, thumbnailReady: true, experienceReady: true, ctaReady: true,
    }
    expect(videoIdeaReadyForScript(readyIdea, readyChecklist, researchedVideos)).toBe(true)
  })

  it('keeps non-empty brief fields when a patch is partial', () => {
    const merged = mergeVideoIdeaBrief(
      { ...emptyVideoIdeaSession().idea, title: 'Keep me', audience: 'Old audience' },
      { audience: 'New audience', title: '   ' },
    )
    expect(merged.title).toBe('Keep me')
    expect(merged.audience).toBe('New audience')
  })

  it('prefers the newer idea session when saves race', () => {
    const older = { ...emptyVideoIdeaSession('a'), updatedAt: '2026-01-01T00:00:00.000Z' }
    const newer = { ...emptyVideoIdeaSession('b'), updatedAt: '2026-02-01T00:00:00.000Z' }
    expect(newerVideoIdeaSession(older, newer)?.seed).toBe('b')
    expect(normalizeVideoIdeaSession({ phase: 'nope', idea: { title: 1 } })?.phase).toBe('idle')
  })

  it('formats YouTube research for the next coach turn', () => {
    const text = formatVideoIdeaResearch({
      queries: [
        {
          query: 'why money loses value',
          videos: [
            {
              videoId: 'abc',
              title: 'Why Your Money Buys Less',
              channelName: 'Plain Money',
              url: 'https://www.youtube.com/watch?v=abc',
              viewCountText: '1.2M views',
            },
          ],
        },
      ],
      channels: [{ channel: '@plainmoney', error: 'Channel was not found.' }],
    })
    expect(text).toContain('SEARCH "why money loses value"')
    expect(text).toContain('Why Your Money Buys Less')
    expect(text).toContain('CHANNEL "@plainmoney" failed')
  })

  it('asks the coach to prove demand before packaging and return JSON', () => {
    const prompt = composeVideoIdeaPrompt({
      channelName: 'DoggoBux',
      visualBible: emptyVisualBible('DoggoBux'),
      stillCastEnabled: true,
      session: emptyVideoIdeaSession('inflation'),
      userMessage: 'Start with inflation.',
    })
    expect(prompt).toContain('Demand test')
    expect(prompt).toContain('Choice psychology')
    expect(prompt).toContain('Promise, Proof, Plan')
    expect(prompt).toContain('most useful next step')
    expect(prompt).toContain('Never DB')
    expect(prompt).toContain('friendly third-person narrator')
    expect(prompt).toContain('two escalating mistakes')
    expect(prompt).toContain('Bux is the on-screen protagonist, not the speaker')
    expect(prompt).toContain('reusable main character across many content types')
    expect(prompt).toContain('Never assume personal finance')
    expect(prompt).not.toContain('DoggoBux finance facts')
    expect(prompt).toContain('three materially different directions')
    expect(prompt).toContain('Stakes / fear')
    expect(prompt).toContain('zero to four words')
    expect(prompt).toContain('KEEP IT SIMPLE')
    expect(prompt).toContain('Emotion: ...; Visual: ...; Text: ...; Open loop: ...')
    expect(prompt).toContain('Do not set thumbnailReady true')
    expect(prompt).toContain('PRODUCER MESSAGE:')
    expect(prompt).toContain('Start with inflation.')
    expect(prompt).toContain('Return JSON only')
    expect(prompt).toContain('Unpaid gates:')
    expect(prompt).not.toContain('Expression: Voice line')
  })

  it('continues into packaging after demand is proven instead of waiting or searching more', () => {
    const session = reviewedDemandSession()
    expect(videoIdeaDemandComplete(session)).toBe(true)
    expect(videoIdeaPackagingComplete(session)).toBe(false)
    expect(unpaidVideoIdeaGates(session)).toEqual(expect.arrayContaining([
      'thumbnail',
      'title',
      'click reason',
      'promised experience',
      'episode sequence',
      'cta',
    ]))
    expect(shouldAllowVideoIdeaResearch(session, 1)).toBe(false)

    const moreResearch = parseVideoIdeaResponse(
      JSON.stringify({
        message: 'We still need more channel research.',
        phase: 'research',
        researchQueries: ['another search'],
        awaitProducer: false,
      }),
    )
    expect(shouldContinueVideoIdeaCoach(session, moreResearch, 3)).toBe(false)

    const packageNext = parseVideoIdeaResponse(
      JSON.stringify({ message: 'Now compare packaging options.', phase: 'packaging' }),
    )
    expect(shouldContinueVideoIdeaCoach(session, packageNext, 3)).toBe(true)

    const audienceQuestion = parseVideoIdeaResponse(
      JSON.stringify({
        message: 'Who is this for?',
        phase: 'audience',
        awaitProducer: false,
      }),
    )
    expect(shouldContinueVideoIdeaCoach(emptyVideoIdeaSession(), audienceQuestion, 0)).toBe(false)
  })

  it('keeps coaching after title and thumbnail until the promised experience and CTA exist', () => {
    const session = reviewedDemandSession()
    session.idea.title = 'Why Does Money Lose Value'
    session.idea.thumbnailConcept = 'Treat bags shrink beside a $100 bill.'
    session.idea.scriptTopic = 'Bux hides cash, store prices rise.'
    session.checklist.audienceWritten = true
    session.checklist.demandEvidence = true
    session.checklist.sameAudience = true
    session.checklist.titleReady = true
    session.checklist.thumbnailReady = true
    expect(videoIdeaPackagingComplete(session)).toBe(false)
    expect(videoIdeaReadyForScript(session.idea, session.checklist)).toBe(false)
    expect(
      shouldContinueVideoIdeaCoach(
        session,
        parseVideoIdeaResponse(JSON.stringify({ message: 'Title is drafted.', phase: 'packaging' })),
        3,
      ),
    ).toBe(true)
  })

  it('tells the coach to package when demand is already proven', () => {
    const session = emptyVideoIdeaSession()
    session.idea.audience = 'People afraid their money is quietly losing value.'
    session.checklist.audienceWritten = true
    const prompt = composeVideoIdeaPrompt({
      channelName: 'DoggoBux',
      visualBible: emptyVisualBible('DoggoBux'),
      stillCastEnabled: true,
      session,
      forcePackaging: true,
    })
    expect(prompt).toContain('three required emotional thumbnail directions')
    expect(prompt).toContain('put that winner in thumbnailConcept')
    expect(prompt).toContain('Do not request more YouTube searches')
  })

  it('injects channel niche and brief into the coach prompt', () => {
    const prompt = composeVideoIdeaPrompt({
      channelName: 'BuxFit',
      niche: 'Personal Fitness',
      youtubeHandle: '@BuxFit',
      channelBrief: 'BuxFit · @BuxFit\nRecent uploads...',
      visualBible: emptyVisualBible('BuxFit'),
      stillCastEnabled: true,
      session: emptyVideoIdeaSession(),
    })
    expect(prompt).toContain('Niche / topic: Personal Fitness')
    expect(prompt).toContain('YouTube handle: @BuxFit')
    expect(prompt).toContain('Channel brief (identity + recurring formats')
    expect(prompt).toContain('Recent uploads...')
    expect(prompt).toContain('Do not treat the channel brief as demand evidence')
    expect(prompt).toContain('Bux narration facts')
    expect(prompt).toContain('friendly third-person narrator')
    expect(prompt).not.toContain('DoggoBux finance facts')
    expect(prompt).not.toContain('crypto casino lore')
  })

  it('uses a custom idea guide file instead of the built-in default', () => {
    const prompt = composeVideoIdeaPrompt({
      channelName: 'BuxFit',
      ideaGuide: 'CUSTOM IDEA PROCESS: always start with thumbnail psychology.',
      visualBible: emptyVisualBible('BuxFit'),
      stillCastEnabled: true,
      session: emptyVideoIdeaSession(),
    })
    expect(prompt).toContain('CUSTOM IDEA PROCESS: always start with thumbnail psychology.')
    expect(prompt).not.toContain('STEP 1 — Demand psychology')
  })

  it('formats a channel identity brief from a YouTube snapshot', () => {
    const brief = composeChannelBriefFromSnapshot({
      channelId: 'UCtest',
      name: 'Nischa',
      handle: '@nischa',
      url: 'https://www.youtube.com/@nischa',
      videos: [
        {
          videoId: 'abc',
          title: 'Gym newbie plan',
          channelName: 'Nischa',
          url: 'https://www.youtube.com/watch?v=abc',
          viewCountText: '1.2M views',
          published: '2 weeks ago',
        },
      ],
    })
    expect(brief).toContain('Nischa · @nischa')
    expect(brief).toContain('not demand proof for a new episode')
    expect(brief).toContain('Gym newbie plan')
  })

  it('repairs truncated coach JSON and recovers a dumped assistant bubble', () => {
    const truncated = [
      '{',
      '"message":"Demand is strong enough. The full brief is locked.",',
      '"phase":"locked",',
      '"locked":true,',
      '"awaitProducer":false,',
      '"idea":{',
      '"audience":"Beginning lifters who want a safe first squat.",',
      '"awareness":"They know what a squat is.",',
      '"subject":"Beginner squat form.",',
      '"demandEvidence":"Repeated high-view squat form videos across channels.",',
      '"failuresNoted":"Generic tutorial framing underperforms.",',
      '"bridge":"Direct demand.",',
      '"title":"Your First Squat: 3 Form Cues That Matter",',
      '"thumbnailConcept":"Bux squat with red-X vs green-check.",',
      '"clickReason":"Three cues for the first rep, not an anatomy lecture.",',
      '"promisedExperience":"Clear first-rep coaching with three cues.",',
      '"scriptTopic":"Promise, proof, plan through three squat cues.",',
      '"sameAudienceFit":"Same beginner fitness audience.",',
      '"cta":"Save the cues and subscribe for the next movement.",',
      '"checklist":{"audienceWritten":true,"demandEvidence":true,"failuresNoted":true,"sameAudience":true,"titleReady":true,"thumbnailReady":true,"experienceReady":true,"ctaReady":true}',
    ].join('')

    const turn = parseVideoIdeaResponse(truncated)
    expect(turn.message).toBe('Demand is strong enough. The full brief is locked.')
    expect(turn.locked).toBe(true)
    expect(turn.idea.title).toBe('Your First Squat: 3 Form Cues That Matter')
    expect(turn.checklist.titleReady).toBe(true)

    const stuck = emptyVideoIdeaSession()
    stuck.messages = [
      {
        id: 'raw',
        role: 'assistant',
        text: truncated,
        createdAt: new Date().toISOString(),
      },
    ]
    const recovered = recoverVideoIdeaFromRawAssistantMessage(stuck)
    expect(recovered.locked).toBe(false)
    expect(recovered.phase).not.toBe('locked')
    expect(recovered.messages.at(-1)?.text).toBe('Demand is strong enough. The full brief is locked.')
    expect(recovered.idea.cta).toContain('Save the cues')
  })
})
