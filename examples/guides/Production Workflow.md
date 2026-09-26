# [CHANNEL] Video Making Guide

APP USE: Reference checklist for the full workflow. Read this file; it is not loaded into a single app field.


[CHANNEL] is [NICHE]. [CHARACTER] appears in [ART_MEDIUM]. [NARRATOR] follows their mistakes, consequences, and discoveries. Each episode delivers one useful idea.

## Channel rules

- Audience: [AUDIENCE]
- Subjects: [SUBJECTS]
- Voice: natural conversational English. Past tense for [CHARACTER]'s story; present tense for durable lessons. Establish [CHARACTER] by name, then vary sentence openings with pronouns, transitions, and concrete objects.
- Story: one mistaken belief, two escalating mistakes, one correct attempt, visible payoff, and one memorable rule.
- Visuals: every spoken line uses a Custom scene still, including reactions and the fixed channel closer. Do not assign expression-library faces on new scripts.
- Reactions: draw each reaction as part of its Custom scene, never as an expression-library face.
- Pace: most spoken lines take 2-4 seconds. For a line near five seconds, use a tighter crop of the same image when useful. A new thing to show belongs on a new spoken line.
- Identity and craft: follow [Visual Direction - Style Guide.md](Visual%20Direction%20-%20Style%20Guide.md). Character-sheet proportions, wardrobe, hard ID markers, and craft construction stay consistent.
- Out of scope: [OUT_OF_SCOPE]

## Production files

All paths below are relative to `[CHANNEL_ROOT]/`.

| Purpose | File or folder |
|---|---|
| Script bible | `Script Creator - Script Bible.md` |
| Research and packaging coach | `Video Idea - Idea Guide.md` |
| Style authority | `Visual Direction - Style Guide.md` |
| Live expression library | `Expressions/` (optional legacy) |
| Expression generation | `Tools - Regenerate Expressions.txt` |
| Landscape Custom generation | `Visual Direction - Custom Images 16x9.txt` |
| Vertical Custom generation | `Condensed Short - Custom Images 9x16.txt` |
| Proportion reference | character sheet path from the style guide |
| Face references | face ref paths from the style guide |

`Archive/` (if present) holds superseded documents. Do not load Archive guides into the app.

## 1. Configure [CHANNEL]

Load the [CHANNEL] channel profile in Settings and select Custom scenes. Load the script bible and idea guide from this folder. After moving folders, reselect any saved guide or reference path that still points elsewhere.

For image tools, attach the face references, character sheet, and an empty background plate for expression generation. Custom scenes get their own backgrounds per your style guide.

## 2. Establish demand and packaging

Use the Video Idea Guide to complete demand, packaging, experience, and CTA before scripting. Research with relevant YouTube examples: repeated recent evidence, comparison with each channel's usual performance, and failures as well as successes. Record the evidence rather than treating a generated claim as research.

Define one viewer problem and desired outcome. Create three materially different thumbnail directions: stakes, curiosity, and desire. For each, specify Emotion, Visual, Text, and Open loop. Choose one truthful promise. Thumbnail text is zero to four words; it adds tension rather than repeating the title or revealing the entire lesson.

Example topic: [EXAMPLE_TOPIC]. The title, thumbnail, opening, and eventual lesson must concern that same problem.

## 3. Write the episode

Use the script bible. Aim for roughly 90-110 spoken lines and 500-700 words without padding. Open inside the promised situation; the first 5-8 lines should confirm the thumbnail's problem or consequence. Establish Promise, Proof, and Plan through the story.

Every spoken line uses `Custom: Voice line | Unspoken shot note`:

```text
Custom: [CHARACTER] tried the obvious fix first. | Full body, [CHARACTER] attempts the first mistaken plan with confidence.
Custom: To them, that felt like a clever shortcut. | Full body, [CHARACTER] grins beside the setup that will fail.
Custom: The result made the real problem obvious. | Full body, [CHARACTER] stares at the visible consequence.
```

Write every Custom line as narration that works with the pictures muted. Each newline is one spoken line and one distinct image. Never add silent shot-list lines or extra lines merely to reach a scene-count target.

Use concrete actions and consequences from [TOPIC_WORLD]. Speak 3-5 relevant search phrases naturally, once each. Finish after the correct attempt, payoff, and usable rule. Do not write an additional closer; the app appends its fixed Custom outro:

```text
[OUTRO_LINES]
```

Keep the outro spoken text unchanged and verbatim. Generate Custom stills for those lines like any other body line.

## 4. Create the project and short

Create `[CHANNEL_ROOT]/<Episode Name>/`, open that episode folder in Higgsfilm, load [CHANNEL], and import the approved script. The channel root is not an episode folder.

Create a condensed short of about 30 seconds that preserves the problem, consequence, discovery, and useful result. Every short line is Custom. Generate separate vertical compositions; do not use cropped landscape masters as the short's source images.

## 5. Generate Custom scenes

Use the landscape or vertical Custom prompt as appropriate. Generate exactly one image per spoken Custom line, one at a time. Separate lines get separate scenes. Follow the separately supplied unspoken Shot/SHOT instruction for action and composition; never narrate or render it.

- Landscape: `[CHANNEL_ROOT]/<Episode Name>/Custom/`, 3840x2160.
- Vertical: `[CHANNEL_ROOT]/<Episode Name>/Custom-9x16/`, 2160x3840.
- Filename: spoken words after `Custom:` plus `.png`; omit Windows-invalid punctuation. Preserve words and capitalization. Higgsfilm's matching ignores punctuation.
- If narration changes, update the matching filename.
- Default to no rendered narration or other text except hard ID marker text that is part of the character design.
- Preserve character-sheet proportions across poses. Object-only inserts are appropriate when the line concerns an object. Do not reproduce the character sheet or create a multi-panel sheet.

## 6. Cast and voice

Refresh Custom assets and confirm every spoken line has its intended Custom still. Preview each still. When a long line needs another view, use a crop of the same Custom master; do not generate a nearly identical second pose.

Personally record all narration through a microphone. Automatic cleanup trims dead air only at the take edges, keeps internal pauses, preserves the raw take, and aims for about 0.25 seconds of quiet at the end of each outgoing scene. Verify line starts, endings, pauses, pronunciation, and that shot notes are never spoken.

## 7. Review, export, and publish

Watch the opening at normal speed. Does it immediately deliver the title/thumbnail promise? Does every consequence visibly advance the same lesson? Can a beginner understand the idea without jargon?

Check image assignments, identity, craft, audio clipping, missing syllables, and short framing. Verify every spoken line — including the closer — has a Custom still. Export the main video and short, then review both exported files.

Keep completed releases under `Uploaded/` when archiving; reopen and verify project assets after relocating an episode.

## 8. Learn from releases

Compare the promise, click behavior, opening, viewing experience, and next action. Record what viewers actually responded to before choosing the next topic. Carry forward the successful reason to watch, rather than repeating the same story with renamed props.
