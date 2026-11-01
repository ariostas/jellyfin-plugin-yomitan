# Jellyfin Yomitan plugin plan

A Jellyfin plugin that adds Yomitan-style dictionary lookups to subtitles, with no fork of Jellyfin.

## Verdict

**Feasible as a plain server plugin for every client that runs jellyfin-web from the server.** That covers
desktop browsers, mobile browsers and the Android app in web player mode.

**Scope decided:** desktop browser and the Jellyfin Android app are the targets. Android TV is also wanted but
the app is native Kotlin with no web view, so a plugin cannot touch it. That is accepted, with no workaround
planned. Samsung and LG TVs are not targets, so there is no real-TV testing phase.

## What was tested

Spike run on Jellyfin **12.4.0** (podman) with headless Chromium 156 driven by Playwright. It used a real
plugin, Yomitan's real `Translator`, and real JMdict/JMnedict data.

| Question | Result |
| --- | --- |
| Can a plugin inject JS into the web UI? | Yes. An `IStartupFilter` middleware rewrites `index.html`. No File Transformation dependency needed. |
| Can Yomitan's engine run outside an extension? | Yes. `ext/js/language` and `ext/js/dictionary` have no `chrome.*` use, and `Translator` takes an injected database. 611 KB minified. |
| Does deinflection work? | Yes. 食べられなかった → 食べる, 行きませんでした → 行く, with the rule chains. |
| Dictionaries on the server? | Yes. See the numbers below. |
| Dictionary upload from a settings page? | Yes. A dashboard page with a file input uploaded through the UI. A 171 MB upload also worked (via curl). Anonymous upload and query return 401. |
| Read subtitle text for any text format? | Yes. `Videos/{id}/{msId}/Subtitles/{index}/Stream.js` returned timed text for SRT and embedded ASS. |
| Stays in sync when transcoding? | Yes. On a real `Transcode` session, `video.currentTime` picked the correct cue after seeks to 5, 20 and 45 s. |
| Mouse hover? | Yes, on the ASS file. Hover pauses, the server sees `IsPaused`, leaving resumes, clicking a word does not toggle playback. SRT not run, though the overlay does not depend on the format. |
| Touch? | Yes under Playwright touch emulation, on the ASS file. Tap pauses and opens the popup. |
| TV remote? | Yes in TV layout with a keyboard, on SRT and ASS. A `window` capture listener takes the arrow keys. Time stays frozen, the word cursor moves, and Back closes only the popup. |

Lookups need these numbers re-measured on real hardware, since everything ran on localhost on a dev machine:

| Measurement | Result |
| --- | --- |
| JMdict import | 527,617 rows in 9.0 s |
| JMnedict import | 668,025 rows in 8.8 s |
| Database size, both dictionaries | 313 MB, plus WAL (515 MB on disk before checkpoint) |
| Query, 30 terms | about 16 ms |
| Popup lookup through the engine | about 146 ms |
| Segmenting one line | 250 to 360 ms, 10 to 12 round trips |

### Tested negatives that shaped the design

- **`::cue` CSS does not hide native subtitles.** `track.mode = 'hidden'` does, and restoring `showing` on
  resume works.
- **A synthetic Escape with the OSD already hidden exits the player.** Only send it when `.videoOsdBottom` is
  visible.
- **`playbackManager` is not a global.** `ApiClient`, `Events`, `Dashboard` and `Emby` are. Use the `<video>`
  element and the Sessions API.
- **Kestrel rejects synchronous request body reads.** Spool uploads to a temp file with async IO.
- **ASS on this server drew tofu boxes** because the container has no CJK font. The DOM overlay uses client
  fonts and is unaffected.

## Client support

| Client | Loads server web UI? | Expected | Basis |
| --- | --- | --- | --- |
| Desktop browser | Yes | Works | Tested in Chromium, Firefox and Playwright's WebKit on Linux. Safari itself untested. |
| Mobile browser | Yes | Works | Touch emulated only. Real phones untested. |
| Jellyfin Android app | Yes, in a WebView | Works with a setting | Source read, not run. **Defaults to native ExoPlayer**, so the user must select the web player. |
| LG webOS | Yes, hosted | Should work | Source read, plus webOS user agent emulation (custom DOM subtitles, TV layout, Back keyCode 461 dispatched synthetically). No real TV. |
| Samsung Tizen | **No, bundled** | Needs a rebuilt `.wgt` | Source read. Injection never reaches it. |
| Android TV, Google TV, Fire TV | **No, native** | Not possible by plugin | Source read. No WebView in the app. |
| Jellyfin Desktop | Unknown | Likely not | Qt WebEngine plus libmpv per its README. Not tested. |
| Swiftfin, iOS | Not investigated | Native apps unlikely | Not tested. |

