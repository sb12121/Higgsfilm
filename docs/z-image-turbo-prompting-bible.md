# Z-Image Turbo Prompting & Style Bible

Higgsfilm-specific. This is the source of truth for how we talk to **Z-Image Turbo** (`z_image_turbo_bf16.safetensors` + `qwen_3_4b` CLIP, ComfyUI `lumina2`).

Use this when writing scene directions, rewriting the visual bible, or changing `composeZImagePrompt`.

---

## 1. What this model actually is

Z-Image Turbo is **not** Stable Diffusion, Flux, or Qwen-Image.

| Fact | What it means for us |
|---|---|
| Qwen3-4B text encoder | It reads **sentences**, not tags. `masterpiece, best quality, 1girl` is the wrong language. |
| Distilled to ~8 NFEs | Use **8–9 steps**, sampler `res_multistep`, scheduler `simple`. More steps do not add quality and can add artifacts. |
| No classifier-free guidance | ComfyUI CFG must stay **1.0**. The negative clip is zeroed out. The `negativePrompt` field does **nothing**. |
| Default text length ~512 tokens | About **350–400 English words**. Anything after that is silently dropped. |
| Photorealism is its home turf | Cartoon work must **lock the medium in the first sentence**, or it drifts toward hybrid realism and broken anatomy. |
| Official Prompt Enhancer | Tongyi wants an **objective, concrete visual description**. No metaphors, no "8K"/"masterpiece", no "render/use/create" instructions. |

