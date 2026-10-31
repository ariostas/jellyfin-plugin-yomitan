# Client

How the code that runs in jellyfin-web fits together, and what Phases 4 and 5 build on. The server's side of the
conversation is in [api.md](api.md).

## Two scripts

| File | Loaded | Size | Holds |
| --- | --- | --- | --- |
| `client.js` | On every page, by the injected tag | About 1 KB | `src/main.js`, `src/player-hook.js` |
| `engine.js` | When a video first starts | About 240 KB, 44 KB compressed | Everything else |

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
engine-entry.js         the engine script's exports
playback/
  controller.js         follows playback, keeps one session for the current track
  session.js            one track of one playback: loads it, drives the overlay, handles failure
  native-subtitles.js   hides Jellyfin's rendering, and restores it
subtitles/
  source.js             fetches a track, and says whether it holds text at all
  ass.js                parses ASS and SSA scripts
  cleanup.js            text cleanup, dialogue or sign, removes duplicates
  timeline.js           which cues show at a given time
  language.js           isJapaneseTrack()
segmenter.js            splits text into words
overlay.js              draws the current cues. No input.
engine/
  engine.js             the Translator, on the server's dictionaries
  remote-db.js          DictionaryDatabase over HTTP
  term-store.js         batches term lookups, and answers as the server would
  query-client.js       POST /Yomitan/Query
  language-descriptors.js  Japanese only
```

Everything under `subtitles/` and `segmenter.js` is plain logic with no DOM, so tests run it directly in Node.

## What drives it

**Which playback.** Nothing comes from the Sessions API. Two tabs share a `deviceId`, so the server holds one session
for both, describing whichever reported last, and `video.src` is a `blob:` URL under hls.js. `playbackManager` is not a
global, but its events pass through the global `Events`, so `player-hook.js` wraps `Events.trigger` until it sees one,
then unwraps it. From there each tab asks its own `playbackManager`, which is what jellyfin-web's UI does.

**Track changes.** jellyfin-web has no event for them, so `controller.js` polls every 250 ms during video playback. The
key is item, media source, stream index and delivery method. Any change disposes the session and starts a new one.

**The clock.** `video.currentTime + transcodingOffset + subtitleOffset`, read on every animation frame while playing,
and on `timeupdate`, `seeking`, `seeked`, `pause`, `play`, `ratechange` and the 250 ms poll otherwise.

**The subtitle offset.** jellyfin-web keeps it in the player instance, in memory, and resets it with every track and
every item. It subtracts it from each cue's times, so `+2` shows a line 2 s early. `getPlayerSubtitleOffset()` reads it.
jellyfin-web only moves the cues of a *showing* native track, so cues the plugin hid stay put while the offset still
changes. `NativeSubtitles.restore()` catches them up.

## Failing safe

Jellyfin's subtitles are hidden only after the track's text, the dictionary API and at least one dictionary have all
worked. `PlaybackSession._fail()` is the one path for anything that goes wrong after that: it removes the overlay,
restores the native line and stays `inactive` until the track changes. There is no retry within a track.

| Situation | What happens |
| --- | --- |
| Not Japanese | `inactive`, logged at debug level |
| Image or burned-in subtitles | `inactive`, logged once at debug level, no fetch |
| `Stream.js` fails | `inactive`, native line stays |
| ASS script fails | Falls back to `Stream.js`, which has no layers or styles |
| Query fails or no dictionaries, at the start | `inactive`, native line stays |
| Query fails later | Overlay removed, native line restored |
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
only if a headword does, because `ヤバい` and `消しゴム` really are written that way.

It is a one-word-at-a-time model, so it cannot use grammar. See the known issues in
`tests/fixtures/segmentation-corpus.mjs`.

**Round trips.** A new line takes one request, however long. The engine first runs the Translator against a database that
only records what it asks for, sends all of that in one `findTermsBulk`, and then runs the Translator for real against
`TermStore`, which answers from those rows. A second request only happens if a dictionary redirects a form to another
headword. A line seen before takes none. `session.js` segments the current cue and the next two.

**Caches.** `TermStore` keeps rows by term and reading, and `Segmenter` keeps results by text. Every request also carries
`getDictionaryInfo`, in the same read transaction, so a replaced dictionary is noticed by the response that first uses
it, and everything goes. A `truncated` answer is split and retried, then used for the moment but never stored. Both
caches go when the playback ends.

## For Phases 4 and 5

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
```

Inside the bundle, import the classes instead of going through the global.

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
.yomitan-overlay[lang=ja]                  inside the video's parent, so it follows the player
  .yomitan-signs
    .yomitan-line[data-cue-id][data-kind=sign]
  .yomitan-lines
    .yomitan-line[data-cue-id][data-kind=dialogue]
      span.yomitan-word[data-index][data-start][data-end]
      span.yomitan-word.yomitan-unknown[...]
```

A line starts as plain text and becomes spans when its words arrive, which is usually before it shows. It has
`pointer-events: none`, so nothing reaches it yet: Phase 4 has to turn that on for `.yomitan-word`. `data-index` is the
position in the `words` array. The element is rebuilt on every cue, so listen on `.yomitan-overlay`, not on a span.

### Lookups

```js
const {dictionaryEntries, originalTextLength, truncated} = await engine.lookup(word.text);
const kanjiEntries = await engine.lookupKanji('食');
```

Pass `word.text`, not the rest of the line, or the popup can match past what is highlighted, and past a kana boundary.
The default mode is `group`, Yomitan's default. `merge` works too and costs one more request. A lookup's terms are
already in `TermStore`, so it needs one or two requests, for frequencies and tags. `truncated: true` means usable but
perhaps incomplete.

### What `DisplayGenerator` needs

Checked in `tests/e2e/playback.spec.mjs`, which renders a real entry:

- `createTermEntry(entry, engine.dictionaries)` takes `lookup()`'s entries and the summaries, which include `styles`.
- `createKanjiEntry(entry, engine.dictionaries)` takes `lookupKanji()`'s.
- `prepare()` fetches `/templates-display.html`, which does not exist here. Bundle the file and call
  `_templates.load(document)` instead.
- The content manager has to fetch images from `GET /Yomitan/Media`, which needs the `Authorization` header. See
  [api.md](api.md#media) for the rules on untrusted SVG and on scoping a dictionary's `styles`.

### Things to keep in mind

- Before hiding the OSD or anything else from a session, check `session.disposed`: a session ends without warning.
- Clear your own state on `session`, and take no listeners that outlive it. Pass `{signal}` for the session's lifetime.
- `pointer-events: none` is what keeps clicks working now. Turning it on must not swallow clicks that miss a word.
- Native cues use `track.mode = 'hidden'`, not `disabled`, so they stay loaded and in step.
- `session.time` already includes the offset. Do not add it again.
- A failure can end the overlay at any moment, in `_fail`. Listen for `inactive` and close any popup.
