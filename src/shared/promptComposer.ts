import type {
  AspectRatio,
  ProjectManifest,
  SceneDirectionRecord,
  SequenceId,
  VisualBible,
} from './types'
import { sceneContextFingerprint } from './sceneContext'
import { composeZImageTurboPrompt } from './zImageTurboPrompting'

export function composeScenePrompt(
  text: string,
  sceneDescription?: string,
): string {
  return [
    `Create a single visual scene for this narration: "${text}"`,
    ...(sceneDescription ? [`Scene direction: ${sceneDescription}`] : []),
  ].join('\n')
}

export function composeGenerationPrompt(
  scenePrompt: string,
  visualBible: VisualBible,
  aspectRatio: AspectRatio = '16:9',
  continuitySummary?: string,
  sceneRecord?: SceneDirectionRecord,
): string {
  return [
    sceneDescriptionForGeneration(scenePrompt, sceneRecord),
    ...(sceneRecord ? [canonicalSceneRecordText(sceneRecord)] : []),
    `Composition format: ${aspectRatio} aspect ratio. Frame the important action and character safely inside the ${aspectRatio} canvas.`,
    ...(continuitySummary?.trim()
      ? [
          `Whole-script continuity canon: ${continuitySummary.trim()}`,
          'Preserve the exact established subject, species, cast, setting, props, and visual identity from the continuity canon. Do not replace an established subject with a guessed or more common subject.',
        ]
      : []),
    `Style: ${visualBible.style}`,
    `Characters: ${visualBible.characters}`,
    ...characterLockPromptLines(visualBible),
    `Setting: ${visualBible.setting}`,
    `Palette: ${visualBible.palette}`,
    `Camera: ${visualBible.camera}`,
    `Avoid: ${visualBible.negativePrompt}`,
    'The project visual bible is authoritative. If an older scene direction conflicts with it, reinterpret that direction in the current rounded 2D cartoon style rather than reproducing the older art style.',
    'Character continuity requirements: When the recurring main protagonist is visible, render the same rounded design and solid flat colors, including the face, hair or fur, clothing, body, and identifying accessories. Do not force the protagonist into every scene. Never render the protagonist as black-and-white outlines only or leave visible color fills unfilled. Give every human and animal character a clearly expressive face with visible eyes, eyebrows, and mouth that communicate the action. Keep faces stylized and simple, not photorealistic.',
    'Visible character detail requirements: Every visible character—human, animal, or cartoon figure—must have a readable, intentionally drawn face unless the character is explicitly turned away or fully occluded. Show two visible eyes, expressive eyebrows, a simple nose or facial mark, and a clearly shaped mouth; make the eyes, eyebrows, and mouth large enough to read at the requested framing. Use complete rounded cartoon bodies, natural human hands or animal paws, clothing, hair or fur, and clear silhouettes rather than line-body figures or circular-head-only designs. Never leave a character featureless, faceless, or expressionless.',
    animalInteractionInstruction(sceneRecord),
    'Creative variation requirements: Follow purposeful visual variation only when the scene direction explicitly calls for it. Do not add symbols, text, overlays, or visual gimmicks that are not present in the scene direction. Do not force the recurring protagonist into every frame, and do not turn every narration line into a literal protagonist action. Keep any purposeful variation clearly readable and thematically connected.',
    'Keep the composition readable and leave safe space for optional captions.',
  ].join('\n')
}

export function composeZImagePrompt(
  scenePrompt: string,
  visualBible: VisualBible,
  aspectRatio: AspectRatio = '16:9',
  sceneRecord?: SceneDirectionRecord,
): string {
  return composeZImageTurboPrompt({
    direction: sceneDescriptionForGeneration(scenePrompt, sceneRecord),
    visualBible,
    aspectRatio,
    sceneRecord,
  })
}

export function scriptSummaryForSequence(
  manifest: ProjectManifest,
  sequence: SequenceId,
): string {
  const sequenceData =
    sequence === 'trailer' ? manifest.trailer : manifest
  const fingerprint = sequenceData?.scriptSummaryFingerprint
  if (fingerprint && fingerprint !== sceneContextFingerprint(manifest, sequence)) return ''
  const summary =
    sequence === 'trailer'
      ? manifest.trailer?.continuityCanon?.summary ||
        manifest.trailer?.scriptSummary ||
        manifest.continuityCanon?.summary ||
        manifest.scriptSummary
      : manifest.continuityCanon?.summary || manifest.scriptSummary
  return summary?.trim() || ''
}

