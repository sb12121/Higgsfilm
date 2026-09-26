# ClearCash Style Guide

APP USE: Visual direction > Visual bible. Reference for filling the visual bible and checking generated images; this Markdown file is not a production-bible preset import.


ClearCash is practical personal finance for everyday people who want less money confusion. Cash is the protagonist; a friendly third-person narrator tells the story.

Tactile paper collage is the channel medium. The character sheet controls proportions; face references control craft construction. Optional live expression library: `MyChannels/ClearCash/Expressions/`.

## Canonical Cash identity

Anthropomorphic tabby cat, friendly professional build:

- Orange tabby fur; cream muzzle, chest, inner ears / paws
- Alert but soft ears; green eyes; expressive dark eyebrows when the medium supports them
- Striped tabby tail

### Required wardrobe (always)

- Navy blue blazer with small white pocket square; sleeves may be rolled to mid-forearm
- Light blue button-down dress shirt (collar visible under the blazer)
- Dark charcoal / black trousers
- Brown leather belt with gold buckle
- Silver analog wristwatch with dark green face on the left wrist

### Required ID markers (HARD — every Cash shot)

1. **Bright / forest-green collar** — solid band around the neck, clearly visible above the shirt collar / blazer lapel
2. **Round gold tag** hanging from the collar center
3. Tag text must read **`CASH`** in bold black capitals, large enough to read at delivery size

**Reject the image if any of these fail.** Object-only stills (no Cash in frame) are exempt.

---

## Art medium

ClearCash uses tactile paper collage throughout its active production workflow.

### References (attach in this order for Expressions)

| Role | File |
|---|---|
| **Face / craft look (first)** | `MyChannels/ClearCash/PaperCollage/Face_Ref_A.jpg` and `Face_Ref_B.jpg` |
| **Turnaround / identity sheet** | `MyChannels/ClearCash/PaperCollage/character sheet.png` |

- Always instruct the model: output **ONE** standalone scene — never reproduce the character sheet, grid, or multi-panel layout.
- **Expression images = nothing but Cash** on the shared background plate. Props and gags belong in Custom stills.
- **Custom scenes:** one generated image per spoken line. Every new spoken line uses one Custom still.
- Legacy `01.png` / `02.png` / `03.png` expression alternatives are library maintenance only.

---

## Generation order

1. Green collar + round gold tag with readable `CASH`
2. Financial wardrobe + silver watch with green face
3. Fur, face, build, tail
4. Pose / expression
5. Scene gag / props (last)

Prompt boilerplate when Cash appears:

> MUST SHOW: bright green collar around the neck AND a round gold tag clearly labeled CASH in black capitals. Reject if missing.

---

## One Cash per still (hard)

- Default: exactly one Cash.
- Exception: two figures only for explicit before/after.
- Supporting characters are random different cat breeds in the same paper-collage medium — not Cash clones, and never wearing the green CASH tag.

---

## Quality control

Fail and regenerate if collar/tag missing, wrong wardrobe, wrong medium, multi-Cash without before/after, contact sheet/grid, or face that does not match the face refs.

## Output defaults

- Expressions / most Custom: **16:9**, final **3840×2160**
- Filename for Custom = spoken line + `.png`
- Save Custom stills under the episode `Custom/` folder
