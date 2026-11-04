# AGENTS.md

Notes for coding agents working in this repository. [CONTRIBUTING.md](CONTRIBUTING.md) is the full guide for building,
testing and releasing, and [README.md](README.md) is for users. Read [PLAN.md](PLAN.md) for the design and why it is the
way it is, [docs/api.md](docs/api.md) for the HTTP contract and [docs/client.md](docs/client.md) for the client.

## What this is

A Jellyfin plugin, with no fork of Jellyfin: a C# server part and a JavaScript client injected into jellyfin-web.

- `src/Jellyfin.Plugin.Yomitan/`: the server, for .NET 10 and Jellyfin 12.0 and later. It imports Yomitan dictionaries into
  SQLite under `{DataPath}/yomitan/`, answers the client's batched lookups at `POST /Yomitan/Query`, keeps each user's
  settings, and injects the client's script tag into jellyfin-web's `index.html`.
- `client/src/`: the client, bundled by `client/build.mjs` with esbuild. A small loader, `client.js`, runs on every page,
  and the engine, `engine.js`, loads only once a video starts. It uses Yomitan's own code for lookups and its popup.
- `third_party/yomitan/`: Yomitan, as a git submodule pinned to a release. Do not edit it.
- `tests/unit/`: C# unit tests. `tests/e2e/`: Playwright specs against a real Jellyfin in Podman. `tests/lib/`: their
  helpers.
- `scripts/`: everything is run through these, locally and in CI.

## Commands

You need Podman and Node.js 22. .NET runs in a container.

```sh
prek -a --quiet                      # lint: the hooks in .pre-commit-config.yaml
scripts/build.sh                     # client and plugin into out/plugin. Run it again after any change
scripts/test-unit.sh                 # C# unit tests, seconds
node --test scripts/lib/*.test.mjs   # manifest tooling
scripts/test-matrix.sh smoke         # the @smoke specs on a fresh server, about 2 minutes
scripts/dev.sh up                    # a server at http://127.0.0.1:18096/web/, spike / spike
```

To run a few specs, start a server and run Playwright against it with the same `JF_*` variables:

```sh
JF_NAME=jf-mine JF_PORT=18150 scripts/dev.sh up
cd tests && JF_NAME=jf-mine JF_PORT=18150 npx playwright test --project=chromium playback.spec.mjs
```

Pick your own `JF_NAME` and `JF_PORT` so you do not take over a server someone else is using, and `scripts/dev.sh reset`
with the same variables when done.

## Testing

- The end-to-end specs are slow: real playback, a browser and a login per test, one worker, since tests share a server.
  The full `scripts/test-matrix.sh` takes hours. Run the specs you touched and the smoke set, and leave the matrix for
  changes that need it. Run anything long in the background with its output in a log.
- `dev.sh up` installs `out/plugin` as it is, so build first, or you are testing the old code.
- The feature is off by default for each user. `logIn()` in `tests/lib/jellyfin.mjs` turns it on through the real setting.
- Every spec that plays video fails on an uncaught page error. `IGNORED_PAGE_ERRORS` in `tests/lib/test.mjs` lists the
  errors that are jellyfin-web's own. Add one only after reproducing it with the plugin blocked, and say so beside it.
- Before calling a failure the plugin's, check whether jellyfin-web does the same with the plugin off. Several have been
  jellyfin-web's own.
- Headless WebKit sometimes dies while opening a page, with or without the plugin, so its project retries twice.

## Things that are easy to break

- **jellyfin-web's DOM is not an API.** The client depends on selectors, events and globals listed in
  [PLAN.md](PLAN.md#phase-7-packaging). Keep that list current when adding a dependency, and fail safe when one is
  missing: no overlay, and Jellyfin's own subtitles showing.
- **Failing safe.** Any error in a playback session must leave Jellyfin's own subtitles showing and the video as the user
  left it. `PlaybackSession._fail()` in `client/src/playback/session.js` is where that happens.
- **Dictionaries are hostile input.** Titles and content go on screen as text only, and the popup sanitizes what
  dictionaries render. `tests/e2e/hostile.spec.mjs` and `tests/unit/HostileArchiveTests.cs` cover it.
- **Bundle size and licenses.** `client/build.mjs` fails when a bundle passes its gzipped budget, or when it bundles an npm
  package with no entry in `THIRD-PARTY-NOTICES.md`.
- **`Microsoft.Data.Sqlite` stays on the version the oldest supported Jellyfin ships.** See the comment in the csproj. A
  newer one fails to load on 12.0.
- **The version is in `VERSION` only**, and `manifest.json` is written by the release workflow through
  `scripts/lib/manifest.mjs`. Do not edit it by hand: CI refuses a manifest that lost or changed a version any commit of
  it had.
- **A release must rebuild its zip byte for byte**, so the .NET SDK image in `scripts/lib/common.sh` is pinned by
  digest, and the oldest server image is there too, as `JF_IMAGE=oldest`. Change them on purpose, not in passing.

## Conventions

- Match the code around you: its naming, its idioms and how much it comments. Comments say why, in plain sentences.
- Keep `docs/api.md` and `docs/client.md` in step with the code they describe. `tests/e2e/contract.spec.mjs` checks the
  API against `docs/api.md`.
- Commits follow [Conventional Commits](https://www.conventionalcommits.org). AI-assisted commits end with an
  `Assisted-by: <harness>:<model>` trailer.
