# Client

How the code that runs in jellyfin-web fits together, and what Phases 4 and 5 build on. The server's side of the
conversation is in [api.md](api.md).

## Two scripts

| File | Loaded | Size | Holds |
| --- | --- | --- | --- |
| `client.js` | On every page, by the injected tag | About 2 KB | `src/main.js`, `src/player-hook.js`, `src/settings.js` |
| `engine.js` | When a video first starts, unless the plugin is turned off | About 385 KB, or 107 KB as Jellyfin compresses it | Everything else |

`client/build.mjs` builds both. The engine's content hash is compiled into the loader, and the server computes the same
hash, so `engine.js?v=<hash>` is cached for good and a new build is a new URL. Both are public, like the rest of
jellyfin-web's scripts: neither holds data, and everything they ask the server for goes through the signed-in API.

The bundle holds Yomitan's code unmodified, from the submodule. Only Japanese is kept, by replacing the one module that
lists the languages: `src/engine/language-descriptors.js`. `tests/e2e/engine.spec.mjs` checks that entry against
Yomitan's, and the trimmed Translator's results against the full one's.

## Modules

```text
main.js                 waits for a video, then imports the engine
player-hook.js          finds this tab's playbackManager
settings.js             the one settings store, created here and handed to the engine
engine-entry.js         the engine script's exports
playback/
  controller.js         follows playback, keeps one session for the current track
  session.js            one track of one playback: loads it, drives the overlay, handles failure
  native-subtitles.js   hides Jellyfin's rendering, and restores it
  hold.js               pauses for a lookup, and resumes only what it paused
  osd.js                what jellyfin-web's OSD covers now
subtitles/
  source.js             fetches a track, and says whether it holds text at all
  ass.js                parses ASS and SSA scripts
  cleanup.js            text cleanup, dialogue or sign, removes duplicates
  timeline.js           which cues show at a given time
  language.js           isJapaneseTrack()
segmenter.js            splits text into words
layer.js                the element everything of ours goes in
overlay.js              draws the current cues, and says which word an event hit
input/
  pointer.js            mouse and touch
popup/
  lookup.js             a word's popup, highlight and pause, as one thing. Phase 5 starts here
  popup.js              the shadow root, and fitting it on screen
  placement.js          where it goes. Plain arithmetic
  renderer.js           Yomitan's DisplayGenerator
  content-manager.js    a dictionary's images and links
  sanitize.js           makes a dictionary's content safe
engine/
  engine.js             the Translator, on the server's dictionaries
  remote-db.js          DictionaryDatabase over HTTP
  term-store.js         batches term lookups, and answers as the server would
  query-client.js       POST /Yomitan/Query
  yield.js              gives the page a turn during long work
  language-descriptors.js  Japanese only
```

Everything under `subtitles/`, `segmenter.js` and `popup/placement.js` is plain logic with no DOM, so tests run it
directly in Node.

## Settings

`window.__yomitanJellyfin.settings` is the only store. The loader creates it, and passes it down to whatever needs it, so
there is one place to read and one to change. It keeps its values in `localStorage` for now, and Phase 6 replaces that
and adds the UI. Inside the bundle, take it from the session or the controller.

```js
settings.get('hoverDelayMs');
settings.set('enabled', false);
settings.addEventListener('change', ({detail: {name, value}}) => {});
```

| Setting | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Off means the engine does not load, and playback is what jellyfin-web does alone. Takes effect at once |
| `hoverDelayMs` | 200 | How long the mouse rests on a word before anything happens |
| `hoverGraceMs` | 300 | How long the popup survives the mouse leaving it and the word |

**`enabled` is on by default, against [PLAN.md](../PLAN.md)'s decision 4.** There is no UI to turn it on until Phase 6,
which has to change the default when it adds one. It is harmless meanwhile: nothing happens without a Japanese subtitle
track and an installed dictionary.

