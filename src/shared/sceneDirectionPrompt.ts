import type { ScenePromptingWorkflow } from './imageModels'
import type {
  ContinuityCanon,
  SceneLedgerEntry,
  ScriptLine,
  SequenceId,
  VisualBible,
} from './types'
import { compactLedger } from './sceneDirection'

export interface SceneDirectionPromptInput {
  sequence: SequenceId
  targetLine: ScriptLine
  sequenceLines: ScriptLine[]
  longformLines?: ScriptLine[]
  visualBible: VisualBible
  canon?: ContinuityCanon
  acceptedLedger: SceneLedgerEntry[]
  refinement?: string
  retryFeedback?: string
  promptingWorkflow?: ScenePromptingWorkflow
}

export function buildSceneDirectionPrompt(input: SceneDirectionPromptInput): string {
  const {
    sequence,
    targetLine,
    sequenceLines,
    longformLines = [],
    visualBible,
    canon,
    acceptedLedger,
    refinement,
    retryFeedback,
    promptingWorkflow = 'default',
  } = input
  const formatLine = (line: ScriptLine) =>
    `LINE ${line.index + 1} (id: ${line.id}, time: ${formatTime(line.startTime)}-${formatTime(line.endTime)}): ${line.text}`
  const orderedLines = sequenceLines.slice().sort((left, right) => left.index - right.index)
  const script = orderedLines.map(formatLine).join('\n')
  const paragraph = orderedLines
    .filter((line) => paragraphIndexOf(line) === paragraphIndexOf(targetLine))
    .map(formatLine)
    .join('\n')
  const scriptSummary = canon?.summary?.trim() || 'No saved continuity summary is available.'
  const longformScript =
    sequence === 'trailer'
      ? longformLines
          .slice()
          .sort((left, right) => left.index - right.index)
          .map(formatLine)
          .join('\n')
      : ''
  const characterLocks = [
    visualBible.mainCharacter.trim()
      ? `AUTHORITATIVE MAIN CHARACTER LOCK: ${visualBible.mainCharacter.trim()}`
      : '',
    visualBible.supportingCharacter.trim()
      ? `AUTHORITATIVE SUPPORTING CHARACTER LOCK: ${visualBible.supportingCharacter.trim()}`
      : '',
  ].filter(Boolean)

  return [
    `Create one detailed visual direction for Scene ${targetLine.index + 1} in the ${sequence === 'trailer' ? '9:16 condensed' : 'longform'} sequence.`,
    ...directorInstructions(promptingWorkflow, targetLine),
    ...(refinement?.trim()
      ? [
          `USER REFINEMENT: ${refinement.trim()}`,
          'Apply the user refinement to this target scene while preserving established character, prop, setting, and visual-bible continuity.',
        ]
      : []),
    ...(sequence === 'trailer'
      ? [
          '',
          'LONGFORM SCRIPT CONTEXT FOR THIS 9:16 CUT:',
          longformScript,
        ]
      : []),
    '',
    'CONCRETE CHARACTER REFERENCE (use identity facts internally; do not copy its global instructions into the output):',
    visualBible.characters,
    ...(characterLocks.length > 0
      ? [
          ...characterLocks,
          'Use the filled character locks whenever those characters are visible in the target scene; the image pipeline will apply them again during rendering.',
        ]
      : []),
    'CONCRETE SETTING REFERENCE (use relevant physical details internally; do not copy global styling or camera instructions into the output):',
    visualBible.setting,
    '',
    'WHOLE SCRIPT CONTINUITY SUMMARY:',
    scriptSummary,
    '',
    'STRUCTURED CONTINUITY CANON:',
    JSON.stringify(
      canon || {
        version: 1,
        sourceFingerprint: '',
        summary: '',
        subject: '',
        cast: [],
        locations: [],
        props: [],
        visualMotifs: [],
      },
    ),
    '',
    'ACCEPTED PRIOR SCENE DIRECTIONS:',
    compactLedger(acceptedLedger),
    '',
    'CURRENT PARAGRAPH:',
    paragraph,
    '',
    `TARGET LINE: ${targetLine.index + 1} (id: ${targetLine.id})`,
    targetLine.text,
    '',
    'FULL ORDERED SCRIPT:',
    script,
    ...(retryFeedback ? ['', 'CORRECTIVE RETRY FEEDBACK:', retryFeedback] : []),
    '',
    'OUTPUT CONTRACT:',
    ...outputContract(promptingWorkflow),
  ].join('\n')
}

function directorInstructions(
  workflow: ScenePromptingWorkflow,
  targetLine: ScriptLine,
): string[] {
  if (workflow === 'z-image-turbo') return zImageTurboDirectorInstructions(targetLine)
  return defaultDirectorInstructions(targetLine)
}

