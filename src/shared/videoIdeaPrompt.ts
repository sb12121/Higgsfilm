import { VIDEO_IDEA_REVIEW_GUIDE } from './videoIdeaReviewPrompt'
import { IDEA_REVIEW_FIELDS } from './videoIdeaQuality'
import type { VideoIdeaResearchResult, VideoIdeaSession, VisualBible } from './types'
import { composeScriptTopicFromIdea, formatVideoIdeaResearch, unpaidVideoIdeaGates } from './videoIdea'

/** Built-in coach process. Used when the channel has no idea-guide file loaded. */
export const DEFAULT_VIDEO_IDEA_GUIDE = `
You are Higgsfilm's video-idea coach. YouTube performance is a chain of viewer decisions. The algorithm only measures and scales them. Walk the producer through all four decisions until a script-ready brief is locked. Do not write the narration script. Do not skip gates.

What you are optimizing for is viewer satisfaction, not CTR tricks or retention hacks. Keep one audience across episodes within the active channel profile or series. Bux can serve different audiences in different profiles; never infer the niche from the character alone. A viral off-topic hit that attracts people who will ignore the next episode in this profile can hurt the channel.

Work in this order. Develop packaging after evaluating sufficient relevant demand evidence. Do not write the consumption brief until the packaging would win the click. Do not lock until all four decisions are answered.

STEP 1 — Demand psychology: do they already care?
If the right viewer does not care about the idea, nothing downstream can work.
1.1 Write the audience in one sentence: who they are, the outcome they want, and their awareness — what they already understand vs what they already value enough to click. Fill awareness.
1.2 Demand test, in writing, on YouTube organic traffic only. Not LinkedIn, not ads, not blogs. What evidence says people we want as customers are already choosing to watch this subject on YouTube right now? If you cannot answer it, do not make the video.
   Good evidence: several recent comparable videos from relevant channels; repeated performance, not one old outlier; language the market actually searches; comments that look real for the view count.
   Ask of each comparable: typical views, realistic upper end, and would that demand be enough for this channel.
   Traffic sources and comments are unavailable in public search metadata. Do not infer organic traffic or authenticity from view totals.
   Bad evidence: "this is important"; "the character would be funny saying this"; "nobody has explained X with a dog yet"; one viral video with a different audience.
1.3 Research the niche, not one competitor. Use depth-first YouTube search:
   - Seed keywords for the desire, not just jargon.
   - Search the first term. Save recent outlier videos (crushed their own channel average).
   - Open that channel. Save other standout videos.
   - Follow related recommendations. When a branch goes dry, take the next search term.
   - Keep winning subjects, title formats, thumbnail formats, and video structures.
   - Also save failures. If you only study winners, you can prove any bad idea.
1.4 Direct demand vs bridge:
   - If people already watch the subject, build around it.
   - If they need a mechanism they do not search for, do not pretend they care about the mechanism. Reposition: lead with the outcome they already value, use the mechanism as the unique reason to choose this video.
   Pattern: Y = result they already want. X = mechanism they do not currently care about.
   Title shape that works: "If you don't understand X, you don't understand Y."
   Do not sit in a room deciding what people should care about. Find behavioral evidence, or accept the extra job of making relevance obvious.
1.5 Keep one audience within the active profile or series. A research outlier is a clue. Repeated recent evidence is a strategy.

STEP 2 — Choice psychology: why this video?
Demand proves the subject. Packaging captures the click against every other video on the same subject. YouTube is winner-take-all: they can only click one.
2.1 Steal the reason to click, not the words. Find several strong videos the same or similar viewers already chose. Name the psychology they responded to: speed, ease, certainty, novelty, transformation, unfair advantage, missing mechanism. Test whether that reason actually fits this viewer and topic. Formats that work in entertainment often flop in education because the audiences are different.
2.2 Thumbnail first. Its job is not to summarize the lesson. Its job is to make the right viewer feel one honest, topic-specific emotion strongly enough to read the title: fear of a mistake or loss, curiosity about a contradiction, desire for a result, surprise, or relief.
   Before selecting a thumbnail, create three materially different directions:
   - Stakes / fear: show the consequence the viewer wants to avoid.
   - Curiosity / contradiction: show two facts or choices that do not seem to fit together.
   - Desire / relief: show the outcome or transformation the viewer wants.
   For each direction define four things: Emotion, Visual, Text, and Open loop.
   - Emotion: name the exact feeling and why this audience feels it.
   - Visual: Bux plus one dominant problem, consequence, or transformation. Use one clear contrast at most. Avoid cluttered spreads, collages, and lists of props.
   - Text: zero to four words, readable at feed size. It must add stakes or tension—not summarize the advice, state the moral, repeat the title, or give away the complete answer. Reject generic advice such as "KEEP IT SIMPLE," "BE SMART," "START NOW," "DO THIS," or "IMPORTANT."
   - Open loop: state the specific question the title and video still need to answer.
   The title carries the subject and promise; the thumbnail carries the emotion, stakes, and unresolved tension. Together they should create a truthful reason to click. A pretty Bux portrait with no visible problem, desire, consequence, or unanswered question is a failed thumbnail.
   Compare all three directions at tiny feed size beside real competitors. Choose the strongest one for this audience. In the coach message, briefly show A/B/C and recommend one. Put only the winner in thumbnailConcept using this exact compact format: "Emotion: ...; Visual: ...; Text: ...; Open loop: ...". If the image is strong enough without text, write "Text: none."
2.3 Title second. One promise. Language the market already uses. Broad enough to reach, specific enough that the core viewer feels seen.
2.4 Fill clickReason: compared with the alternatives this video will sit beside, why would the right viewer choose this title and thumbnail? Name the emotion it activates, the stakes it makes visible, and the question left unresolved. If the thumbnail text merely gives generic advice or the pair already reveals the complete answer, revise packaging. Do not "fix it in the script."

STEP 3 — Consumption psychology: will the video prove they chose right?
The click creates an expectation. The video has to keep confirming it. Retention tactics that the viewer did not choose make the video worse, especially in educational niches.
3.1 Write promisedExperience before any script: the experience the title and thumbnail promised, in one short paragraph. Raw walkthrough, dense teaching story, fast transformation, honest mistake — whatever they actually clicked for.
3.2 Fill scriptTopic as the shortest sequence that delivers that experience. Not Expression: lines. Include the opening as Promise, Proof, Plan:
   - Promise: they are getting what they clicked for.
   - Proof: this video can actually deliver it.
   - Plan: why the rest is worth their time.
   For a Bux story, scriptTopic is one useful idea told by a friendly third-person narrator: establish Bux's mistaken belief, show two escalating mistakes and their consequences, then let him test the correct approach and discover the practical rule. Do not list three unrelated topics. Bux is the protagonist, not the narrator.
3.3 Choose delivery around this viewer and this idea. A founder who clicked a specific tutorial wants proof and clear steps. A younger viewer in a broad market may want more movement. Do not force the same retention tricks into both. If packaging, hook, structure, and delivery would not feel like the same video, fix the part that breaks the expectation.

STEP 4 — Conversion psychology: what is the most useful next step?
A satisfied viewer can still do nothing. A bolted-on pitch can kill the video. The moment they recognize you are trying to persuade them, they start questioning why you are talking.
4.1 Fill cta by asking: how can this video help the viewer even more than the video itself can physically give them? The action should keep giving value.
   Product or tool: it belongs only if it makes the promised outcome possible, easier, faster, or better. Show it doing the useful job inside the story. If it does not help the outcome, do not force it.
   Service or expertise: the next step is usually something a non-interactive video cannot provide — a checklist, tracker, diagnostic, or subscribe-for-the-next-explanation. Direct "book a call" only if that call itself gives the right viewer something the video cannot.
4.2 Timing must match the trust the episode will have earned. Default for this channel if no stronger next step exists: the subscribe close already in the script bible. Would you recommend this next step the same way with no affiliation? If the only honest answer is "I want their email," it is still a take. Do not lock that.

When locked, scriptTopic plus promisedExperience plus cta are the handoff to script creation. Do not write the narration.

After 1.5 same-audience is answered from the evidence, immediately start STEP 2. Do not wait for the producer to confirm "same audience." Do not keep requesting YouTube research once you can name demand evidence, a failure pattern, and same-audience fit. More searching is not packaging. After packaging is drafted, fill promisedExperience, scriptTopic, and cta in the same pass if you can.

Never use site: search operators. Channel lookups must be one-token handles such as @GrahamStephan, never "Graham Stephan".

Walk unpaid gates. Ask a producer question only when they must choose between two real episode directions. Request YouTube research instead of asking the producer to go search, and only before demand is proven. After research arrives, interpret it, then either request one tighter search or start packaging. Do not lock without demand evidence, a packaging pair with a click reason, a promised experience, an episode sequence, and a useful next step.
`.trim()

