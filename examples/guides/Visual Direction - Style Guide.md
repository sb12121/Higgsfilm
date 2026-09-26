# [CHANNEL] Style Guide

APP USE: Visual direction > Visual bible. Reference for filling the visual bible and checking generated images; this Markdown file is not a production-bible preset import.


[CHANNEL] is [NICHE]. [CHARACTER] is the protagonist; [NARRATOR] tells the story.

[ART_MEDIUM] is the channel medium. The character sheet controls proportions; face references control craft construction. Optional live expression library: `[CHANNEL_ROOT]/Expressions/`.

## Canonical [CHARACTER] identity

Describe species / build / silhouette here:

- [BODY_AND_FEATURES]
- [PALETTE]

### Required wardrobe (always)

- [WARDROBE]

### Required ID markers (HARD — every [CHARACTER] shot)

These are identity, not optional jewelry:

1. [HARD_ID_MARKERS]

**Reject the image if any hard ID marker fails.**

Object-only stills (no [CHARACTER] in frame) are exempt.

---

## Art medium

[CHANNEL] uses [ART_MEDIUM] throughout its active production workflow.

### References (attach in this order for Expressions)

| Role | File |
|---|---|
| **Face / craft look (first)** | `[FACE_REFS]` |
| **Turnaround / identity sheet** | `[CHARACTER_SHEET]` |

- Face-style refs are the craft bar — attach them first so gens do not drift into the wrong medium.
- Character sheet is the official turnaround: proportions, costume, hard ID markers, color swatches, craft notes.
- Always instruct the model: output **ONE** standalone scene — never reproduce the character sheet, grid, or multi-panel layout.

### Craft rules (customize to your medium)

- Expression master: `[CHANNEL_ROOT]/Tools - Regenerate Expressions.txt`
- Custom master: `[CHANNEL_ROOT]/Visual Direction - Custom Images 16x9.txt`
- **Expression images = nothing but [CHARACTER]:** full-body on the shared background plate only. No scenery, furniture, props, thought bubbles, other characters, logos, captions, frame labels, or UI chrome. Props and gags belong in **Custom** stills.
- **Custom scenes:** one generated image per spoken line; crop the same master for a second view when useful. Every new spoken line — body, reactions, and the fixed outro — uses one Custom still.
- **Background (Custom):** invent a fresh background consistent with [ART_MEDIUM] for each still unless your channel standardizes a plate.
- Legacy `01.png` / `02.png` / `03.png` expression alternatives are library maintenance only. New scripts assign Custom stills, not expression-library faces.

---

## Generation order (fixes identity dropouts)

When writing an image prompt for any [CHARACTER] still, lock identity in this order:

1. [HARD_ID_MARKERS] (must-have, first)
2. [WARDROBE]
3. Body, face, build
4. Pose / expression
5. Scene gag / props (last — never let props outrank ID)

In every prompt that includes [CHARACTER], include an explicit MUST SHOW line for the hard ID markers.

---

## One [CHARACTER] per still (hard)

- Default: **exactly one** [CHARACTER] in any image.
- Never add a second copy for emphasis, crowd, or comparison props.
- **Exception:** two figures only when the spoken line explicitly asks for before/after (or an explicit side-by-side of the same character at two moments).
- Other non-[CHARACTER] characters only when the line clearly requires them.
- Supporting cast rule: [SUPPORTING_CAST_RULE]

---

## Quality control ([CHARACTER] in frame)

Fail and regenerate if:

1. Any hard ID marker missing or unreadable
2. Wrong wardrobe
3. Wrong medium
4. More than one [CHARACTER] unless the line is an explicit before/after
5. Contact sheet / grid / multi-pose sheet
6. Face / craft does not match face refs

Pass only when hard ID markers are obvious at a glance and the craft matches the refs.

---

## Output defaults

- Expressions / most Custom: **16:9**, final **3840×2160**
- One image per request / per Custom line
- Filename for Custom = spoken line + `.png`
- Save Custom stills under the episode `Custom/` folder
