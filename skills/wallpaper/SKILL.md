---
name: wallpaper
description: Design a Ringback live wallpaper for the user's phone (a data-only skin) that looks good and reacts to their Claude Code sessions. Use whenever you call set_phone_wallpaper, or show_on_phone for a wallpaper picture, or the user asks for a new phone wallpaper, background, lock screen look or "make my phone show what my agents do".
---

# Designing a Ringback wallpaper

A Ringback wallpaper is a **skin**: JSON data the phone validates and draws itself. Nothing in it
runs as code. You set it with `set_phone_wallpaper {skin}`, look at it with `wallpaper_preview`,
and refine until it is good. Only change the wallpaper when the user asked for it.

## The loop (always)

1. Read the brief: mood words the user used, colours or places they named, how much they want to
   see (just the time, or what every session is doing). If one thing is truly unclear, ask one
   question; otherwise state your read in one line ("Calm dark sea, one glow for working sessions").
2. Start from the closest gallery skin (`gallery/*.json` next to this file) and change it; do not
   start from an empty file.
3. `set_phone_wallpaper {skin}`, then `wallpaper_preview`. Look at the picture critically: is the
   clock legible, is text inside its zone, is anything clipped, crowded or low in contrast? Fix
   and repeat. Two or three rounds is normal.
4. Tell the user what you made in one or two sentences and that it reacts to their sessions.

## Phone rules

- Clock zone: the top 25% of the screen (the system clock and notifications live there too; keep
  it calm and high contrast). Card and status zone: the bottom 30%. Keep the middle mostly open:
  app icons sit there on the home screen.
- Legible on any background: aim for a contrast of about 4.5 to 1. Over a photo, put a
  translucent band (a `rect` filled like `#00000066`) behind text.
- Battery: animation is optional. Prefer one slow animation (1 s or longer, pingpong) over many
  fast ones, and particles at density 0.5 or less. A skin without `anim` or `particles` redraws
  only once a minute.
- No busy noise: at most 3 or 4 colours plus neutrals, one accent used sparingly. Avoid the
  default AI look (a purple-blue gradient with a centred glow, neon on everything).
- Keep text short; the phone cuts long titles and summaries. Set `w` and `maxLines` on long text.

## Skin reference (version 1)

```
{ "version": 1, "name": "Short name",
  "background": { "gradient": ["#rrggbb", "#rrggbb"] } | { "color": "#rrggbb" } | { "image": "card.<id>" },
  "layers": [ up to 64 layers ] }
```

Positions and sizes are fractions of the screen (x and y from the top left, 0 to 1). Colours are
`#rrggbb` or `#rrggbbaa`. A gradient has 2 to 6 colours. A skin is at most 64 KB.

| type | fields |
|---|---|
| `rect` | x, y, w, h, radius, fill, stroke, strokeWidth |
| `circle` | x, y, r, fill, stroke, strokeWidth |
| `text` | x, y, size, text, color, align (left, center, right), font (sans, mono, pixel), weight, w, maxLines |
| `image` | x, y, w, h, asset `card.<id>`, fit (cover, contain), radius |
| `particles` | kind (rain, snow, stars, sparks, bubbles), density 0 to 1, color |
| `arc`, `bar` | x, y, r (arc) or w and h (bar), width, color, track, value `card.<id>.progress` |

Every layer may have `opacity`, `visible` (a condition), `tap` (`open` or `card.<id>.<action_id>`)
and `anim`: `{ "prop": "opacity|x|y|scale|rotate", "from": 0, "to": 1, "ms": 1200, "loop": "pingpong|repeat|once" }`.
Any colour, `text` or `opacity` can be a choice: `{ "if": "<condition>", "then": ..., "else": ... }`.

**Text placeholders:** `{time.hhmm}`, `{time.date}`, `{time.day}`, `{card.<id>.title|body|progress|source}`,
and the session keys `{sessions.count}`, `{sessions.working}`, `{sessions.waiting}`,
`{session.N.title}`, `{session.N.summary}`, `{session.N.state}` for N = 1 to 4 (working sessions
first, then waiting ones; the state reads Working, Waiting or Offline).

**Conditions:** `night`, `card.<id>.exists`, `card.<id>.pinned`, `any.working` (a session is
working), `any.needsYou` (a session waits on a permission or idle prompt; cleared when the user
answers), `call.active`, `call.conference` (two or more sessions on the call), `session.N.exists`,
`session.N.working`.

Typical reactions: a glow that pulses while `any.working` and turns amber (`#F5A624`) on
`any.needsYou`; an "On call" line on `call.active`; one dot per participant on `call.conference`.

## Pictures as backgrounds

1. Get a picture: one the user gave you, or generate one (for example with `codex exec` and an
   image prompt, when Codex is installed). Portrait, about 1080 by 2340, no text in it.
2. Make it smaller than 1 MB (JPEG quality around 80; resize with any tool you have).
3. Push it as a card picture: `show_on_phone {card_id: "wallpaper-photo", title: "Wallpaper", image_path: "<file>"}`.
4. Use `"background": { "image": "card.wallpaper-photo" }` and a translucent band behind the text.
   See `gallery/valletta-photo.json`.

## Gallery (start here and remix)

- `aurora-build.json`: dark teal aurora and stars; a glow breathes while sessions work and turns amber when one needs the user.
- `malta-sunset.json`: warm sunset bands, the sea at the bottom holding the session status.
- `valletta-photo.json`: a photo background (pushed as card `wallpaper-photo`) with dark bands for clock and status.
- `pixel-sea.json`: a pixel night sea with a boat that bobs and lights amber when the user is needed.
- `neon-rain.json`: dark rain, a magenta clock and a blinking "ON CALL".
- `minimal-mono.json`: warm off-white, left aligned type, one status dot (green working, rust needs you).
- `deep-focus.json`: near black with a progress ring driven by card `focus`.
- `conference-room.json`: three pulsing dots while a conference call is on.
- `snow-quiet.json`: light and slow snow, plain status at the bottom.

The built-in Star Sea (`set_phone_wallpaper {builtin: "star-sea"}`) is not a skin; it already
reacts to the sessions by itself (Clawd works, waves when the user is needed, keeps company on calls).