export function composeScriptDraftPrompt(topic: string, scriptBible: string): string {
  return [
    'Write a complete narration script for this video topic.',
    'Follow the SCRIPT BIBLE exactly. It defines format, structure, voice, length, and any required line prefixes or stanza breaks.',
    'Pay the click. If TOPIC names a Title, Thumbnail, or Promised experience, open by reaffirming that promise, proving this video can deliver it, then giving a short plan for the rest (Promise, Proof, Plan) in the narration voice from the SCRIPT BIBLE.',
    'Treat the selected title, thumbnail promise, differentiation, and production constraints in TOPIC and the approved brief as authoritative. Keep the episode recognizably about that promise from its opening through its payoff; use the CTA or next-step brief to shape the useful payoff, while the app supplies the fixed spoken outro.',
    'Popularity on public YouTube is evidence of audience interest, not proof that a health, fitness, or other factual claim is true. Never invent studies, statistics, citations, guaranteed results, or certainty. Preserve the limits and uncertainty stated in the approved brief, and make clear what the story illustrates versus what evidence establishes.',
    'If TOPIC describes the thumbnail as Emotion, Visual, Text, and Open loop, make the opening 5–8 lines immediately show the promised situation or stakes and make the story answer that open loop. Do not merely repeat the thumbnail text, reveal the full answer in line one, or drift to a different problem.',
    'The whole script must feel like the same video the packaging promised. Do not bait-and-switch into a different lecture, and do not add retention tactics, open loops, or extra structure the viewer did not choose.',
    'If the SCRIPT BIBLE uses a mistake-and-discovery story: teach one lesson through two escalating mistakes, then a correct attempt, payoff, and memorable rule. Show why each choice made sense to the character, what consequence exposed the flaw, and how the final attempt proves the solution. Do not teach three different topics or end on a new wrong decision after the character understands.',
    'Do not write a like, subscribe, comment, or next-video closer. End when the lesson lands. A fixed channel outro is appended after you finish.',
    'Write only the 16:9 episode. Do not write a 9:16 condensed cut, Shorts script, or second version. That vertical cut is generated separately after this draft.',
    'Optimize for viewer satisfaction: they should feel they chose the right video.',
    'Before returning the draft, privately read it aloud and review whether the opening demonstrates the promised situation, the causal story delivers the approved promise, and the payoff gives the useful next step. Remove padded fragments and keyword stacking. Return only the final script; do not include the review or ask for a second model pass.',
    'Return only the script. Do not wrap it in markdown fences. Do not add a title, synopsis, commentary, or heading before or after the script.',
    '',
    'SCRIPT BIBLE:',
    scriptBible.trim(),
    '',
    'TOPIC:',
    topic.trim(),
    '',
    'HARD RULES FOR EVERY LINE:',
    'Every line is recorded as voice. There are no silent pictures, image-only beats, stage directions, captions, or shot lists.',
    'If the SCRIPT BIBLE uses Custom:, Custom is only a picture label on a line the narrator would still say with the pictures muted.',
    'Do not invent extra Custom lines to hold pictures. Put Custom on spoken narration that already belongs in the story.',
    'Illegal Custom: "March toward treat store.", "Place wallet on counter.", "Stare at bigger price tag.", "Drop hips down.", "Five dollar treats fill basket.", "Treat factory pays more flour."',
    'Legal Custom, because they are spoken narration: "Bux opened his wallet and counted one hundred dollars.", "At the store, that money bought twenty bags of treats.", "A month later, each bag cost seven dollars.", "As he squatted, his heels lifted off the floor."',
    'If the SCRIPT BIBLE is a Bux channel: Bux is the reusable main character, not the niche; the TOPIC and channel profile determine the subject, so never assume personal finance or any other category. Use one friendly third-person narrator telling a connected story about Bux. Bux is the on-screen protagonist, not the speaker. Use natural conversational English, complete thoughts, and clear transitions. Establish Bux by name, then alternate naturally with "he" and "his." Use past tense for story events and present tense for durable lessons. Never use caveman grammar such as "Bux feel rich," "Wallet same," or "That inflation." Do not impersonate Bux with "I" or "Me," switch voices, or leave doer-less shot-list fragments.',
    'If the SCRIPT BIBLE uses Custom:, every spoken line must be a Custom scene picture. Do not use standard expression prefixes. Put Custom on every spoken proof, action, reaction, and story line. Chain as many adjacent Custom lines as the visual sentence needs. Keep body narration lines to about 2–4 seconds of speech; if a thought would run past 5 seconds, split it into two spoken Custom lines. Preserve the appended fixed channel closer verbatim and do not split it to meet this body-line target. One Custom line is one generated still. On each Custom line, after the spoken words, add " | " and one unspoken shot note: what is visible, full body or the detail, and "Crop the feet." or "Crop the knees." when a second shot should be a crop of that same file. Do not write extra lines whose only job is a second pose of the same moment. Do not invent shot-list lines to pad the count.',
    'Use the SCRIPT BIBLE and approved brief as the authority for length and structure. If neither sets a different target, use about 90–110 spoken lines and roughly 500–700 words as editorial defaults, never as hard quotas. Keep each line as a complete conversational thought, commonly 5–10 words, without splitting normal sentences to hit a count. If the draft feels short, strengthen causal transitions, visible consequences, the callback, or successful attempt; if it feels long, cut repeated explanation. Never pad. After the useful rule and payoff, stop.',
    'Recording stanzas: every newline is its own scene, still, and recording take. Trailing commas are spoken punctuation only and do not merge lines into one take.',
  ].join('\n')
}

