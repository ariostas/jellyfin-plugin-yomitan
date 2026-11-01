# Jellyfin Yomitan

A Jellyfin plugin that adds [Yomitan](https://github.com/yomidevs/yomitan)-style dictionary lookups to subtitles
in jellyfin-web. No fork of Jellyfin is needed.

This is early work. During playback of a Japanese subtitle track, the plugin replaces the line with its own, split into
words, using Yomitan's engine and dictionaries on the server. Hover a word, or tap it on a phone, and the video pauses and
Yomitan's popup shows that word. Move away, or tap elsewhere, and it resumes. There is no settings page or dictionary
upload UI yet. [PLAN.md](PLAN.md) has the roadmap, [docs/api.md](docs/api.md) is the HTTP contract, and
[docs/client.md](docs/client.md) describes the client.

## Client support

The plugin works by injecting a script into the web UI that the server hosts, so only clients that load that UI
can use it.

| Client | Status |
| --- | --- |
| Desktop browsers | Supported. Tested in Chromium and Firefox, and in Playwright's WebKit on Linux, which is not Safari. |
| Mobile browsers | Expected to work. Tested with Android Chrome emulation only, which is not a phone. See below. |
| Jellyfin Android app | Expected to work with the web player selected. Not tested. See below. |
| Android TV, Samsung Tizen, native apps | Not possible with a plugin. |

## What to check on a real phone

The automated tests emulate a phone in desktop Chromium: its touch input, viewport and user agent. None of that is a phone,
and the Android app has never been run. These checks are left for a person.

**In the Android app, first:** open the app's settings, and under **Video player**, set **Video player type** to **Web
player**. The default is the Integrated player, which is ExoPlayer: it does not load jellyfin-web's player, so the plugin
cannot do anything there. Subtitles will look normal, and no word will respond.

Then, in Android Chrome and again in the Android app, with a Japanese subtitle track and a dictionary installed:

1. The line is split into words, and Jellyfin's own line is gone. Try an SRT and an ASS file.
2. Tapping a word pauses and shows the popup, within about a third of a second on your network.
3. Tapping another word swaps it. Tapping elsewhere closes it and resumes, and neither shows the OSD or does anything else.
4. A popup that you paused the video for stays paused when closed.
5. A finger scrolls a long entry smoothly, the page behind it does not move, and the end of the scroll does not bounce into
   anything.
6. Pressing and holding a word opens no system menu or text selection handles.
7. Turn the phone with a popup open: it stays on screen, next to the word, in both orientations.
8. With a notch or a rounded screen, nothing is cut off, in both orientations.
9. Fullscreen works, and the popup shows inside it. In the app, the player is always fullscreen.
10. The OSD still works: tap to show it, and every button and the seek bar respond, with a line on screen.
11. Pressing the phone's Back button with a popup open behaves sensibly, and leaving the player leaves nothing behind.
12. Leave a popup open, lock the phone, come back: the video can still be resumed.
13. On mobile data, a lookup is still quick enough to use.

## Development

You need podman and Node.js 22. .NET and Jellyfin run in containers. Clone with `--recurse-submodules`.

```sh
scripts/build.sh       # client and plugin, into out/plugin
scripts/dev.sh up      # http://127.0.0.1:18096/web/, log in with spike / spike. Installs out/plugin as is
scripts/dev.sh logs
scripts/dev.sh down    # keeps state in .dev/
scripts/dev.sh reset   # removes it
```

`scripts/dev.sh` is configured with environment variables, which its header lists, so several servers can run
side by side:

```sh
JF_NAME=jf-other JF_PORT=18200 JF_BASE_URL=/jf JF_WITH_FT=1 scripts/dev.sh up
```

## Tests

```sh
scripts/test-unit.sh       # C# unit tests
scripts/test-matrix.sh     # Playwright against fresh servers, with BaseUrl and File Transformation variants
```

The Playwright projects are `chromium`, `firefox`, `webkit` and `android-chrome`. The specs that use real input and real
playback run on all four, and the rest on Chromium, since they test the server. The matrix runs all four on the plain
server and Chromium on the others. Install the browsers with `npx playwright install firefox webkit`. WebKit needs a few
system libraries: `sudo npx playwright install-deps webkit` installs them, and `scripts/webkit-deps.sh` puts them next to
WebKit if you have no root. `android-chrome` is Chromium with a phone's touch input, viewport and user agent, not a phone.
Playwright's WebKit is not Safari either.

Every spec that plays video fails on an uncaught error in the page. `tests/lib/test.mjs` does that, and lists what it
excuses and why.

To run Playwright against a server that is already up, pass it the same `JF_*` variables:

```sh
cd tests && npm ci && npx playwright test
```

`tests/e2e/parity.spec.mjs` diffs the server against Yomitan's real importer, database and `Translator` in Chromium,
using the test data in the submodule. To run the same comparison on real dictionaries, point it at a directory holding
`JMdict_english.zip`, `JMnedict.zip` and `KANJIDIC_english.zip`, which are not in this repository:

```sh
cd tests && YOMITAN_REAL_DICTS=/path/to/dicts npx playwright test e2e/parity-real.spec.mjs
```

The same directory runs the segmenter's hand-checked corpus. `tests/e2e/real-film.spec.mjs` takes real subtitle files
and a real film, which are not in this repository either, and its header lists what it needs:

```sh
cd tests && YOMITAN_REAL_DICTS=/path/to/dicts npx playwright test e2e/segmentation-real.spec.mjs
```

`tests/e2e/popup-real.spec.mjs` also takes `ja_50k.txt` from
[FrequencyWords](https://github.com/hermitdave/FrequencyWords) and `accents.txt` from
[Kanjium](https://github.com/mifunetoshiro/kanjium), both CC BY-SA 4.0, if they are in that directory, and makes real
frequency and pitch dictionaries from them. `jitendex-yomitan.zip` from [Jitendex](https://jitendex.org), also CC BY-SA 4.0,
adds real images and a real stylesheet. It also measures how long a popup takes:

```sh
cd tests && YOMITAN_REAL_DICTS=/path/to/dicts npx playwright test --project=chromium e2e/popup-real.spec.mjs
```

## License

GPL-3.0. See [LICENSE](LICENSE).
