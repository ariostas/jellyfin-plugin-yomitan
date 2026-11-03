# Jellyfin Yomitan

A Jellyfin plugin that adds [Yomitan](https://github.com/yomidevs/yomitan)-style dictionary lookups to subtitles
in jellyfin-web. No fork of Jellyfin is needed.

During playback of a Japanese subtitle track, the plugin can replace the line with its own, split into words, using
Yomitan's engine and dictionaries on the server. Hover a word, or tap it on a phone, and the video pauses and Yomitan's
popup shows that word. Move away, or tap elsewhere, and it resumes. While paused, a keyboard or a TV remote in jellyfin-web
can walk the words too: Left, Right or Up starts, Left and Right move, Up and Down scroll the popup, Back leaves and Enter
resumes. [PLAN.md](PLAN.md) has the design and its history, [docs/api.md](docs/api.md) is the HTTP contract, and
[docs/client.md](docs/client.md) describes the client.

## Installing

It needs **Jellyfin 12.0 or later**. One build serves them all. The whole suite passes on 12.4, the smoke set and every
playback spec on 12.0, and the smoke set on 12.1, 12.2 and 12.3. Every release runs the smoke set on 12.4 and the playback
specs on 12.0 first, and a weekly run tests the newest Jellyfin image. Jellyfin 10.11 and older are not supported: they
need another build, which has not been tested, and 10.11 has had no release since 12.0 came out.

1. In the dashboard, open **Plugins**, then **Manage Repositories**, and add a **New Repository**: any name, and this URL:

   ```text
   https://raw.githubusercontent.com/ariostas/jellyfin-plugin-yomitan/main/manifest.json
   ```

2. Back in **Plugins**, choose **Available**, open **Yomitan** and press **Install**.
3. Restart the server: **Dashboard**, **Restart**. Yomitan is now under **Installed**, and in the dashboard's menu.

New releases arrive through the same repository: Jellyfin's **Update Plugins** task installs them, and they take effect at
the next restart. The plugin's page under **Plugins** also lists every version, to install one by hand.

Without the repository, unzip a release's `yomitan_<version>.zip` from
[GitHub](https://github.com/ariostas/jellyfin-plugin-yomitan/releases) into a folder named `Yomitan_<version>` in the server's
`plugins` directory, and restart.

## Setting it up

1. **An admin adds dictionaries**: Dashboard, Yomitan, in the Plugins section of the menu. A dictionary is a zip in
   Yomitan's format. None ship with the plugin, and Yomitan's [list of dictionaries](https://yomitan.wiki/dictionaries/)
   says where to get them: [JMdict](https://github.com/yomidevs/jmdict-yomitan/releases/latest) or
   [Jitendex](https://jitendex.org) for words, JMnedict for names and KANJIDIC for kanji, and frequency and pitch
   dictionaries on top. Everyone on the server shares them. They take room: JMdict and JMnedict together are about 300 MB
   on disk, and the page shows the total.
2. **Each user turns it on.** It is off by default, because it replaces styled subtitles with a plain line. During playback
   of a Japanese text subtitle track, the 文A button next to the subtitle button in the player turns it on and off at once.
3. **Each user chooses the rest** under their picture, Settings, Yomitan: which dictionaries to use and in what order, the
   size of the lines, the keys, and the hover delay. It follows them to every device, by the next time a video starts there.

## Client support

The plugin works by injecting a script into the web UI that the server hosts, so only clients that load that UI can use
it.

| Client | Status |
| --- | --- |
| Desktop browsers | Supported. Tested with Playwright in Chromium, Firefox and WebKit on Linux. Playwright's WebKit is not Safari, and Safari itself is untested. |
| Mobile browsers | Expected to work. Tested only with Chromium emulating a Pixel 7 (touch, viewport and user agent), which is not a phone. See below. |
| Jellyfin Android app | Expected to work with **Video player type** set to **Web player**. Never run. The default player is native (ExoPlayer), which does not load jellyfin-web's player, so the plugin cannot do anything there. See below. |
| TV layout of jellyfin-web in a browser | Keys tested with Playwright at 1920x1080. No real TV or physical remote has been tried. |
| Android TV, Google TV, Fire TV | Not supported, and not possible with a plugin: the app is native Kotlin and never loads jellyfin-web. |
| Samsung Tizen, LG webOS | Not targeted. Tizen bundles its own copy of jellyfin-web, which the server cannot inject into. webOS loads the server's, so it may work, but it has not been tried. |
| Jellyfin Desktop, Swiftfin, iOS apps | Not tested. |

## Known limits

- **Japanese only.** The engine knows other languages, but the segmentation is built for Japanese, and the plugin only
  takes over a track tagged Japanese, or an untagged one whose text is.
- **Segmentation is a guess.** It got 24 of 28 unseen lines of real subtitles exactly right, about 86%. The misses are in
  `tests/fixtures/segmentation-corpus.mjs`. A wrong split only means a word shows as two, or with its neighbour.
- **The line is plain.** With the feature on, ASS styling, positions and effects are replaced by plain lines: dialogue at
  the bottom, signs at the top. That is why it is off until a user turns it on.
- **Text subtitles only.** PGS and VobSub are pictures, and burned-in subtitles are part of the video, so those play as
  they always do. The plugin uses the primary track only: a Japanese secondary track under another language is not used.
- **No Anki, no audio**, and nothing else from Yomitan's extension beyond the lookup and its popup.
- **Lookups need the server.** Each new line is one request, and a popup one more. On localhost a line takes 250 to
  360 ms, and that is not yet measured on real hardware or a mobile network.
- **The DOM of jellyfin-web is not an API.** The plugin depends on parts of it, listed in [PLAN.md](PLAN.md#phase-7-packaging),
  and a Jellyfin release can break it until the plugin catches up. The weekly CI against the newest image is there to see
  that first.

## What to check on a real phone

The automated tests emulate a phone in desktop Chromium: its touch input, viewport and user agent. None of that is a phone,
and the Android app has never been run. These checks are left for a person.

**In the Android app, first:** open the app's settings, and under **Video player**, set **Video player type** to **Web
player**. The default is the Integrated player, which is ExoPlayer: it does not load jellyfin-web's player, so the plugin
cannot do anything there. Subtitles will look normal, and no word will respond.

Then, in Android Chrome and again in the Android app, with a Japanese subtitle track, a dictionary installed and the
feature turned on with the button in the player:

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
14. The button next to the subtitle button in the player is easy to hit, and turns the feature on and off with the video
    going on.
15. Settings, Yomitan opens from your picture. The phone's Back button closes it and stays in Settings.

## What to check on a real TV

The automated tests press real keys in jellyfin-web's TV layout, at 1920x1080, in desktop browsers. jellyfin-web treats a
remote's buttons as the same key events, but no physical remote or real TV has been tried. Select **TV** under Settings,
Display, Display mode if the device does not choose it by itself, and with a Japanese subtitle track, a dictionary installed
and the feature on, on a TV browser that runs the web UI from the server:

1. Enter pauses and shows the OSD. Left, Right or Up then hides it and marks the first word of the line, with its popup.
2. The mark is easy to find and the popup easy to read from where you sit.
3. Left and Right move between words, and stop at the ends. Holding one down keeps going.
4. Up and Down scroll a long entry, and do nothing at its ends.
5. The remote's Back button leaves the words, stays paused and stays in the player, even when held for a moment. A second
   press does what Back always does there.
6. Enter on a word resumes, and nothing else happens.
7. With the OSD open, Left and Right reach the button next to the subtitle button, unless the video is paused, when they
   walk the words. OK turns the feature on and off.
8. Settings, Yomitan can be walked with the arrows, OK presses, and Back closes it.

## Development

You need Podman and Node.js 22. .NET and Jellyfin run in containers. Clone with `--recurse-submodules`.

```sh
scripts/build.sh       # client and plugin, into out/plugin, which is exactly what the release zip holds
scripts/package.sh     # out/plugin as out/release/yomitan_<version>.zip, and its MD5
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

The server image is pinned in `scripts/lib/common.sh`, and `JF_IMAGE` picks another. The oldest supported server is
`JellyfinVersion` in the csproj: the plugin is compiled against it, and the manifest offers it to that version and newer.
Keep `Microsoft.Data.Sqlite` there on the version that server ships, as the comment beside it says.

The client build fails if a bundle grows past its gzipped budget in `client/build.mjs`, or takes in an npm package that has
no notice in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Tests

```sh
scripts/test-unit.sh                # C# unit tests
node --test scripts/lib/*.test.mjs  # the manifest tooling
scripts/test-matrix.sh smoke        # the smoke set on a fresh server, about 2 minutes
scripts/test-matrix.sh              # everything, on fresh servers, with BaseUrl and File Transformation variants
```

`scripts/test-matrix.sh` takes scenario names, and its header lists them. With none it runs every spec in all four
Playwright projects on a plain server, and in Chromium the specs that depend on a `BaseUrl` or on File Transformation on
servers with those. `JF_MATRIX_BROWSERS` narrows the browsers. Three more are not in the default run: `smoke`, the specs
tagged `@smoke`, which CI runs on every push; `compat`, the smoke set and every playback spec, which is what proves a
server version, as in `JF_IMAGE=docker.io/jellyfin/jellyfin:12.0.20260908-012347 scripts/test-matrix.sh compat`; and
`catalogue`, which starts a server without the plugin, adds a repository in the dashboard, installs the plugin from the
catalogue and restarts, and with two zips in `YOMITAN_CATALOGUE_ZIPS` upgrades too.

The Playwright projects are `chromium`, `firefox`, `webkit` and `android-chrome`. The specs that use real input and real
playback run on all four, and the rest on Chromium, since they test the server. Install the browsers with
`npx playwright install chromium firefox webkit`. WebKit needs a few system libraries: `sudo npx playwright install-deps
webkit` installs them, and `scripts/webkit-deps.sh` puts them next to WebKit if you have no root. `android-chrome` is
Chromium with a phone's touch input, viewport and user agent, not a phone. Playwright's WebKit is not Safari either.

Every spec that plays video fails on an uncaught error in the page. `tests/lib/test.mjs` does that, and lists what it
excuses and why.

The tests turn the feature on through the real setting: `logIn()` in `tests/lib/jellyfin.mjs` saves the user's settings on
the server first, and `logIn(page, {settings: null})` leaves a new user as they are.

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

The same directory drives the dashboard page and the choice of dictionaries with real ones, in
`tests/e2e/admin-page.spec.mjs` and `tests/e2e/dictionary-choice.spec.mjs`. `YOMITAN_BIG_FILE` names a dictionary of over
500 MB for the former, which sends it and measures the page's memory. The same directory runs the segmenter's hand-checked
corpus. `tests/e2e/real-film.spec.mjs` takes real subtitle files and a real film, which are not in this repository either,
and its header lists what it needs:

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

## CI

The workflows in `.github/workflows` call the same scripts, so each job is one command here.

- **CI**, on every push and pull request: the hooks in `.pre-commit-config.yaml`, the manifest tooling, the build with its
  size and license checks, the unit tests, the zip, and the smoke set on the pinned server.
- **Scheduled**, weekly and by hand: every spec in each browser against the pinned image and `latest`, one job each, the
  BaseUrl and File Transformation variants against both, the compat set against 12.0, and the install from a repository
  against `latest`.
- **Release**, on a tag `v<version>`: all of CI, the zip, the install of that zip from a repository through the dashboard,
  as an upgrade from the newest release in the manifest, then the GitHub release, and last the new version in
  `manifest.json` on main. A failure anywhere stops it before anything is published, and the manifest tooling refuses to
  write a manifest that has lost or changed a version.

The real dictionaries are not downloaded in CI. Their licenses would allow it, but JMdict for Yomitan is rebuilt daily, so
a failure could come from the dictionary and not from Jellyfin, which is what the scheduled run is there to notice. The
specs that use them are measurements to read, not checks.

## Releasing

The version is in `VERSION` and nowhere else. A release is `MAJOR.MINOR.PATCH`, its tag is `v` and that, and Jellyfin
sees it with a fourth part, `.0`.

```sh
echo 0.2.0 > VERSION
git commit -am "chore: release 0.2.0"
git tag v0.2.0
git push origin main v0.2.0
```

The release workflow does the rest. It pushes `manifest.json` to main with the workflow's own token, so main must accept
pushes from GitHub Actions.

## License

GPL-3.0. See [LICENSE](LICENSE), and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for what the plugin bundles.