## Architecture

```text
Jellyfin server                          Client (jellyfin-web)
+---------------------------+            +------------------------------------+
| Plugin (C#)               |  script    | yomitan-client.js                  |
|  index.html injection  ---+----------->|  Yomitan Translator (unmodified)   |
|  Dictionary import        |            |  RemoteDb adapter                  |
|  SQLite store          <--+-- query ---+  Subtitle source (Stream.js)       |
|  Query API                |            |  Overlay and popup                 |
|  Settings page            |            |  Input: pointer, touch, remote     |
+---------------------------+            +------------------------------------+
```

### Decisions

1. **Own injection middleware instead of File Transformation.** It is only an `IStartupFilter` plus middleware,
   so a dependency adds an install step and version lag for no gain. The spike short-circuits the response,
   which would discard edits from other plugins, so the real version must not. See Phase 1.
2. **Dictionaries on the server, engine in the client.** A TV should not import hundreds of MB per device, and
   admins should upload once. The engine stays in the browser because deinflection is Yomitan's JS and
   reimplementing it in C# would drift from upstream. Only the database layer crosses the network.
3. **Own overlay, never read the rendered subtitles.** There are three render paths and only one is readable:

   | Path | When | Readable? | How to hide |
   | --- | --- | --- | --- |
   | Native `VTTCue` | SRT on desktop Chromium | No, browser painted | `track.mode = 'hidden'` |
   | Custom DOM | webOS, or the user setting | Yes | `.videoSubtitles { visibility: hidden }` |
   | JASSUB canvas | ASS/SSA | No, pixels | `.libassjs-canvas { visibility: hidden }` |

   The plugin fetches `Stream.js` itself and uses `video.currentTime` as the clock. The server's reported
   position lags, so it is not used.
4. **Overlay is shown during playback in v1, when the user enables it.** It gives hover a target. The cost is
   that ASS styling and positioning are replaced by a plain line. Off by default per user, so normal viewing is
   unaffected.
