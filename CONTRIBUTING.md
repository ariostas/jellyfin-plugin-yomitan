# Contributing

How the plugin is built, run and tested, and how a release is made. [README.md](README.md) is for people using it.
[PLAN.md](PLAN.md) has the design and its history, [docs/api.md](docs/api.md) is the HTTP contract, and
[docs/client.md](docs/client.md) describes the client.

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
`JF_IMAGE=oldest` is the image of that version that the release and the weekly run test on, also in
`scripts/lib/common.sh`, and refuses to start if the two disagree. Keep `Microsoft.Data.Sqlite` in the csproj on the
version that server ships, as the comment beside it says.

The .NET SDK image is pinned by digest there too, since the compiler's version goes into the DLL: another SDK makes
another zip from the same commit. Move it to a newer SDK on purpose, in a commit of its own.

The client build fails if a bundle grows past its gzipped budget in `client/build.mjs`, or takes in an npm package that has
no notice in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

## Supported servers

One build serves Jellyfin 12.0 and later. The whole suite passes on 12.4, the smoke set and every playback spec on 12.0,
and the smoke set on 12.1, 12.2 and 12.3. Every release runs the smoke set on the pinned image and the playback specs on
12.0 first, and a weekly run tests the newest Jellyfin image. Jellyfin 10.11 and older are not supported: they need
another build, which has not been tested, and 10.11 has had no release since 12.0 came out.

The plugin depends on parts of jellyfin-web's DOM, which is not an API. [PLAN.md](PLAN.md#phase-7-packaging) lists them.

## Tests

```sh
scripts/test-unit.sh                # C# unit tests
node --test scripts/lib/*.test.mjs  # the manifest tooling
scripts/test-matrix.sh smoke        # the smoke set on a fresh server, about 2 minutes
scripts/test-matrix.sh              # everything, on fresh servers, with BaseUrl and File Transformation variants
```

`scripts/test-matrix.sh` takes scenario names, and its header lists them. With none it runs every spec in all four
Playwright projects on a plain server, and in Chromium the specs that depend on a `BaseUrl` or on File Transformation on
servers with those. `JF_MATRIX_BROWSERS` narrows the browsers. Four more are not in the default run: `smoke`, the specs
tagged `@smoke`, which CI runs on main and every pull request; `compat`, the smoke set and every playback spec, which is
what proves a server version, as in `JF_IMAGE=oldest scripts/test-matrix.sh compat`; `catalogue`, which starts a server
without the plugin, adds a repository in the dashboard, installs the plugin from the catalogue and restarts, and with
two zips in `YOMITAN_CATALOGUE_ZIPS` upgrades too; and `real`, the specs below that take real dictionaries.

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

### Real dictionaries and media

`tests/e2e/parity.spec.mjs` diffs the server against Yomitan's real importer, database and `Translator` in Chromium,
using the test data in the submodule. To run the same comparison on real dictionaries, point it at a directory holding
`JMdict_english.zip`, `JMnedict.zip` and `KANJIDIC_english.zip`, which are not in this repository.
`scripts/real-dicts.sh` downloads them from one dated release of [JMdict for
Yomitan](https://github.com/yomidevs/jmdict-yomitan) into `.dev/real-dicts` and checks their SHA-256, and
`scripts/test-matrix.sh real` does that and runs every spec below that takes them, in Chromium:

```sh
cd tests && YOMITAN_REAL_DICTS=$(../scripts/real-dicts.sh) npx playwright test e2e/parity-real.spec.mjs
```

The same directory drives the dashboard page and the choice of dictionaries with real ones, in
`tests/e2e/admin-page.spec.mjs` and `tests/e2e/dictionary-choice.spec.mjs`. `YOMITAN_BIG_FILE` names a dictionary of over
500 MB for the former, which sends it and measures the page's memory. The same directory runs the segmenter's hand-checked
corpus, whose misses are in `tests/fixtures/segmentation-corpus.mjs`. `tests/e2e/real-film.spec.mjs` takes real subtitle
files and a real film, which are not in this repository either, and its header lists what it needs:

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

## Checks on real devices

The automated tests emulate a phone in desktop Chromium, and press keys in jellyfin-web's TV layout in desktop browsers.
None of that is a phone or a TV, and the Android app has never been run. These checks are left for a person.

### On a phone

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

### On a TV

jellyfin-web treats a remote's buttons as the same key events the tests press, but no physical remote or real TV has been
tried. Select **TV** under Settings, Display, Display mode if the device does not choose it by itself, and with a Japanese
subtitle track, a dictionary installed and the feature on, on a TV browser that runs the web UI from the server:

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

## CI

The workflows in `.github/workflows` call the same scripts, so each job is one command here.

- **CI**, on every push to main and every pull request, and by hand on any branch: the hooks in
  `.pre-commit-config.yaml`, the manifest tooling, `manifest.json` against every commit of it, the build with its size
  and license checks, the unit tests, the zip, and the smoke set on the pinned server. A push to another branch runs
  nothing until it has a pull request.
- **Scheduled**, weekly and by hand: every spec in each browser against the pinned image and `latest`, one job each, the
  BaseUrl and File Transformation variants against both, the compat set against 12.0, the install from a repository
  against `latest`, and `scripts/test-matrix.sh real` with the dictionaries `scripts/real-dicts.sh` pins. GitHub turns a
  schedule off after 60 days with no commit, without telling anyone. A release refuses to publish while it is off, and
  warns when its last run did not pass this week. Turn it back on with `gh workflow enable scheduled.yml`.
- **Release**, on a tag `v<version>` whose commit is on main: all of CI, the compat set on the oldest server, the zip,
  the install of that zip from a repository through the dashboard, as an upgrade from the newest release in the
  manifest, then the GitHub release, and last the new version in `manifest.json` on main.

A failed test stops the release before anything is published. The publish job then works in this order, so that each
step only starts once everything before it holds:

1. A draft release with the zip, or the release that is already there. Its zip must be this run's, byte for byte, since
   the manifest takes its checksum from the zip on the release. A release with no zip, such as one made by hand, stops
   it.
2. The manifest commit, on main as it is: refused if `manifest.json` has lost or changed a version that any commit of it
   had. This is the check CI makes, since the workflow's token pushes a commit that starts no workflow.
3. The release goes public, and the zip is downloaded from the URL the manifest gives and compared once more.
4. The push to main, made again on top of main if main moved.

Only the push can fail after the release is public. Then the release is out but the repository does not offer it, and
running the failed jobs again finishes it with the same zip. A whole new run builds the zip again, which only works
because the build is reproducible: if it is not, step 1 stops it and says so.

## Releasing

The version is in `VERSION` and nowhere else. A release is `MAJOR.MINOR.PATCH`, its tag is `v` and that, and Jellyfin
sees it with a fourth part, `.0`.

```sh
echo 0.2.0 > VERSION
git commit -am "chore: release 0.2.0"
git tag v0.2.0
git push --atomic origin main v0.2.0
```

`--atomic` pushes both or neither, and the release refuses a tag whose commit is not on main. The release workflow does
the rest. It pushes `manifest.json` to main with the workflow's own token, so main must accept pushes from GitHub
Actions. Push one release tag at a time: releases run one after another, and GitHub keeps only one waiting, so a third
tag pushed while one runs and another waits cancels the waiting one, which then has to be run again by hand.