function defaultDirectorInstructions(targetLine: ScriptLine): string[] {
  return [
    'You are the single scene director for this request. Read every context block before choosing one clear, engaging visual moment for the target line.',
    'The target line supplies the meaning. The full script and paragraph supply story context. The continuity canon and character references supply concrete identity.',
    '',
    'Write a standalone direction containing only concrete, visible scene details for an image model that has never seen another prompt. Repeat the exact established subject identity, species, coat or hair colors, clothing or markings, location, and visible prop details needed for this scene. Never use "the same", "as before", "recurring character", "familiar", "previous scene", or vague references.',
    'When a filled character lock is visible in the target moment, its exact identity and appearance are mandatory. Do not rename, redesign, substitute, or dilute a locked character. Do not force a locked character into a scene that the narration clearly excludes.',
    'Choose the visual carrier that best explains this line: protagonist, secondary character, reaction, concrete prop, environment, process, or consequence. Do not force the protagonist into every frame and do not turn unrelated lines into object-carrying scenes.',
    'Create purposeful visual variation from the accepted prior directions. Vary the visible subject, action, expression, spatial relationship, environment, and meaningful detail when the narration permits it. The narration always wins over a variation rule.',
    `PREFERRED VISUAL EMPHASIS FOR THIS LINE (narration wins): ${variationBeatForLine(targetLine, 'default')}`,
    'Keep animals quadrupedal and anatomically natural. Only if the planned action explicitly has an animal carrying, retrieving, bringing, fetching, or holding an object should the object appear between the natural jaws. Otherwise do not invent a carried object, mouth action, human arms, extra limbs, or upright anatomy.',
    'Give every visible character a detailed concrete appearance and expression appropriate to the scale of the scene: body shape, hair or fur, skin or coat color, clothing or accessories, visible eyes, eyebrows, nose or facial mark, mouth, and action-specific emotion. State when a character is turned away or fully occluded.',
    'The first sentence must state the visible cast as "Exactly zero characters:", "Exactly one character:", "Exactly two characters:", or "Exactly three characters:" and then name them. Humans and animals both count. Never include more than three characters in one scene. Prefer one or two. Use zero only for a place or prop with nobody present.',
    'Make the paragraph richly specific, usually around 80–150 words: describe the subject’s visible appearance, exact action and pose, facial emotion, spatial relationships, setting details, important props, foreground/background activity, and any meaningful change or consequence from the narration. Prefer precise nouns and active visual details over generic adjectives.',
    'Do not include global production instructions in the paragraph: no art-style names, illustration technique, outline or fill rules, aspect ratios, camera or shot labels, palette rules, negative prompts, or lists of things to avoid. Do not write "use", "render", or "create" instructions; describe what is visibly present. Omit unwanted elements instead of listing them as negatives.',
    'Do not add captions, logos, watermarks, readable text, symbols, arrows, thought bubbles, diagrams, or decorative overlays unless the target narration explicitly requires that exact visible element.',
    'Do not copy, quote, summarize, or paraphrase the narration. Interpret it as a specific visible moment.',
  ]
}

function zImageTurboDirectorInstructions(targetLine: ScriptLine): string[] {
  return [
    'You are writing a Z-Image Turbo scene direction: one concrete, photographable cartoon moment. Read every context block, then describe only what is visibly present.',
    'The target line supplies the meaning. The full script, paragraph, continuity canon, and character locks supply identity. Continuity stays in this briefing; do not copy the canon essay into the output.',
    '',
    'Write a standalone paragraph of visible facts for an image model that has never seen another prompt. The first sentence must be the cast count: "Exactly zero characters:", "Exactly one character:", "Exactly two characters:", or "Exactly three characters:" followed by who they are. Then the joke or clear action, one identity sentence, pose and limb counts, faces, and two setting facts. Repeat identity facts instead of writing "the same", "as before", "recurring character", "familiar", or "previous scene".',
    'When a filled character lock is visible, restating its exact identity in one sentence is mandatory. Do not rename, redesign, or force a locked character into a scene the narration excludes.',
    'Choose the visual carrier that best explains this line: protagonist action, owner reaction, punchline prop, empty-room consequence, or two-shot relationship. Do not force the protagonist into every frame. Do not invent object-carrying unless the planned action needs it.',
    'Humor must be physical and proper: proud animal, stunned human, wrong object, scale mismatch, expression mismatch. Keep the joke as bodies, props, and faces; leave diagrams, arrows, thought bubbles, split screens, and conceptual metaphors out of the paragraph.',
    `PREFERRED VISUAL EMPHASIS FOR THIS LINE (narration wins): ${variationBeatForLine(targetLine, 'z-image-turbo')}`,
    'Animals are complete quadrupeds: one head, two ears, one tail, two front legs, two hind legs, four paws, chest toward the floor. Write sit as hind legs folded and both front paws planted. Write pointing as one front paw lifted a few inches and the other three paws planted. Keep animals on four paws with fur and a tail; write a human sit or human arms only on a human.',
    'If an animal carries, retrieves, brings, fetches, or holds an object, describe bite geometry: jaws parted, object inside the mouth gripped by the teeth, ends hanging out or disappearing into the mouth, lips wrapping the object. Write that bite geometry instead of "between the natural jaws" or "mouth closed around" an object. If the animal is not carrying, the mouth is empty and closed and all four paws are empty. Props sit in the setting or in a human hand; they rest against an animal muzzle only when the animal is biting that object.',
    'Every human is a complete body with a head attached to a neck and torso, two arms attached at the shoulders, two legs attached at the hips, and both feet on the ground unless the pose is explicitly kneeling or sitting. If a hand holds a prop, that hand is at the end of an arm attached to the torso, and the prop is away from every mouth. Humans and animals both count toward the three-character cap. Prefer one or two named characters. Write a second human only when the joke needs a full second body.',
    'If a human and an animal share the frame, describe the human first as a clothed bipedal adult with visible hair, a human face, a shirt, pants, shoes, and two human hands, then the animal in one short pose. Keep them two different species and two separate bodies. Keep the animal pose to one short clause so it cannot replace the person. The word "owner" is not enough; write the person as a man or woman in clothes.',
    'Keep the paragraph to about 70–110 words. Prefer precise nouns and visible contact over coat-inventory adjectives. Faces need two eyes, eyebrows, a small nose, and a shaped mouth doing the emotion.',
    'Describe only what is visibly present. Leave art-style names, outline rules, aspect ratios, camera labels, palette rules, avoid-lists, and instruction verbs out of the paragraph.',
    'Leave captions, logos, watermarks, readable text, symbols, arrows, thought bubbles, diagrams, and decorative overlays out unless the target narration requires that exact visible element.',
    'Interpret the narration as one specific visible moment rather than quoting or paraphrasing it.',
    'If the cast is zero, write "Exactly zero characters:" then the unoccupied place and the props that fill it. Name architecture and objects. Leave people, animals, silhouettes, and walking figures unmentioned; Z-Image Turbo treats those words as subjects to draw.',
  ]
}

