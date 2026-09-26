# Channel guide examples

Copy these templates into a new channel folder, fill the `[PLACEHOLDERS]`, then point the channel profile at them in Settings.

## How the app uses each file

| File | App field / section |
|---|---|
| `guides/Video Idea - Idea Guide.md` | Settings → Idea guide |
| `guides/Script Creator - Script Bible.md` | Settings → Script bible |
| `guides/Visual Direction - Style Guide.md` | Visual direction → Visual bible (reference while filling fields; not a preset import) |
| `guides/Visual Direction - Custom Images 16x9.txt` | Generate Custom images → Choose guide |
| `guides/Condensed Short - Custom Images 9x16.txt` | Condensed short / 9:16 generation |
| `guides/Tools - Regenerate Expressions.txt` | Tools → Regenerate expressions → Choose guide |
| `guides/Production Workflow.md` | Producer checklist (read manually; not a single app upload) |

## Quick start for a new channel

1. Create a channel root, e.g. `MyChannels/MyChannel/`.
2. Copy everything from `examples/guides/` into that folder.
3. Open each file and replace every `[PLACEHOLDER]` (see list below).
4. Add your character sheet, face refs, and (optional) `Expressions/` library.
5. In Higgsfilm Settings, create a channel profile:
   - Channel folder → your channel root
   - Idea guide + Script bible → the filled `.md` files
   - Visual bible → paste identity from the style guide
   - Still library → `Expressions/` if you keep one
6. In image tools, choose the filled Custom / Expression guides and attach your refs.
7. Create episodes as `MyChannels/MyChannel/<Episode Name>/` (never treat the channel root as an episode).

See `sample-channel/` for a filled personal-finance mascot example of the same structure.

## Placeholder glossary

| Placeholder | Meaning |
|---|---|
| `[CHANNEL]` | Channel / profile name |
| `[CHARACTER]` | On-screen protagonist name |
| `[NARRATOR]` | Narration voice description (usually friendly third-person) |
| `[NICHE]` | One-line niche |
| `[AUDIENCE]` | Who watches and what they want |
| `[SUBJECTS]` | In-scope topics |
| `[OUT_OF_SCOPE]` | Topics to reject |
| `[ART_MEDIUM]` | Visual medium (e.g. paper collage, flat vector, 3D) |
| `[WARDROBE]` | Always-on costume |
| `[HARD_ID_MARKERS]` | Must-pass identity checks every character shot |
| `[SUPPORTING_CAST_RULE]` | Who supporting characters may be |
| `[CHANNEL_ROOT]` | Path to this channel folder |
| `[CHARACTER_SHEET]` | Path to turnaround / proportion sheet |
| `[FACE_REFS]` | Path(s) to face / craft references |
| `[TOPIC_WORLD]` | Concrete props / locations this niche uses |
| `[KEYWORD_POOL]` | Spoken search phrases that fit dialog |
| `[KEYWORD_AVOID]` | Phrases that belong in titles/descriptions only |
| `[EXAMPLE_TOPIC]` | One sample episode premise for the workflow doc |
| `[OUTRO_LINES]` | Fixed Custom closer lines the app appends (verbatim) |