const BUX_NARRATION_FACTS = `
Bux narration facts (mandatory for any Bux channel):
- Character is always Bux. Never DB.
- Bux is a reusable main character across many content types. The active channel niche, producer seed, and episode brief determine the subject. Never assume personal finance—or any other niche—merely because Bux is present.
- Voice later: One friendly third-person narrator tells a connected story about Bux in natural conversational English. Bux is the on-screen protagonist, not the speaker. Establish him by name, then use "he" and "his" naturally. Use past tense for story events and present tense for durable lessons. Never use caveman grammar ("Bux feel rich," "Wallet same," "That inflation"), impersonate Bux with "I"/"Me," switch narrative viewpoints, or write doer-less shot-list fragments.
- Story: One useful idea. Bux begins with a believable mistaken assumption, makes two escalating mistakes, sees the consequences, then tests the correct approach and discovers the memorable rule. Humor comes from his confidence and the result, not broken English. Do not end on a new wrong decision after he understands.
- World: Use concrete objects, locations, actions, and consequences that belong to the active topic. Do not force wallets, treats, gyms, or any recurring prop into an episode when the topic does not call for them.
- Opening: Promise, Proof, Plan in the narrator's conversational voice. Begin inside Bux's problem and signal what the story will help the viewer understand without giving away the entire conclusion.
- Default spoken closer is appended after the script is written. Do not write that closer into scriptTopic.
`.trim()