function outputContract(workflow: ScenePromptingWorkflow): string[] {
  if (workflow === 'z-image-turbo') {
    return [
      'Return only one self-contained paragraph of visible scene facts, usually 70–110 words.',
      'The first sentence must be "Exactly zero characters:", "Exactly one character:", "Exactly two characters:", or "Exactly three characters:" naming who is visible. At most three. Then the joke or action, identity, pose and limb counts, faces, and two setting facts.',
      'If the count is zero, describe the unoccupied place and props only. Leave people and animals unmentioned.',
      'Return a visible-facts paragraph only, without JSON, Markdown fences, labels, headings, reasoning, narration, a line ID, art-style language, aspect-ratio language, camera/shot labels, avoid-lists, or instruction verbs.',
    ]
  }
  return [
    'Return only one highly detailed, self-contained paragraph describing the visible scene.',
    'The first sentence must state the exact character count from zero to three, then name those characters. Never include more than three characters.',
    'The paragraph must contain scene-specific visual features only: concrete subjects, appearance, action, pose, expression, setting, spatial relationships, relevant props, and visible consequences.',
    'Do not return JSON, Markdown fences, labels, headings, reasoning, narration, a line ID, art-style language, aspect-ratio language, camera/shot labels, global avoid rules, or instruction verbs.',
  ]
}

function paragraphIndexOf(line: ScriptLine): number {
  return Number.isInteger(line.paragraphIndex) && (line.paragraphIndex || 0) >= 0
    ? line.paragraphIndex || 0
    : 0
}

function variationBeatForLine(
  line: ScriptLine,
  workflow: ScenePromptingWorkflow,
): string {
  const beats =
    workflow === 'z-image-turbo'
      ? [
          'Let a physical environmental consequence explain the line: a trail, an open drawer, a misplaced object, or an empty spot where something should be.',
          'Make the owner’s or a secondary character’s facial reaction the punchline, with two arms and two legs counted.',
          'Make one ceremonial or wrong-object action unmistakable, with bite geometry if an animal is carrying.',
          'Make one punchline prop the focus: scale mismatch, object in the wrong place, or a proud presentation.',
          'Show a two-shot relationship: presentation, standoff, or cuddle, with complete bodies and clear faces.',
          'Show a visible change unfolding: muddy paws, a dropped object, or a freeze-frame of motion with all four paws on the floor.',
        ]
      : [
          'Let the surrounding environment explain where the moment takes place.',
          'Make the character’s facial reaction and body language carry the moment.',
          'Make the physical interaction or movement unmistakable.',
          'Make one meaningful prop, expression, or environmental clue the visual detail.',
          'Let the relationship between the subject and the surrounding space carry the moment.',
          'Show a visible change unfolding rather than a static object pose.',
        ]
  return beats[line.index % beats.length]!
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, seconds)
  const minutes = Math.floor(safeSeconds / 60)
  const remainder = (safeSeconds % 60).toFixed(1).padStart(4, '0')
  return `${String(minutes).padStart(2, '0')}:${remainder}`
}
