# Jellyfin Yomitan

A Jellyfin plugin that adds [Yomitan](https://github.com/yomidevs/yomitan)-style dictionary lookups to subtitles
in jellyfin-web. No fork of Jellyfin is needed.

This is early work. During playback of a Japanese subtitle track, the plugin replaces the line with its own, split into
words, using Yomitan's engine and dictionaries on the server. There are no popups yet. [PLAN.md](PLAN.md) has the
roadmap, [docs/api.md](docs/api.md) is the HTTP contract, and [docs/client.md](docs/client.md) describes the client.

## Client support

The plugin works by injecting a script into the web UI that the server hosts, so only clients that load that UI
can use it.

| Client | Status |
| --- | --- |
| Desktop and mobile browsers | Supported. Tested in Chromium. |
| Jellyfin Android app | Expected to work with the web player selected. Not tested. |
| Android TV, Samsung Tizen, native apps | Not possible with a plugin. |

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

## License

GPL-3.0. See [LICENSE](LICENSE).