Official author guidance ([Hugging Face discussion](https://huggingface.co/Tongyi-MAI/Z-Image-Turbo/discussions/8)):

- Write a long, detailed prompt, then optionally enhance it with an LLM.
- Turbo **does not use negative prompts at all**.
- For long prompts, raise `max_sequence_length` to 1024. ComfyUI CLIP encode still commonly truncates near 512 unless a token-counter / truncate node is added. **Do not rely on 1024.** Budget for 512.

Our ComfyUI workflow already does the runtime recipe correctly: 8 steps, CFG 1, `res_multistep` + `simple`, negative zeroed, 1152×648 (16:9) / 648×1152 (9:16). Prompting is the remaining failure.

---

## 2. How Higgsfilm talks to the model today

```
narration line
    → scene-direction LLM  (buildSceneDirectionPrompt)
        → 80–150 word paragraph of visible facts
    → composeZImagePrompt
        → one space-separated blob sent to CLIPTextEncode
    → Z-Image Turbo
```

### Scene director (mostly right)

`buildSceneDirectionPrompt` already asks for a standalone, concrete paragraph: identity, action, pose, expression, setting, props. It correctly forbids art-style names, shot labels, and "avoid" lists in that paragraph, because style is supposed to be applied later.

What it gets wrong for Turbo:

- It spends most of the word budget **re-listing the full character sheet** on every line.
- The actual joke / beat is often the last clause.
- Humor is allowed to be conceptual ("warm amber-gold pulses flow from their eyes into translucent glowing brains").
- Animal contact is described with production jargon ("between his natural jaws") instead of visible bite geometry.
- Anthropomorphic verbs slip in ("one paw points", "sits upright behind a table").
- It forbids lighting and material language, which the official enhancer considers essential.

### Composer (the main bug)

`composeZImagePrompt` currently concatenates, in order:

1. Scene direction
2. "Compose a clean 16:9 image…"
3. **The same direction again**, plus metadata (`canonicalSceneRecordText`)
4. The **entire continuity / script summary** (often 200+ words)
5. Style + characters + setting + palette + camera smashed into one instruction block
6. "The project visual bible is authoritative…"
7. The animal-anatomy **rule paragraph**
8. Sparse-background instruction

A typical real prompt is **800–1200 words**. The encoder keeps ~380. Surviving tokens are: direction, "compose a clean image", **duplicate direction**, then a slice of the script summary.

What the model never sees:

- Cartoon style lock
- Character locks
- Extra-limb rules
- Mouth-carrying rules
- Palette / outline / white-background bible

That is why objects hover near mouths, people grow extra legs, and frames feel generic. The scene director also **strips style on purpose**, so a truncated prompt is a photoreal-leaning description with no medium.

The visual bible itself is written as **SD-style instructions** ("Use thick outlines. Never add human arms. Avoid gradients.") Turbo ignores "never/avoid" and does not want "use/render/create".

---

## 3. Non-negotiable prompt rules

1. **One paragraph of visible facts.** Not a shot list. Not a policy document.
2. **Style in sentence one.** "Clean 2D cartoon illustration…" must exist before any plot.
3. **Joke / action in sentence two.** If the prompt is cut, the beat still survives.
4. **Identity is one sentence**, not a paragraph. Full coat/clothing dumps belong in the character lock, restated only as a short reminder.
5. **Count the parts that break.** Two arms, two hands, five fingers, two legs. Four dog legs, two ears, one tail, four paws.
6. **Describe contact, not intention.** "Clamped in the teeth, cuff hanging out the left side" beats "carrying a sock between his natural jaws".
7. **Put constraints as positive visuals**, then one short cleanup clause. "Complete quadruped body, four paws on the floor" first; "no extra legs, no human arms" last and brief.
8. **Stay under ~220 words** for the final CLIP prompt. 80–180 is the sweet spot. 250 is the ceiling.
9. **No metaphors.** If you cannot photograph it in a children's book, do not write it.
10. **No captions, logos, watermarks, readable text** unless the narration truly needs a specific quoted word.

---

## 4. Final CLIP prompt formula

Always in this order. Every sentence earns its place.

```
[1. Medium + canvas]
[2. The beat: who does what, and why it is funny or clear]
[3. Short identity lock]
[4. Anatomy + contact + expression]
[5. Place, props, spatial relationships]
[6. Light, pigment, outlines]
[7. Cleanup clause]
```

### Template

```
Clean 2D cartoon illustration, 16:9, thick smooth near-black outlines, rounded storybook bodies, flat warm color fills, white uncluttered background.

[Beat]. [Identity one-liner].

[Body completeness and exact pose]. [Object contact in physical detail]. [Face: two eyes, eyebrows, mouth doing this emotion].

[Two or three setting facts, foreground then background]. Even, shadowless fill light. Paper-like flat pigment, no gradients, no photoreal fur.

Complete [human/animal] anatomy as described, no extra limbs, no text, no logos, no watermark.
```

Target length: **120–180 words**.

### What never goes in the CLIP prompt

- Continuity essays
- "The visual bible is authoritative"
- "Do not force the protagonist into every frame"
- Duplicated scene direction
- Shot metadata labels (`Focal subject:`, `Prop state:`)
- The raw `negativePrompt` comma list
- "Create / render / use / avoid" instruction stacks

---

## 5. Style lock (drop-in visual bible)

Paste this into the Higgsfilm visual bible. It is written as **visible facts**, not director orders.

### Name

`Clean 2D Cartoon Explainer (Z-Image Turbo)`

### Style

Clean 2D cartoon illustration for a children's storybook explainer. Thick smooth near-black ink outlines of even weight. Rounded complete bodies. Flat warm pigment fills. Clear silhouettes. White or very light background. Polished Saturday-morning cartoon, not a line drawing, not a sticker pack, not 3D, not photoreal.

### Characters

Rounded cartoon humans and animals with complete heads, torsos, and limbs. Humans have two arms, two hands with five fingers each, two legs, and two feet. Animals are quadrupeds with two ears, one tail, two front legs, two hind legs, and four paws. Faces are simple and readable: two large eyes, eyebrows, a small nose, and a clearly shaped mouth. Recurring characters keep the same colors, clothing, and markings whenever they appear.

### Main character lock

Fill this per project. Example:

Adult male golden retriever, medium-large and sturdy, warm golden-orange coat, cream muzzle and chest, floppy rounded ears, dark brown eyes, black nose, long feathery tail, no collar.

### Supporting character lock

Fill this per project. Example:

Young adult man, light skin, short side-swept dark-brown hair, teal long-sleeve shirt, dark-blue pants, bright-orange shoes.

### Setting

White studio background or a very light house interior made of a few rounded props: couch, rug, window, door, table. Lots of empty space. Only the objects the beat needs.

### Palette

White ground. Near-black outlines. Warm gold fur. Cream muzzle. Teal shirt. Dark-blue pants. Orange shoes. One or two extra flat accent colors. No gradients, no heavy shadows, no textured photoreal fur.

### Camera

Flat 2D staging, medium or wide, subject large and centered enough to read the face. No lens blur, no cinematic lighting, no Dutch angle unless the beat is specifically off-balance.

### Negative prompt

Leave the field for Flux / Higgsfield. **Turbo will not read it.** Convert anything important into the cleanup clause in section 4.

If a provider still stores it, keep it short and specific:

`photorealism, 3D, extra limbs, extra fingers, human arms on animals, blank faces, text, logos, watermarks`

---

## 6. Anatomy bible

Turbo does not understand "do not add extra legs" unless the **correct count is already drawn in words**.

### Humans

Write the count, the pose, and what each hand is doing.

- "An adult man standing on both feet, two arms visible, left hand on his hip, right palm turned upward, five fingers on each hand."
- "She kneels on both knees, both hands cupped under the dog's chin, two arms only."

Avoid:

- "one palm turned upward" with no other arm mentioned (the missing arm gets invented or deleted)
- cropped "shoulders-down" shots unless you explicitly say the head is out of frame
- crowds. One or two people. A third body is how extras grow.

### Dogs and other animals

Default body:

> Complete quadruped: one head, two floppy ears, one tail, two front legs, two hind legs, four paws. No human arms. No extra legs. Chest toward the floor, not upright like a person.

Pose language that stays quadrupedal:

| Want | Write this | Do not write |
|---|---|---|
| Sit | "sits on his hind legs, both front paws planted on the floor" | "sits upright" |
| Point / indicate | "body faces the doorway, one front paw lifted a few inches, the other three paws planted" | "one paw points" |
| Proud | "head high, chest forward, four paws on the floor, tail lifted" | "stands like a person" |
| At a table | "stands on all fours beside the table, chin level with the tabletop" | "sits behind the table" |
| Hold with paws | only if the beat truly needs it, and then "both front paws pinned on the ball, hind paws on the floor" | "holding it in his hands" |

### Mouth contact (the sock / ball / leaf problem)

"Between the natural jaws" is production jargon. Turbo often draws the object **next to** the muzzle.

Write the bite as geometry:

1. Jaws **parted**.
2. Object **inside** the mouth, compressed by the teeth.
3. Two ends **exiting** the mouth, or one end disappearing into it.
4. Tongue visible or not.
5. Drool / crushed fabric / damp patch at the bite point.

**Good:**

> His jaws are parted just enough that a slightly damp white tube sock is clamped in his teeth. The cuff hangs out the left side of the mouth and the toe hangs out the right side. The fabric is pinched and darkened where the canines grip it. The tongue is hidden. His lips wrap around the sock, not hovering in front of it.

**Good (leaf):**

> A single green leaf is gripped crosswise in his front teeth, stem sticking out the left side, tip sticking out the right, lips closed around the middle of the leaf.

**Bad:**

> A sock rests carefully between his natural jaws, mouth gently closed around the sock without chewing it.

"Mouth closed" + "object between jaws" is a contradiction. Closed mouths make the object float in front of the face.

When the animal is **not** carrying anything, say so in one positive clause:

> Mouth empty and closed. No object in or near the muzzle. All four paws empty and on the floor.

Do not append a 60-word policy about "this scene does not plan a carrying action."

---

## 7. Humor bible: silly, engaging, always proper

Z-Image will not stage a joke you describe as a concept. It will stage a **physical situation**.

### Proper

Family-friendly children's-book cartoon. No gore, no sexualization, no grotesque body horror, no mean-spirited mocking of the dog or owner. Silly = proud dog, stunned human, object in the wrong place, scale mismatch. Never extra limbs, melted faces, or "glowing brains."

### Make the beat visual in one glance

Ask: if the caption were hidden, would a stranger still get the joke?

| Narration idea | Weak visual | Strong visual |
|---|---|---|
| He thinks he's a delivery service | Dog standing near a pile of stuff | Dog marching across the room, leaf clamped in his teeth, presenting it to the kneeling owner like a medal |
| It's not effortless | Dog smiling on a rug | Dog panting, tongue out, muddy paws, ball still in his mouth, owner kneeling with a water bowl |
| He stole the sock | Sock on the floor, dog nearby | Sock hanging out both sides of his mouth, tail wagging, owner mid-video-call with one hand still on the keyboard |
| Dogs conquered humans | Glowing brains and hearts between faces | Owner's keys, phone, and leash in a heap; dog sitting on the couch; owner kneeling to offer a treat |

### Approved silly tools

- **Expression mismatch:** dog blissful, human alarmed.
- **Wrong object, ceremonial pose:** leaf, bottle cap, remote, presented with chest-forward pride.
- **Object in the wrong place:** wet sock on laptop keys, sneaker on the coffee table.
- **Scale:** tiny leaf, huge proud body.
- **Body comedy that stays anatomical:** head tilt with one ear higher, play-bow, zoomies freeze-frame with all four paws on the floor.
- **One extra environmental clue:** dust under the couch, muddy paw dots, a trail of leaves.

### Banned silly tools

- Diagrams, arrows, thought bubbles, emoji, glowing anatomy, split-screen "before/after", readable labels.
- Anthropomorphic jobs: dog behind a cash register with human hands.
- Metaphor clouds, oxytocin beams, translucent organs.
- Crowd scenes, many duplicate dogs, "every breed in one frame."

### Variation

Do not rotate generic beats ("make the environment explain the moment"). Vary **who the carrier is** and **what the punchline prop is**:

- Dog action
- Owner reaction
- Prop still life
- Empty room with consequence (muddy trail, open drawer, sock under the couch)
- Two-shot relationship (presentation, standoff, cuddle)

The protagonist does not need to be in every frame. When he is, he must be the **same dog**, not a redesigned golden.

---

## 8. Scene-direction recipe (what the LLM should write)

The director output is **only the beat + identity + anatomy + place**. No style names, no "16:9", no avoid lists. The composer adds medium and cleanup.

Length: **70–110 words**. If it is longer, you are re-pasting the character sheet.

### Structure

1. Opening clause = `"Exactly N characters:"` with N from 0 to 3, then who they are. Humans and animals both count. Never more than three. Prefer one or two. Use zero only for a place or prop with nobody present.
2. Then the joke or clear action.
3. One identity sentence if that character is visible.
4. Pose, limb count, contact.
5. Face.
6. Two setting facts.

### Example, carrying (rewrite of a real Higgsfilm direction)

**Before (inventory, jargon, contradiction):**

> An adult male Golden Retriever with a medium-large sturdy build and warm golden-orange coat sits proudly on the hardwood floor of a clean suburban living room, his fuller golden fur framing the neck, chest, belly, lower legs, and long feathery tail. His lighter cream-golden muzzle, chest, underside, and lower legs contrast with floppy rounded ears, large paws, dark brown eyes, and a broad black nose. A single slightly damp tube sock rests carefully between his natural jaws, its fabric visibly darkened and slightly crumpled at one end. He holds his head high, eyebrows raised, eyes shining with intense possessive pride, and mouth gently closed around the sock without chewing it.

**After:**

> Exactly one character: a proud adult male golden retriever sits on a hardwood living-room floor and presents a slightly damp white tube sock clamped in his teeth. He is medium-large, warm golden-orange coat, cream muzzle and chest, floppy ears, dark brown eyes, black nose, long feathery tail. Both hind legs folded under him, both front paws planted, one head, two ears, one tail, four legs only. Jaws parted around the sock; cuff hanging out the left side of the mouth, toe hanging out the right; fabric pinched and darkened at the bite. Eyebrows raised, eyes bright, chest high. A simple couch behind him on a white, uncluttered background.

### Example, extra-limb trap (rewrite)

**Before:**

> One paw points toward the porch, while his body faces the kitchen and his head twists toward the living room, creating a comically impossible route.

**After:**

> Exactly two characters: the golden retriever stands on all fours at the junction of kitchen, living room, and open porch, body facing the kitchen, head twisted toward the living room, one front paw lifted a few inches toward the porch and the other three paws planted. A sneaker by the couch, a green leaf on the kitchen floor, a plush bear by the door. The owner stands between the rooms, two arms at his sides, eyes wide, mouth open.

### Example, silly but proper owner reaction

> Exactly two characters: the young adult man sits on the couch during a video call, teal shirt, dark-blue pants, orange shoes, both feet on the floor, left hand on the laptop keyboard, right hand frozen in the air. The golden retriever has just planted a wet white sock on the keys; the sock is still in the dog's teeth, cuff and toe hanging out either side of the mouth. The man stares at the sock with raised eyebrows and a tight grimace. The dog's eyes shine. Living room, white background, couch, laptop.

---

## 9. Composer recipe (what code should send)

Recommended `composeZImagePrompt` output, one paragraph:

```
Clean 2D cartoon illustration, {aspect} canvas, thick smooth near-black outlines, rounded storybook bodies, flat warm fills, white uncluttered background.
{scene direction}
{one-line identity from main/supporting locks if those characters are visible}
{exactly N characters in the frame, N from 0 to 3, no extras}
{one-line anatomy closer from the beat: quadruped-and-empty-mouth, or quadruped-and-bite-geometry}
Even shadowless fill light, paper-like pigment, no photoreal fur, no 3D. Complete bodies as described, no extra limbs, no text, no logos, no watermark.
```

Rules for the function:

- Use the scene direction **once**. Do not echo `canonicalSceneRecordText`.
- Do not inject `scriptSummary` / continuity essays. Continuity belongs in the director LLM, not in CLIP.
- Do not dump the full visual-bible instruction stack. Convert it to the medium sentence above.
- Keep the animal closer to **one sentence**, chosen by the beat, not a policy paragraph.
- Total prompt under **220 words**.

### Anatomy closer picker

If the direction contains a carry/fetch/hold-in-mouth beat:

> Object is inside the mouth, gripped by the teeth, ends hanging out; empty paws; four legs only.

Otherwise:

> Mouth empty; four paws on the floor; four legs only; no object at the muzzle.

---

## 10. Token budget

Assume **1 token ≈ 0.75 English words**. Budget **512 tokens ≈ 380 words**, but quality drops before the hard cut, so stay near **180 words**.

| Piece | Words |
|---|---|
| Medium / canvas | 20–30 |
| Beat + identity | 40–70 |
| Anatomy + contact + face | 30–50 |
| Place + light | 20–30 |
| Cleanup | 15–20 |
| **Total** | **125–200** |

If a prompt is over 220 words, cut in this order: extra coat adjectives, furniture inventory, duplicate identity, any remaining instruction language.

---

## 11. Runtime settings (keep these)

Already correct in `comfyui-z-image-turbo-api.json` / `buildZImageWorkflow`:

- Steps: 8 (9 is also official; do not go to 20+)
- CFG: 1
- Sampler: `res_multistep`
- Scheduler: `simple`
- Negative: `ConditioningZeroOut`
- CLIP: `qwen_3_4b.safetensors`, type `lumina2`
- Resolution: 1152×648 or 648×1152

Do not raise CFG to "fix prompt adherence." Change the wording and seed instead.

Optional later: add a CLIP token counter in ComfyUI and fail or trim if the prompt exceeds 512. Until then, the composer must stay short.

---

## 12. Debugging the failures we actually see

| Symptom | First change | Then |
|---|---|---|
| Object floats in front of the mouth | Rewrite bite geometry; jaws parted; ends hanging out | Drop "closed mouth" |
| Extra legs / missing arms | Count limbs in the prompt; avoid "points with a paw" / "sits upright" | Fewer characters in frame |
| Photoreal / hybrid look | Medium sentence first: "Clean 2D cartoon illustration…" | Confirm style is not after a 400-word dump |
| Flat, boring, samey | Put the joke in sentence two; one ceremonial prop; expression mismatch | Stop restating the full character sheet |
| Dog has human arms | "Complete quadruped, four paws, no human arms" plus a four-on-the-floor pose | Remove table-sitting / pointing verbs |
| Blank or tiny faces | "Two large eyes, eyebrows, shaped mouth"; medium shot; subject large | Do not use wide establishing shots for reaction beats |
| Random text / logos | End with "no text, no logos, no watermark" | Do not mention signs or labels |
| Prompt seems ignored | Count words; if >250, it is being truncated | Delete continuity dump and duplicate direction |

Iterate with a **fixed seed** while editing wording. Change seed only after the composition is right.

---

## 13. Official enhancer, translated for Higgsfilm

Tongyi's `pe.py` persona, compressed into our rules:

1. Lock what the user already decided: subject, count, action, colors, any quoted text.
2. If the brief is abstract ("how dogs conquered us"), invent a **single concrete picture**, not a diagram.
3. Then add craft: composition, light, materials, color, spatial layers.
4. Any visible text must be copied exactly inside English double quotes.
5. Output only the visual paragraph. No metaphor, no feeling-words, no quality tags.

We already have an LLM director. It should write like this enhancer, for cartoon facts, not like a legal department.

---

## 14. Checklist before a generation

- [ ] First sentence names the cartoon medium
- [ ] Direction opens with "Exactly N characters:" (0–3; humans and animals both count)
- [ ] Second sentence is the joke or action
- [ ] Identity is one line, matching the character lock
- [ ] Humans: two arms, two legs, hands explained
- [ ] Animals: four legs, four paws, two ears, one tail
- [ ] If carrying: bite geometry, not "between the jaws"
- [ ] If not carrying: empty mouth, empty paws
- [ ] Never more than three characters total; no extras or duplicate copies
- [ ] No metaphor, no text overlays
- [ ] Final prompt under 220 words
- [ ] No duplicate direction, no script summary in the CLIP text

---

## 15. Pipeline changes this bible implies

Wired when ComfyUI Z-Image Turbo is the selected model:

1. `composeZImagePrompt` uses the section 9 recipe in `src/shared/zImageTurboPrompting.ts`.
2. `buildSceneDirectionPrompt` uses the section 8 recipe when `promptingWorkflow` is `z-image-turbo`.
3. Continuity summaries stay in the director LLM prompt and are not sent to CLIP.
4. `animalInteractionInstruction` remains on the Flux / Higgsfield path only.
5. Existing project visual bibles are compacted into a medium sentence at compose time rather than dumped as instruction stacks.

Flux, Higgsfield, and ChatGPT keep `composeGenerationPrompt` and the default scene-director instructions.
