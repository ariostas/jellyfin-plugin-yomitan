# Jellyfin Yomitan

A Jellyfin plugin that lets you look up words in Japanese subtitles with [Yomitan](https://github.com/yomidevs/yomitan)'s
dictionaries, right in Jellyfin's web player.

While a video plays with Japanese subtitles, the plugin draws the line itself, split into words. Hover a word, or tap it
on a phone, and the video pauses and Yomitan's popup shows that word. Move away, or tap elsewhere, and it resumes. A
keyboard or a TV remote can walk the words of a paused line too.

The dictionaries live on the server: an admin uploads them once, and everyone on the server can use them from any browser,
with nothing to install on the device.

## Installing

It needs **Jellyfin 12.0 or later**.

1. In the dashboard, open **Plugins**, then **Manage Repositories**, and add a **New Repository**: any name, and this URL:

   ```text
   https://raw.githubusercontent.com/ariostas/jellyfin-plugin-yomitan/main/manifest.json
   ```

2. Back in **Plugins**, choose **Available**, open **Yomitan** and press **Install**.
3. Restart the server: **Dashboard**, **Restart**. Yomitan is now under **Installed**, and in the dashboard's menu.

New releases arrive through the same repository: Jellyfin's **Update Plugins** task installs them, and they take effect at
the next restart.

Without the repository, unzip a release's `yomitan_<version>.zip` from
[GitHub](https://github.com/ariostas/jellyfin-plugin-yomitan/releases) into a folder named `Yomitan_<version>` in the server's
`plugins` directory, and restart. A plugin installed this way does not update by itself.

## Setting it up

1. **An admin adds dictionaries**: Dashboard, Yomitan, in the Plugins section of the menu. A dictionary is a zip in
   Yomitan's format. None ship with the plugin, and Yomitan's [list of dictionaries](https://yomitan.wiki/dictionaries/)
   says where to get them: [JMdict](https://github.com/yomidevs/jmdict-yomitan/releases/latest) or
   [Jitendex](https://jitendex.org) for words, JMnedict for names and KANJIDIC for kanji, and frequency and pitch
   dictionaries on top. Everyone on the server shares them. They take room: JMdict and JMnedict together are about 300 MB
   on disk, and the page shows the total.
2. **Each user turns it on.** It is off by default, because it replaces styled subtitles with a plain line. During playback
   of a Japanese text subtitle track, the 文A button next to the subtitle button in the player turns it on and off at once.
   The first time someone plays one with it off, a notice says so, once.
3. **Each user chooses the rest** under their picture, Settings, Yomitan: which dictionaries to use and in what order, the
   size of the lines, the keys, and the hover delay. It follows them to every device, by the next time a video starts there.

## Using it

**With a mouse**, rest the pointer on a word for a moment: the video pauses and the popup opens. Move to another word to
see it instead, or away from the line to close the popup and resume. Crossing the line on the way somewhere else does
nothing. If you paused the video yourself, it stays paused.

**On a touch screen**, tap a word to pause and open its popup, tap another word to switch, and tap anywhere else to close
it and resume.

**With a keyboard or a remote**, pause first, with Enter or OK. Then:

| Key | What it does |
| --- | --- |
| Up | Hides the player controls and marks a word of the line, with its popup. In the TV layout, Left and Right do too |
| Left, Right | Move to the previous or next word |
| Up, Down | Scroll a long popup |
| Back or Escape | Leaves the words, and stays paused in the player |
| Enter or OK | Resumes |

Outside the TV layout, Left and Right stay the player's until Up has started, so they still go back and forward on a
paused video. **Only Up starts walking the words**, under Settings, Yomitan, is on there and off in the TV layout until
you change it, and then your choice holds everywhere.

## Which apps it works in

The plugin adds a script to the web interface that the server hosts, so it only works in apps that use that interface.

| App | Works? |
| --- | --- |
| Desktop browsers | Yes. Tested in Chromium, Firefox and WebKit. Safari itself has not been tried. |
| Phone browsers | Should work, but on an iPhone only while the video is not fullscreen. Tested only in a desktop browser pretending to be a phone. |
| Jellyfin Android app | Should work, but only with the web player: in the app's settings, under **Video player**, set **Video player type** to **Web player**. The default player is native, and the plugin cannot reach it. |
| jellyfin-web's TV layout, in a browser | Should work. Tested with key presses, not a real remote. |
| Android TV, Google TV, Fire TV | No, and no plugin can: the app is native and never loads the web interface. |
| Samsung Tizen, LG webOS | Not tried. Tizen brings its own copy of the web interface, which the plugin cannot reach. webOS loads the server's, but an older TV's browser may be older than the plugin needs, below. |
| Jellyfin Desktop, Swiftfin, iOS apps | Not tried. |

The browser has to be at least Chrome 103, Firefox 104 or Safari 16.4 (iOS 16.4). In an older one the plugin does not
work, though Jellyfin's own subtitles still show.

None of it has been tried yet on a real phone, in the Android app or on a TV. If you try one,
[an issue](https://github.com/ariostas/jellyfin-plugin-yomitan/issues) saying what worked and what did not helps a lot.
[CONTRIBUTING.md](CONTRIBUTING.md#checks-on-real-devices) lists what to look at.

## When it does not show up

- **No 文A button in the player.** The button only appears for a Japanese text subtitle track: one tagged Japanese, or an
  untagged one whose text is. Picture subtitles (PGS, VobSub) and subtitles burned into the video cannot be read. If no
  track gets the button, check that Yomitan is **Active** under Dashboard, Plugins.
- **The button is amber.** The feature is on, but something stops it. A notice says what when it starts, and so does the
  button's label, which shows when the mouse rests on it and which a screen reader reads: most often no dictionaries are
  installed, or you have turned them all off under Settings, Yomitan. Jellyfin's own subtitles show in the meantime.
- **Nothing happens in the Android app.** Set the app's video player to **Web player**, as above.

## Known limits

- **Japanese only.** The plugin only takes over a Japanese subtitle track.
- **Word splitting is a guess.** It gets about 80% of lines of real subtitles exactly right, and 97% of the places words
  start and end. A wrong split only means a word shows as two, or with its neighbour.
- **The line is plain.** With the feature on, ASS styling, positions and effects are replaced by plain lines: dialogue at
  the bottom, signs at the top. That is why it is off until a user turns it on.
- **The primary subtitle track only.** A Japanese secondary track under another language is not used.
- **Not in an iPhone's fullscreen.** On an iPhone, the player plays the video inside the page, where the plugin works. Its
  fullscreen button hands the video to iOS's own player, which shows nothing of the page, so the line and the popup are
  not there. Until you leave it, the plugin gives the subtitles back to Jellyfin, as if it were off. On an iPad the
  player makes the whole page fullscreen instead, so it should work there. This is from jellyfin-web's code and MDN's
  notes on Safari, not from a real iPhone or iPad.
- **No Anki, no audio**, and nothing else from Yomitan's browser extension beyond the lookup and its popup.
- **Lookups need the server.** Each new line is one request, and a popup one more, so a slow connection to the server makes
  them slow too.
- **A Jellyfin update can break it.** The plugin relies on how the web interface is built, which Jellyfin does not promise
  to keep, so a new Jellyfin can break it until the plugin catches up. It is tested every week against the newest Jellyfin
  to see that early.

## Uninstalling

Uninstall it in the dashboard, under **Plugins**, and restart. That removes the plugin, but **not the dictionaries or
anyone's settings**, so installing it again later brings everything back. They stay in a `yomitan` folder in Jellyfin's
data directory:

| Jellyfin install | Folder |
| --- | --- |
| Official Docker image | `/config/data/yomitan` |
| Linux packages | `/var/lib/jellyfin/data/yomitan` |
| Windows | `%ProgramData%\Jellyfin\Server\data\yomitan` |

To remove them too, stop Jellyfin and delete that folder. With large dictionaries it can hold several hundred MB.

## Contributing

[CONTRIBUTING.md](CONTRIBUTING.md) covers building, running a test server, the tests and releases.
[PLAN.md](PLAN.md) has the design and its history, [docs/api.md](docs/api.md) the HTTP API, and
[docs/client.md](docs/client.md) the client.

## License

GPL-3.0. See [LICENSE](LICENSE), and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) for what the plugin bundles.