With it off, the loader stays on the page, keeps its one listener on `playbackManager`, and that is all. The video has
the same listeners as with the plugin blocked outright, which `tests/e2e/settings.spec.mjs` counts.

## What drives it

**Which playback.** Nothing comes from the Sessions API. Two tabs share a `deviceId`, so the server holds one session
for both, describing whichever reported last, and `video.src` is a `blob:` URL under hls.js. `playbackManager` is not a
global, but its events pass through the global `Events`, so `player-hook.js` wraps `Events.trigger` until it sees one,
then unwraps it. From there each tab asks its own `playbackManager`, which is what jellyfin-web's UI does.

**Which subtitles it draws.** jellyfin-web draws text as native cues in Chromium, and in the custom `.videoSubtitles`
element in Firefox and Safari or if the user sets Subtitle styling to Custom. ASS goes through JASSUB everywhere.
`NativeSubtitles` hides all three, and `tests/e2e/native-subtitles.spec.mjs` checks them in real playback.

**Track changes.** jellyfin-web has no event for them, so `controller.js` polls every 250 ms during video playback. The
key is item, media source, stream index and delivery method. Any change disposes the session and starts a new one.

**Where it draws.** jellyfin-web's page sits over the video and takes every pointer event, and the video's container is
its own stacking context, so nothing inside the container can be hit. `Layer` is a fixed element in the body at
z-index 1150: over the page, the OSD (1 and up) and its app bar (1100), and under jellyfin-web's menus (1300) and dialogs
(999998). It takes no pointer events itself. jellyfin-web makes the whole page fullscreen, so the layer is normally
inside the fullscreen element already. If something else goes fullscreen, it moves in.

**The OSD.** The controls sit where a line goes, so the overlay moves clear of them while they show, using their
real size. `session.js` follows `SHOW_VIDEO_OSD`, and its poll catches the rest. It leaves the line alone while a word is
in use: the OSD hides by itself after 3 s, and a line that moved would take the word out from under the mouse.

**The clock.** `video.currentTime + transcodingOffset + subtitleOffset`, read on every animation frame while playing,
and on `timeupdate`, `seeking`, `seeked`, `pause`, `play`, `ratechange` and the 250 ms poll otherwise.

**The subtitle offset.** jellyfin-web keeps it in the player instance, in memory, and resets it with every track and
every item. It subtracts it from each cue's times, so `+2` shows a line 2 s early. `getPlayerSubtitleOffset()` reads it.
jellyfin-web only moves the cues of a *showing* native track, so cues the plugin hid stay put while the offset still
changes. `NativeSubtitles.restore()` catches them up.

## Failing safe

Jellyfin's subtitles are hidden only after the track's text, the dictionary API and at least one dictionary have all
worked. `PlaybackSession._fail()` is the one path for anything that goes wrong after that: it removes the overlay,
restores the native line and stays `inactive` until the track changes. Before that, `QueryClient` retries a request
twice over about 2 s on a network error or a 5xx, so a short drop only delays a line's words. A 4xx is not retried.

| Situation | What happens |
| --- | --- |
| Not Japanese | `inactive`, logged at debug level |
| Image or burned-in subtitles | `inactive`, logged once at debug level, no fetch |
| `Stream.js` fails | `inactive`, native line stays |
| ASS script fails | Falls back to `Stream.js`, which has no layers or styles |
| Query fails or no dictionaries, at the start | `inactive`, native line stays |
| Query fails later | Retried, then overlay removed and native line restored |
| A lookup fails | Logged, popup closed, playback resumed if the plugin paused it. The session carries on |
| A dictionary's entry cannot be drawn | The same |
| Engine script fails to load | Logged, nothing else happens |
| `Events` never appears | Logged at debug level, nothing else happens |

## Subtitles