export function normalizeScriptDraft(rawText: string): string {
  const trimmed = rawText.trim()
  const fenced = trimmed.match(/```(?:text|plaintext|markdown|md)?\s*([\s\S]*?)```/i)
  const source = (fenced?.[1] || trimmed).replace(/\r\n/g, '\n').trim()
  return source.replace(/^\s*#+\s+[^\n]+\n+/, '').trim()
}

export function composeTrailerScriptPrompt(
  longformScript: string,
  visualBible: VisualBible,
  options: { stillCast?: boolean } = {},
): string {
  const stillCast = Boolean(options.stillCast)
  return [
    'Write a condensed 9:16 version of the SAME episode, not a teaser for a different video.',
    'Target about 30 seconds when spoken naturally: 25–35 seconds, approximately 55–85 words, about 8–12 spoken lines.',
    'Keep each line concise but complete. Do not fragment one natural sentence across several lines or write 15 or more lines.',
    'Keep one lesson and the same narrative viewpoint as the longform. Open on the problem, show one mistaken choice and consequence, land the usable rule, then invite the viewer to the full video. Do not invent a new topic.',
    stillCast
      ? [
          'Every line is recorded as voice and gets one Custom-9x16 still named after the spoken words.',
          'Prefix every line as Custom: spoken words. Do not use talking-head expression folder names.',
          'The short uses vertical Custom stills only — never Expressions library faces, never 16:9 Custom images.',
          'Use the same friendly third-person narrator as the longform. Tell what Bux believed, what he tried, what happened, and what he learned in natural conversational English. Establish Bux by name, then use "he" and "his" naturally. Never use caveman grammar, impersonate Bux with "I" or "Me," switch narrative viewpoints, or leave doer-less action fragments.',
        ].join(' ')
      : 'Return only the spoken script, one natural narration beat per line, with no numbering, labels, markdown, stage directions, or quotation marks.',
    'The final line is mandatory: it must be a clear call to action inviting the viewer to watch the full video and learn more. Make that CTA specific and natural, for example “See the full video to learn more.” Do not put anything after the CTA.',
    'Do not write a like, subscribe, comment, or next-video closer. Do not wrap the script in markdown. Return only the script.',
    '',
    'LONGFORM SCRIPT:',
    longformScript,
    '',
    'VISUAL BIBLE:',
    `Style: ${visualBible.style}`,
    `Characters: ${visualBible.characters}`,
    `Setting: ${visualBible.setting}`,
    `Palette: ${visualBible.palette}`,
    `Camera: ${visualBible.camera}`,
  ].join('\n')
}

const TRAILER_CTA = 'See the full video to learn more.'
const TRAILER_STILL_CAST_CTA = `Custom: ${TRAILER_CTA}`

export function normalizeTrailerScript(rawText: string, stillCast = false): string {
  const lines = rawText
    .replace(/```(?:text|plaintext)?/gi, '')
    .replace(/```/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
    .map((line) => line.replace(/^(?:hook|setup|payoff|cta)\s*:\s*/i, '').trim())
    .map((line) => {
      if (!stillCast) return line
      const prefixed = line.match(/^([^:]{1,48}):\s+(\S.*)$/)
      if (!prefixed) return `Custom: ${line}`
      const label = prefixed[1].trim()
      const spoken = prefixed[2].trim()
      if (/^custom$/i.test(label)) return `Custom: ${spoken}`
      return `Custom: ${spoken}`
    })
    .filter(Boolean)
  const ctaIndex = lines.findIndex((line) =>
    /\b(?:full video|watch the full|learn more|watch to learn|see more)\b/i.test(line),
  )
  if (ctaIndex >= 0) {
    const [cta] = lines.splice(ctaIndex, 1)
    lines.push(stillCast && !/^custom\s*:\s+\S/i.test(cta) ? `Custom: ${cta.replace(/^[^:]{1,48}:\s+/, '')}` : cta)
  } else {
    lines.push(stillCast ? TRAILER_STILL_CAST_CTA : TRAILER_CTA)
  }
  return lines.join('\n')
}

export function sceneDescriptionForGeneration(
  scenePrompt: string,
  sceneRecord?: SceneDirectionRecord,
): string {
  if (sceneRecord?.direction.trim()) return sceneRecord.direction.trim()
  const cleanedPrompt = stripVisualBible(scenePrompt)
  const directionMatch = cleanedPrompt.match(
    /(?:^|\r?\n)Scene direction\s*:\s*([\s\S]*)$/i,
  )
  if (directionMatch?.[1]?.trim()) return directionMatch[1].trim()
  if (/^Create a single visual scene for this narration\s*:/i.test(cleanedPrompt)) {
    return ''
  }
  return cleanedPrompt
}

function canonicalSceneRecordText(record: SceneDirectionRecord): string {
  const metadata = [
    record.focalSubject && `Focal subject: ${record.focalSubject}`,
    record.visualAction && `Visual action: ${record.visualAction}`,
    record.shotType && `Shot/composition: ${record.shotType}`,
    record.setting && `Setting: ${record.setting}`,
    record.visibleCharacters?.length
      ? `Visible characters: ${record.visibleCharacters.join('; ')}`
      : '',
    record.visibleProps?.length ? `Visible props: ${record.visibleProps.join('; ')}` : '',
    record.propState && `Prop state: ${record.propState}`,
  ].filter(Boolean)
  return [
    'Production-ready scene direction (source of truth):',
    record.direction,
    ...(metadata.length > 0
      ? ['Optional scene metadata for continuity:', ...metadata]
      : []),
  ].join(' ')
}

function animalInteractionInstruction(record?: SceneDirectionRecord): string {
  const baseline =
    'Keep animals anatomically natural and quadrupedal. Do not add human arms, hands, extra limbs, or upright human anatomy.'
  const action = `${record?.visualAction || ''} ${record?.direction || ''}`
  const carrying = /\b(?:carry|carries|carrying|retrieve|retrieves|retrieving|bring|brings|bringing|fetch|fetches|fetching|hold|holds|holding|pick up|picks up|pickup)\b/i.test(
    action,
  )
  if (carrying) {
    return `${baseline} Animal anatomy requirement for this scene: the planned animal carrying, retrieving, bringing, or holding action must show the object in its mouth, visibly between the natural jaws.`
  }
  return `${baseline} Animal anatomy requirement for this scene: when an animal carrying, retrieving, bringing, or holding an object is explicitly planned, place the object in its mouth between the natural jaws; this scene does not plan that action, so do not invent a carried object or mouth action. Use paws only for the explicitly described natural action.`
}

function characterLockPromptLines(visualBible: VisualBible): string[] {
  const lines = [
    visualBible.mainCharacter.trim()
      ? `Main character lock (authoritative when this character is visible): ${visualBible.mainCharacter.trim()}`
      : '',
    visualBible.supportingCharacter.trim()
      ? `Supporting character lock (authoritative when this character is visible): ${visualBible.supportingCharacter.trim()}`
      : '',
  ]
  const populated = lines.filter(Boolean)
  return populated.length > 0
    ? [
        ...populated,
        'Character lock policy: use the exact locked appearance whenever that character is present in the scene direction; do not substitute, redesign, or add extra versions of the character.',
      ]
    : []
}

export function stripVisualBible(prompt: string): string {
  const styleStart = prompt.search(/\nStyle\s*:/i)
  return (styleStart >= 0 ? prompt.slice(0, styleStart) : prompt).trim()
}