5. **Segment with greedy longest match, but never across a hiragana/katakana boundary.** Yomitan folds katakana
   to kana, so plain greedy gives `はコー/ヒー` for はコーヒー. Results on 12 test sentences:

   | Strategy | 彼女はケーキを… | 行きませんでした | Verdict |
   | --- | --- | --- | --- |
   | Plain greedy | `はケ/ー/キ` | one word | Breaks loanwords |
   | ICU `Intl.Segmenter` | `は/ケーキ` | `行き/ま/せん/で/した` | Shreds conjugations, Chrome 87+ only |
   | **Greedy + boundary** | `は/ケーキ` | one word | **No broken words on all 12** |

   Twelve sentences is a small sample, so Phase 3 should run it on real subtitle files.

   **Phase 3 result:** it did not hold up. With a names dictionary loaded, about a quarter of 70 lines came out wrong,
   as in `君/のこ/となん/て`. The boundary rule stays, but the choice between candidates is now a cheapest-path search
   with costs for weak evidence. See [docs/client.md](docs/client.md#segmentation).
6. **Reuse Yomitan's popup rendering.** `DisplayGenerator` and `StructuredContentGenerator` bundle cleanly to
   49 KB with no extension modules. JMdict glossaries are `structured-content`, so a hand-written renderer would
   be wrong for most dictionaries.
7. **GPL-3.0 for the whole project.** Yomitan is GPL-3.0-or-later and `Jellyfin.Controller` is GPL-3.0-only. Pin Yomitan
   as a git submodule at a release tag. Do not ship dictionaries, since users upload their own.

### Remote control flow

1. Enter pauses, and Jellyfin shows the OSD (unchanged).
2. Left, Right or Up enters word mode, hides the OSD, and highlights the first word with its popup.
3. Left and Right move between words.
4. Up and Down scroll the popup. *(The spike used Down to exit. This is a planned change, needed because TV
   users have no other way to read long entries.)*
5. Back leaves word mode and stays paused. Enter resumes.

Keys are only claimed while paused, so normal playback controls are untouched. While paused, this takes
Left/Right away from OSD button navigation. A per-user setting can limit entry to Up only.

## Plan

Each phase ends with something testable. Automated tests use Playwright against a podman Jellyfin with
generated media, as the spike did.

### Phase 1: Plugin skeleton and injection

- Repo layout: `src/` for C#, `client/` for JS, `third_party/yomitan` submodule, `tests/`.
- `compose.yaml` and a build script using the .NET SDK and Jellyfin images, so nothing needs installing locally.
- Injection that wraps the downstream response rather than replacing it, handles compressed responses, and
  respects `BaseUrl`.
- Confirm it coexists with File Transformation and Jellyfin Enhanced.
- Reference the host's `Microsoft.Data.Sqlite` with `ExcludeAssets="runtime"`. The build flagged NU1903 on the
  compile-time `SQLitePCLRaw` package, so check which version the host actually ships.

**Exit:** a fresh container plus the plugin loads the client script, including with a `BaseUrl` set and with
File Transformation installed.

### Phase 2: Dictionary backend

- Importer as a background job with progress, replacing the spike's request-blocking import.
- Full bank support: terms, term meta (frequency, pitch), kanji, kanji meta, tags, and media. The spike skipped
  kanji banks and media.
- Validate `index.json` and the format version, and cap decompressed size.
- Query API matching what `Translator` calls: `findTermsBulk`, `findTermMetaBulk`, `findTagMetaBulk`,
  `findKanjiBulk`, `findKanjiMetaBulk`, `findTermsBySequenceBulk`, `findTermsExactBulk`, `getDictionaryInfo`.
  Also handle the non-exact match types.
- Authorization: upload and delete require `RequiresElevation`, queries require any signed-in user. Test that
  non-admins get 403, which the spike did not check.

**Exit:** the top Yomitan dictionaries import, and engine results match the real extension on a fixed word list.

### Phase 3: Engine and subtitle pipeline

- Build the client with esbuild from the submodule. Replace the spike's stubs for `kanji-processor` and
  `hangul-js` with the real libraries.
- Trim the bundle to Japanese. Target current browsers and Android System WebView, so no old-engine polyfills.
- Subtitle source covering cases the spike did not:
  - switching subtitle tracks mid-playback
  - next episode, and two sessions on one `deviceId`
  - the user's subtitle offset setting
  - secondary subtitles
- ASS cleanup: strip override tags and `\N`, drop `{\p1}` drawing commands, and handle overlapping events. The
  spike only took the first matching event, which is wrong for typeset signs.
- Reduce segmentation round trips: batch candidates in one request, cache per cue, and pre-segment the upcoming
  cue.

**Exit:** a real anime episode with ASS subtitles and an SRT film both segment correctly and stay in sync through
seeks, track switches and transcoding.

### Phase 4: Desktop and mobile interaction

- Port Yomitan's templates and CSS for the popup, and render `structured-content`.
- Hover and tap with correct close behaviour. In the spike, tapping elsewhere left the popup open.
- Check overlap between the overlay, popup and OSD at phone and desktop sizes, in both orientations.
- Clear hide/restore of native subtitles for all three render paths, including on stop and navigation.
- Test Firefox and WebKit through Playwright, and Android Chrome emulation. The Android app is not available here.

**Exit:** the desktop and mobile flows work in automated tests, and normal playback is unchanged when the feature
is off. Real phone and Android app checks are left for the user, listed in the README.

**Phase 4 result:** done, with these changes to the plan. The overlay moved out of the video's container to a layer on the
body, because jellyfin-web's page covers the container and nothing inside it can be hit. `enabled` defaults to on until
Phase 6 has a way to turn it on, against decision 4. See [docs/client.md](docs/client.md#using-a-word).

### Phase 5: Keyboard and remote navigation

The flow above, kept because it is already proven and also serves desktop keyboards. It applies in any
jellyfin-web layout. No real TV pass.

- Implement the flow, with a `.videoOsdBottom` visibility guard on the synthetic Escape.
- Popup scrolling with Up and Down.

**Exit:** Playwright covers the full flow in desktop and TV layouts.

**Phase 5 result:** done, with real keys in the TV layout at 1920x1080, and no physical remote. Beyond the flow above, a key
held down stays claimed until released, since the repeats of a Back would otherwise leave the player. A popup opened by the
pointer is where the cursor starts, and word mode makes its pause the user's. The popup's text scales up in the TV layout.
The cursor stops at the ends of the words on screen, and does not wrap. See
[docs/client.md](docs/client.md#the-keyboard-and-a-remote).

### Phase 6: Settings

- Admin dashboard page: upload, progress, list, delete, ordering.
- Per-user settings stored on the server, so they follow the user between desktop and phone: enable toggle,
  enabled dictionaries, font size, remote entry key (`upOnlyEntry`, already stored and honoured).
- Add an in-player toggle.

**Exit:** a non-admin user can change settings on one device and have them apply on another.

### Phase 7: Packaging

- Plugin repository `manifest.json`, so users add one URL.
- Release workflow building per Jellyfin ABI. The current server is net10.0, and 10.11 is net9.0.
- Scheduled CI against the latest Jellyfin image. The plugin depends on unofficial DOM: `video.htmlvideoplayer`,
  `.videoOsdBottom`, `.osdControls`, `.videoOsd-appBar`, `.videoSubtitlesInner`, `.libassjs-canvas`, `window.ApiClient`,
  `window.Events` and its `SHOW_VIDEO_OSD` event, `.page:not(.hide)`, `.dialogContainer .dialog.opened`, the `layout-tv`
  class, and Escape on the document hiding the OSD. Failures here are the early warning.
- README listing client support honestly, including the Android player setting.

## Not in scope for v1

- Android TV, Samsung Tizen and LG webOS TVs.
- PGS and VobSub. They are images with no text, and OCR is a separate project.
- Anki card creation. AnkiConnect does not fit a TV, and it can be added later.
- Audio pronunciation.
- Languages other than Japanese. The engine supports them, but the segmentation rule is Japanese-specific.
- Working with the Yomitan browser extension. The overlay is real text so it may work, but this is untested.

## Risks

| Risk | Impact | Mitigation |
| --- | --- | --- |
| jellyfin-web changes its DOM | Breakage on upgrade | Few selectors, scheduled CI |
| Lookups feel slow on a phone | Poor mobile experience | Batch and cache in Phase 3 |
| Plugin ABI is strict per Jellyfin version | Plugin unavailable after upgrades | Build matrix, fast releases |
| Dictionary storage on small servers | Hundreds of MB per dictionary set | Show size in settings, and document it |

## Prior art

- [File Transformation](https://github.com/IAmParadox27/jellyfin-plugin-file-transformation) and
  [JavaScript Injector](https://github.com/n00bcodr/Jellyfin-JavaScript-Injector): injection approaches.
- [Language Learning w/ Jellyfin](https://chromewebstore.google.com/detail/ecppeljgbopdhjbdfiklpppdkdmbgpca):
  a browser extension that makes subtitles selectable. It needs an extension, so it cannot help on a TV. No
  server plugin with its own popup was found.
- [Yomitan](https://github.com/yomidevs/yomitan), [jmdict-yomitan](https://github.com/yomidevs/jmdict-yomitan).
- Client sources read: [jellyfin-web](https://github.com/jellyfin/jellyfin-web),
  [jellyfin-webos](https://github.com/jellyfin/jellyfin-webos),
  [jellyfin-tizen](https://github.com/jellyfin/jellyfin-tizen),
  [jellyfin-android](https://github.com/jellyfin/jellyfin-android),
  [jellyfin-androidtv](https://github.com/jellyfin/jellyfin-androidtv),
  [jellyfin-desktop](https://github.com/jellyfin/jellyfin-desktop).
- [Apps2Samsung](https://github.com/Apps2Samsung/Apps2Samsung): Tizen sideloading.
- [Jellyfin forum discussion](https://forum.jellyfin.org/t-why-are-the-android-tv-and-webos-apps-so-different?pid=16606)
  on why the TV apps differ.