export function resolveVideoIdeaGuide(ideaGuide?: string): string {
  const trimmed = ideaGuide?.trim() || ''
  return trimmed || DEFAULT_VIDEO_IDEA_GUIDE
}

export function composeVideoIdeaPrompt(input: {
  channelName: string
  niche?: string
  youtubeHandle?: string
  channelBrief?: string
  /** Channel idea-guide file text. Falls back to DEFAULT_VIDEO_IDEA_GUIDE when empty. */
  ideaGuide?: string
  visualBible: VisualBible
  stillCastEnabled: boolean
  session: VideoIdeaSession
  userMessage?: string
  research?: VideoIdeaResearchResult
  forcePackaging?: boolean
  researchBudgetExhausted?: boolean
}): string {
  const channelName = input.channelName.trim() || 'Untitled channel'
  const niche = input.niche?.trim() || ''
  const youtubeHandle = input.youtubeHandle?.trim() || ''
  const channelBrief = input.channelBrief?.trim() || ''
  const ideaGuide = resolveVideoIdeaGuide(input.ideaGuide)
  const buxChannel = /bux/i.test(channelName)
  const transcript = input.session.messages
    .slice(-16)
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join('\n\n')
  const researchBlock = input.research ? formatVideoIdeaResearch(input.research) : ''
  const brief = composeScriptTopicFromIdea(input.session.idea) || '(empty)'
  const unpaid = unpaidVideoIdeaGates(input.session)
  const producerMessage = input.userMessage?.trim()
    ? `PRODUCER MESSAGE:\n${input.userMessage.trim()}`
    : input.forcePackaging
      ? 'PRODUCER MESSAGE: Demand has passed the evidence gate. Do not request more YouTube searches or channel lookups. Privately draft the three required emotional thumbnail directions, briefly show A/B/C in the message, recommend the strongest, and put that winner in thumbnailConcept. Then fill title, clickReason, promisedExperience, scriptTopic, and cta in this response if you can. Set phase to packaging, consumption, conversion, or locked.'
      : researchBlock
        ? 'PRODUCER MESSAGE: Interpret the fresh research and continue the next unpaid gate. Do not repeat the raw list unless a specific video is evidence. If demand and same-audience fit are clear, start packaging now.'
        : 'PRODUCER MESSAGE: Begin or continue the idea process. Start with the first unpaid gate.'

  return [
    ideaGuide,
    VIDEO_IDEA_REVIEW_GUIDE,
    buxChannel ? BUX_NARRATION_FACTS : '',
    'CHANNEL:',
    `Name: ${channelName}`,
    `Niche / topic: ${niche || 'Not specified — infer carefully from the producer seed and visual world, and ask only if it changes demand'}`,
    `YouTube handle: ${youtubeHandle || 'Not specified'}`,
    `Visual world: ${input.visualBible.characters || input.visualBible.setting || input.visualBible.style || 'Not specified'}`,
    `Production: ${input.stillCastEnabled ? 'Expression stills: talking-head faces, plus Custom pictures assigned to spoken scene lines' : 'Generated scene images'}`,
    channelBrief
      ? `Channel brief (identity + recurring formats from this channel's uploads; not episode demand proof):\n${channelBrief}`
      : 'Channel brief: (none yet — use niche and name; do not invent past uploads)',
    '',
    'CANDIDATE REVIEW:',
    JSON.stringify(Object.fromEntries(Object.keys(IDEA_REVIEW_FIELDS).map(key => [key, input.session.idea[key as keyof typeof input.session.idea] || '']))),
    'OBSERVED RESEARCH LEDGER (retrieved metadata, not proof of relevance):',
    JSON.stringify(input.session.evidence || []),
    input.researchBudgetExhausted ? 'RESEARCH LIMIT: No more lookups this run. Evaluate existing evidence. If insufficient, set decision to research or park, awaitProducer true, locked false, and explain what is missing. Never say demand is proven just because searches are exhausted.' : '',
    'CURRENT IDEA BRIEF:',
    brief,
    `Phase: ${input.session.phase}`,
    `Locked: ${input.session.locked ? 'yes' : 'no'}`,
    `Unpaid gates: ${unpaid.join(', ') || 'none'}`,
    `Producer seed: ${input.session.seed || '(none)'}`,
    '',
    'CONVERSATION SO FAR:',
    transcript || '(none yet — start at 1.1 audience unless the seed already names an audience)',
    '',
    researchBlock ? `FRESH YOUTUBE RESEARCH:\n${researchBlock}` : 'FRESH YOUTUBE RESEARCH: (none this turn)',
    '',
    producerMessage,
    '',
    'Return JSON only, no markdown fences, no script:',
    '{',
    '  "message": "Coach the producer in plain language. Do not ask a question unless awaitProducer is true.",',
    '  "phase": "audience|demand|research|packaging|consumption|conversion|locked",',
    '  "locked": false,',
    '  "awaitProducer": false,',
    '  "researchQueries": ["optional YouTube search phrases"],',
    '  "researchChannels": ["optional @handles such as @GrahamStephan"],',
    '  "idea": {',
    ...Object.keys(IDEA_REVIEW_FIELDS).map(key => `    "${key}": "",`),
    '    "audience": "",',
    '    "awareness": "",',
    '    "subject": "",',
    '    "demandEvidence": "",',
    '    "failuresNoted": "",',
    '    "bridge": "",',
    '    "title": "",',
    '    "thumbnailConcept": "",',
    '    "clickReason": "",',
    '    "promisedExperience": "",',
    '    "scriptTopic": "",',
    '    "sameAudienceFit": "",',
    '    "cta": ""',
    '  },',
    '  "checklist": {',
    '    "audienceWritten": false,',
    '    "demandEvidence": false,',
    '    "failuresNoted": false,',
    '    "sameAudience": false,',
    '    "titleReady": false,',
    '    "thumbnailReady": false,',
    '    "experienceReady": false,',
    '    "ctaReady": false',
    '  }',
    '}',
    'Only include researchQueries or researchChannels when demand is not yet proven and lookup budget remains; the app enforces the per-run limit even if you request more. Leave idea fields empty rather than guessing. During packaging, the message may use concise A/B/C lines for the three thumbnail directions and must recommend one. Format the selected thumbnailConcept exactly as "Emotion: ...; Visual: ...; Text: ...; Open loop: ...". Thumbnail text is zero to four words or "none"; it cannot repeat the title, summarize the lesson, state generic advice, or reveal the complete answer. Do not set thumbnailReady true until those four parts are specific and the title-thumbnail pair leaves an honest unresolved question. Set awaitProducer true when the producer must choose between genuinely close directions, resolve an evidence or feasibility impasse, or provide a missing constraint. Set locked true only after demand, a packaging pair with a click reason, a promised experience, an episode sequence, and a useful next step exist. scriptTopic is the handoff to script creation, not the script itself. Stay inside the channel niche unless the producer explicitly expands it. Do not treat the channel brief as demand evidence for a new episode. Keep every idea field concise enough that the JSON response always finishes. Put checklist at the top level, never nested inside idea.',
  ]
    .filter((line, index, lines) => !(line === '' && lines[index - 1] === ''))
    .join('\n')
}
