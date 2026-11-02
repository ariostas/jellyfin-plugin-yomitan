# Third-party notices

The plugin is GPL-3.0, in [LICENSE](LICENSE). Its DLL carries the code below, in the scripts it serves to jellyfin-web and
in its resources. Nothing else is bundled: the server provides the .NET libraries the plugin uses, including
Microsoft.Data.Sqlite, and no dictionary ships with it.

## Yomitan

From [yomidevs/yomitan](https://github.com/yomidevs/yomitan) at tag 26.10.22.0, the `third_party/yomitan` submodule of the
plugin's repository, which is where the source of what is bundled is:

- the language, dictionary and display code under `ext/js`, in `engine.js`
- the display templates `ext/templates-display.html`, the stylesheets `ext/css/material.css`, `display.css`,
  `display-pronunciation.css` and `structured-content.css`, and the icons `ext/images/external-link.svg` and
  `material-right-arrow.svg`, in `engine.js`
- the dictionary schemas `ext/data/schemas/dictionary-*-schema.json`, in the DLL

```text
Copyright (C) 2023-2026  Yomitan Authors
Copyright (C) 2016-2022  Yomichan Authors

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <https://www.gnu.org/licenses/>.
```

## kanji-processor

[kanji-processor](https://www.npmjs.com/package/kanji-processor) 1.0.2, in `engine.js`. Its package names no license, and the
LICENSE file it ships is this one:

```text
MIT License

Copyright (c) 2024 Lyroxide

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`client/build.mjs` fails the build if a bundle takes in any other npm package, so a new one cannot ship without its notice
here.