**Only Japanese.** `isJapaneseTrack(stream, cues)` in `subtitles/language.js` is the one decision. A Japanese tag wins,
any other language tag loses, and an untagged track is judged on its text: at least 30% of its letters must be kana or
kanji, and at least 15% of those must be kana, which rules out Chinese. Phase 6's setting goes here.

**ASS.** The original script comes from `Stream.ass`, the file Jellyfin's own renderer reads, because `Stream.js` drops
layers, styles and effects. If that fails, `Stream.js` still works: its tags survive, so only style information is lost.

**Dialogue and signs.** A cue's `kind` is `dialogue` or `sign`, decided in `subtitles/cleanup.js`, in this order:

1. Comments, drawings (`{\p1}`) and events with no text are dropped.
2. A style named like a sign, title or song, unless it is the main style, makes a sign. The main style is the one with
   the most text among unpositioned events.
3. An `fx`, `template`, `code` or `karaoke` effect makes a sign.
4. Rotation, shear or clipping makes a sign.
5. `\pos` or `\move` outside the main style makes a sign. Inside it, only if under half that style's events are
   positioned, since captions from Japanese TV position every line.
6. Everything else is dialogue.

Then, signs with no Japanese in them are dropped (romaji, translators' notes), so are overlapping signs of one or two
characters (karaoke syllables), and copies of a text that overlap or touch are merged into one cue (outline layers,
signs repeated frame by frame).

The overlay shows dialogue at the bottom and signs at the top, both as plain text. Overlapping cues all show.

**Secondary subtitles.** Decided: the plugin works on the primary track only, and never touches the secondary one, which
Jellyfin keeps rendering (`textTracks[1]`, or `.videoSecondarySubtitlesInner`). When one is on, the overlay moves up out
of its way. A Japanese secondary track under a non-Japanese primary one is not activated: put Japanese first.
jellyfin-web only allows a secondary track with a text primary, so this never meets ASS.

## Segmentation

`Segmenter.segment(text)` gives a list of [words](#the-word). It is not the greedy longest match PLAN.md planned, which
turned out to fail on real text: with JMnedict loaded, `君のことなんて` became `君/のこ/となん/て`.

Instead every candidate gets a cost, and the cheapest path through the line wins. The numbers are in `COST` in
`segmenter.js`, and the comments there say why each exists. About 1 per word, so fewer words is better, and more for weak
evidence: a name, a rare word, hiragana that only matches a kanji word's reading, or a span that is really a word plus a
particle. The kana boundary rule from PLAN.md stays, with one refinement: a match may cross a hiragana/katakana boundary
only if a headword does, because `ヤバい` and `消しゴム` really are written that way. The costs alone handle most of what
the rule was for, but it still changes 17 of 1,847 lines of real subtitles, nearly all for the better, such as
`の/デパート` over `のデ/パート`.

It is a one-word-at-a-time model, so it cannot use grammar. It got 24 of 28 unseen lines of real subtitles exactly right
(fixed by hand, in advance). The misses are in `tests/fixtures/segmentation-corpus.mjs`, marked `known`.

**Round trips.** A new line takes one request, however long. The engine first runs the Translator against a database that
only records what it asks for, sends all of that in one `findTermsBulk`, and then runs the Translator for real against
`TermStore`, which answers from those rows. A second request only happens if a dictionary redirects a form to another
headword. A line seen before takes none. `session.js` segments the current cue and the next two. The Translator's awaits
only yield to microtasks, so `yield.js` cuts this work into slices of about 8 ms, to keep the page responsive.

**Caches.** `TermStore` keeps rows by term and reading, up to 30,000 rows, and starts over between lines when it is
full. `Segmenter` keeps results by text for as long as the track lasts. Every request also carries `getDictionaryInfo`,
in the same read transaction, so a replaced dictionary is noticed by the response that first uses it, and everything
goes. A `truncated` answer is split and retried, then used for the moment but never stored. Both caches go when the
playback ends.

## Using a word

`WordLookup` in `popup/lookup.js` is a word's popup, its highlight and the pause, as one thing with one way in and one way
out. `input/pointer.js` only decides which word and when. Phase 5's keys should do the same.

### The mouse

Which kind of input it is comes from each event, not from the device, since a laptop can have both.

| What happens | Result |
| --- | --- |
| Rests on a word for `hoverDelayMs` | Pauses a playing video, then opens the word |
| Moves to another word, and rests | Swaps the popup. The video stays paused |
| Crosses from the word to the popup | Nothing, as long as it takes less than `hoverGraceMs` |
| Leaves both for `hoverGraceMs` | Closes, and resumes if the plugin paused |
| Clicks a word | Opens it at once, and jellyfin-web does not see it |
| Wheel over the popup | Scrolls it. jellyfin-web turns the wheel into volume, so the popup stops the event |
| Anything in a gap between words | jellyfin-web's |

**The hover delay is what keeps the OSD usable.** Going for the controls means crossing the line, so nothing may happen
on the way. A word has to stay under the mouse for 200 ms, which a mouse on its way somewhere else does not do. A mouse
at 1500 px/s spends about 30 ms on a word, and `hover.spec.mjs` checks that this does not pause. It applies to swapping
too, so a diagonal from a word to the popup does not swap on a neighbour.

**A resting mouse does nothing.** Hover goes by `pointermove`, never `pointerover`. A browser sends `pointerover` when a
line appears under a mouse that has not moved, and listening for that would pause the film whenever a line landed on it.

**After someone closes a popup, its word stays closed** until the mouse has left it, so a nudge after pressing space does
not pause again.

### A finger

| What happens | Result |
| --- | --- |
| Taps a word | Pauses and opens it, on `pointerdown`, since a line can end before the `click`. Tapping it again does nothing |
| Taps another word | Swaps the popup |
| Taps anywhere else, with a popup open | Closes, and resumes if the plugin paused |
| Drags in the popup | Scrolls it, and stops there (`overscroll-behavior: contain`) |
| Taps anywhere else, with no popup | jellyfin-web's |

jellyfin-web acts on `pointerdown`: a touch toggles the OSD, and a mouse toggles playback. So a tap that belongs to the
popup is stopped at `window` in the capture phase, and for 700 ms after, its `touchstart` is cancelled and its compatibility
mouse events and `click` are stopped too. A closing tap on an OSD control only closes: otherwise a tap on the play button
would pause what the plugin has just resumed.

### Pausing

`PlaybackHold` pauses with `video.pause()` and resumes with `video.play()`, which go through jellyfin-web's own listeners,
so the server stays in step. It only resumes what it paused.

- A video the user paused stays paused, whatever the popup does.
- A `play` event it did not cause means someone pressed play. The popup closes, and the hold is forgotten.
- A seek closes the popup, and resumes if the plugin paused.
- Ending with the track or the session also resumes. Only a stopped playback does not: there is no video left.

**A word looked up pauses first, and shows after.** `known` says a dictionary has it, so a miss is not a real risk, and a
line can end during the request. A word that is not `known` takes no pointer events at all, so hovering it never pauses:
that would interrupt for nothing. A word that is `known` and still finds nothing, as when a dictionary has just gone,
resumes at once.

### The popup

It is Yomitan's. `renderer.js` runs its `DisplayGenerator` unmodified, with `templates-display.html` from the submodule,
in a shadow root, so neither side's CSS reaches the other. `client/display-css.mjs` builds the CSS from Yomitan's, changing
three things by rule: `:root` becomes `:host`, the settings page's rules in `material.css` go, and URLs go, apart from two
icons that are inlined, since they point into an extension. The options the extension sets on `<html>` are on the popup's
host, at their defaults, apart from `compactTags`, which hides a dictionary's name when it repeats.

The kanji stroke order font is not bundled: it is several MB, so a kanji's glyph shows in the normal font. There are no
audio or Anki buttons, as PLAN.md leaves them out.

A popup shows at most 32 term entries, which is Yomitan's default. After them come the kanji of the word, if a kanji
dictionary is installed.

### Untrusted dictionaries

Any zip an admin uploads ends up here, often from a stranger, and this page has no content security policy to fall back
on. Yomitan's generators build content as text nodes and an allowlist of tags, so markup was never the problem. These
were, and `popup/sanitize.js` and `content-manager.js` close them. `tests/e2e/hostile.spec.mjs` proves it with a real
popup and a server that counts requests.

| Gap in Yomitan's generators | What happens here |
| --- | --- |
| `style` values are copied as they are, so `background: url(...)` fetches | Every declaration is checked, and only functions on a list stay |
| `href` is copied as it is. The importer's schema allows `http:`, `https:` and `?` only, but the client does not lean on that | Only `http:` and `https:` get an `href` |
| An image's link is its own `blob:` URL. A blob has this page's origin, so opening a dictionary's SVG in a tab runs its scripts | The `href` is removed. An SVG only ever shows through an `<img>` |
| `styles.css` is plain CSS, with `@import`, `url()`, `@font-face` and `image-set()` | Parsed by the browser into a `CSSStyleSheet`, and only style rules, `@media` and `@supports` come back out, with the same check on each value |
| `position: fixed` could cover the page | The popup's frame has `contain: layout paint`, so it is the containing block, and it clips |

The check is a list of functions that are allowed, not of those that are not, because the ways to load something keep
growing. A backslash anywhere in a value is refused as well: the browser resolves escapes in what it parses, but keeps them
in custom properties and in values holding a `var()`. The list would already refuse `u\72l(`, as a function called `72l`, so
this is a second guard, and it saves reasoning about what an escape turns into. `attr()` is only allowed in `content`.

A link to a web page stays, with `target=_blank` and `rel=noreferrer noopener`, and does nothing until someone follows it.
A link to another entry opens that entry in the popup.

**Images** come from `GET /Yomitan/Media`, which needs the `Authorization` header, so they are fetched and shown from
`blob:` URLs. Every URL is revoked when the popup closes or moves to another word, and a fetch still under way is aborted.
A popup loads 32 images at most.

### Where it goes

`placement.js` puts it above the lines if the entry fits there or there is more room, and otherwise below, clear of the OSD
if it can be. It goes by the whole block of lines and not just the word, so the sentence stays readable, and it never
covers the word. Long entries scroll inside it. It moves on `resize`, which covers turning a phone.

## For Phase 5

`window.__yomitanJellyfin.playback` is the `PlaybackController`, present from the first video on. It is an `EventTarget`:

| Event | `detail` | When |
| --- | --- | --- |
| `session` | `{session}`, or `session: null` | A track starts or ends |
| `active` | `{session, cues}` | The overlay took over. `cues` is the whole track |
| `inactive` | `{session}` | Jellyfin's subtitles are showing, by choice or after a failure |
| `cuechange` | `{session, cues}` | What is on screen changed. `cues` may be empty |
| `words` | `{session, cue, words}` | A cue on screen just got its words |

```js
const {playback} = window.__yomitanJellyfin;
const {session, engine} = playback;

session.state;              // 'idle', 'active' or 'inactive'
session.cues;               // the cues on screen now
session.words.get(cue.id);  // their words, once known
session.time;               // the current time in the subtitle file, offset included
session.lookup;             // see below. Null unless the state is 'active'
```

Inside the bundle, import the classes instead of going through the global.

### The popup, without a pointer

Nothing here needs a pointer, and `tests/e2e/popup.spec.mjs` drives it from code.

```js
const {lookup} = session;

await lookup.open({cueId: cue.id, index});  // Pauses, marks the word, shows it. True if it ended up showing
lookup.scrollBy(120);                       // Pixels, down if positive
lookup.close();                             // Closes, and resumes if the plugin paused

lookup.current;                             // {cueId, index}, while open or opening
lookup.isOpen;                              // Showing now
lookup.holding;                             // The video is paused because of a lookup
lookup.addEventListener('close', ({detail: {reason, word}}) => {});
```

`index` is the position in `session.words.get(cue.id)`. `open` on another word swaps, and `open` on a word that is not
`known` returns `false` and does nothing. In PLAN.md's flow the video is paused before the cursor appears, so that pause
is not the plugin's, and `close()` leaves it paused, which is what Back wants there. `reason` is one of:

| `reason` | Meaning |
| --- | --- |
| `closed` | `close()` was called with no reason |
| `left`, `tapped` | The mouse left, or a tap landed elsewhere |
| `play` | Someone pressed play. The video is already playing |
| `seek` | A seek, or the video was reloaded |
| `miss`, `error`, `gone` | Nothing was found, the lookup failed, or the line went |
| `ended`, `stopped` | The session ended, with the video going on, or with it gone |

Moving the cursor over a word marks it through `lookup`, and `Overlay.setActiveWord` is the highlight on its own.

### The cue

| Field | Meaning |
| --- | --- |
| `id` | Index in the track. `data-cue-id` in the overlay |
| `start`, `end` | Seconds in the subtitle file |
| `text` | Clean text. Lines are separated by `\n` |
| `kind` | `dialogue` or `sign` |

### The word

| Field | Meaning |
| --- | --- |
| `text` | As written |
| `start`, `end` | Range in `cue.text`, in UTF-16 units. `end` is exclusive. `data-start` and `data-end` in the overlay |
| `known` | Whether a dictionary has it. Punctuation and unknown text are words too, with `known: false` |
| `term`, `reading` | Dictionary form, for a known word |

Words cover the cue's text except for white space, in order. Pick targets with `known`, and step through them for the
Phase 5 cursor.

### The overlay

```text
body
  .yomitan-layer
    .yomitan-overlay[lang=ja]
      .yomitan-signs
        .yomitan-line[data-cue-id][data-kind=sign]
      .yomitan-lines
        .yomitan-line[data-cue-id][data-kind=dialogue]
          span.yomitan-word[data-index][data-start][data-end]
          span.yomitan-word.yomitan-unknown[...]
          span.yomitan-word.yomitan-active[...]    the word in use
    .yomitan-popup                                 the popup's shadow host
```

A line starts as plain text and becomes spans when its words arrive, which is usually before it shows. Only a known word
has `pointer-events: auto`, so a line not yet split, an unknown word and the gaps all stay click-through. `data-index` is
the position in the `words` array. The element is rebuilt on every cue, so keep `{cueId, index}`, not a span:
`overlay.wordElement(word)` finds the span, and `overlay.wordAt(event.target)` goes the other way.

### Lookups

```js
const {dictionaryEntries, originalTextLength, truncated} = await engine.lookup(word.text);
const kanjiEntries = await engine.lookupKanji('食');
```

Pass `word.text`, not the rest of the line, or the popup can match past what is highlighted, and past a kana boundary.
The default mode is `group`, Yomitan's default. `merge` works too and costs one more request. A lookup's terms are
already in `TermStore`, so it needs one or two requests, for frequencies and tags. `truncated: true` means usable but
perhaps incomplete.

### Things to keep in mind

- Before hiding the OSD or anything else from a session, check `session.disposed`: a session ends without warning.
- Clear your own state on `session`, and take no listeners that outlive it. Pass `{signal}` for the session's lifetime.
- A synthetic Escape with the OSD hidden exits the player. See PLAN.md.
- Native cues use `track.mode = 'hidden'`, not `disabled`, so they stay loaded and in step.
- `session.time` already includes the offset. Do not add it again.
- A failure can end the overlay at any moment, in `_fail`. Listen for `inactive`.
- jellyfin-web's `keydown` listeners are on `document`, so capture on `window` to get there first.
