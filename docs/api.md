# HTTP API

The HTTP contract between the plugin and its clients. It covers dictionary management, the database that Yomitan's
`Translator` runs against, and each user's settings. The public scripts, `client.js`, `engine.js` and `settings-page.js`,
are in [client.md](client.md). `tests/e2e/contract.spec.mjs` replays every example here against a real server
and checks the limits, error codes, routes and operations below against the source, so this file cannot drift
without a test failing. To refresh the example responses after a deliberate change:

```sh
cd tests && YOMITAN_UPDATE_API_DOC=1 npx playwright test e2e/contract.spec.mjs
```

## Conventions

- Paths are relative to the server, including any `BaseUrl`. With `ApiClient`, use `ApiClient.getUrl('Yomitan/Query')`.
- Requests authenticate like any Jellyfin API call, for example with
  `Authorization: MediaBrowser Client="...", Device="...", DeviceId="...", Version="...", Token="..."`.
- Bodies are UTF-8 JSON unless noted. Strings hold raw Japanese, not `\u` escapes.
- Errors from the plugin have one shape. `401` and `403` come from Jellyfin and have no body.

  ```json
  {"error": {"code": "not_found", "message": "No such image"}}
  ```

  `code` is stable and listed under [Error codes](#error-codes). `message` is for people and can change. A `500` is
  plain text from Jellyfin, and means something is wrong on the server, such as a damaged database. Jellyfin itself and
  the rest of the plugin keep working then, and the server log has the cause.

### Who can call what

| Request | Anonymous | Signed-in user | Admin |
| --- | --- | --- | --- |
| `POST /Yomitan/Dictionaries` | 401 | 403 | Yes |
| `DELETE /Yomitan/Dictionaries` | 401 | 403 | Yes |
| `GET /Yomitan/Dictionaries` | 401 | Yes | Yes |
| `GET /Yomitan/Jobs/{id}` | 401 | Yes | Yes |
| `POST /Yomitan/Query` | 401 | Yes | Yes |
| `GET /Yomitan/Media` | 401 | Yes | Yes |
| `GET /Yomitan/Settings` | 401 | Their own | Their own |
| `PUT /Yomitan/Settings` | 401 | Their own | Their own |

The dashboard page and its script, `/web/ConfigurationPage?name=yomitan` and `?name=yomitan-admin.js`, are served by
Jellyfin itself, to anyone: they hold no data, and everything they ask for goes through this API.

## Limits

One query request is bounded so that it cannot do unbounded work:

| Limit | Value | When exceeded |
| --- | --- | --- |
| `MaxRequestBytes` | 4194304 | 413 `limit_exceeded` |
| `MaxOperations` | 64 | 400 `too_many_operations` |
| `MaxItems` | 4096 lookups across all operations | 400 `too_many_items` |
| `MaxDictionaries` | 256 titles in one operation | 400 `too_many_dictionaries` |
| `MaxRows` | 20000 rows across all operations | Results cut short, `truncated: true` |
| `MaxResponseBytes` | 33554432, counted on everything written, the first `getDictionaryInfo` included | Results cut short, `truncated: true` |
| `MaxDurationMs` | 5000, including a statement that is running | Results cut short, `truncated: true` |

The first `getDictionaryInfo` of a request always answers in full, whatever the budget, and what it writes counts against
`MaxResponseBytes` like anything else. A second one in the same request only answers if it fits. Rows stop being read,
as well as written, once the budget is spent, so a key with thousands of large glossaries costs no more than the
budget.

Imports are bounded by these defaults. An admin can change them in the plugin's XML configuration, under the same
names:

| Limit | Default | Meaning |
| --- | --- | --- |
| `MaxUploadBytes` | 4294967296 | Largest upload |
| `MaxDecompressedBytes` | 8589934592 | Most decompressed from one archive |
| `MaxEntries` | 200000 | Most entries in one archive |
| `MaxBankBytes` | 268435456 | Largest decompressed bank file |
| `MaxMediaBytes` | 33554432 | Largest decompressed image |
| `MaxMetadataBytes` | 4194304 | Largest decompressed `index.json` or `styles.css` |

At most 8 jobs can be pending at once, counting uploads still arriving. Beyond that a request gets 429 `queue_full`.
The most recent 64 finished jobs are kept.

## Examples

The examples run in the order written here, against this dictionary:

| File | Content |
| --- | --- |
| `index.json` | `{"title":"Example","format":3,"revision":"2026.01","sequenced":true,"frequencyMode":"rank-based"}` |
| `term_bank_1.json` | 食べる with reading たべる, and かな with no separate reading |
| `term_meta_bank_1.json` | A frequency and a pitch accent for 食べる |
| `kanji_bank_1.json`, `kanji_meta_bank_1.json` | 食, with one frequency |
| `tag_bank_1.json` | The tags `v1` and `P` |
| `pic.png` | A 3 by 2 PNG, which 食べる's glossary shows |
| `styles.css` | One rule |

## Importing

### `POST /Yomitan/Dictionaries`

Admin only. The body is the zip file itself, not a form, and the `Content-Type` is ignored. The upload is spooled to
disk and the import runs in the background, so this returns as soon as the body has arrived.

| Query parameter | Default | Meaning |
| --- | --- | --- |
| `replace` | `false` | See below |

**Replacing is deliberate.** Titles are unique. With `replace=false`, importing a title that is already installed
fails with `already_exists`, which is what Yomitan does. With `replace=true` the old dictionary and the new one are
swapped in one transaction: readers see the old version until the commit, and if the import fails for any reason the
old version is untouched. The replacement gets new row ids and sorts last in `getDictionaryInfo`, exactly as a delete
and re-import would in Yomitan, so anything cached by `id` must be dropped when a dictionary's `importDate` changes.

Responds `202` with a [job](#job), and a `Location` header pointing at it. The job is usually already `running`.

<!-- example -->
```http request
POST /Yomitan/Dictionaries
Content-Type: application/zip

<example.zip>
```

```http response
HTTP/1.1 202 Accepted

{
  "id": "7d682cf1-60ff-4c1a-98f5-9722528df138",
  "kind": "import",
  "state": "queued",
  "title": null,
  "replace": false,
  "phase": null,
  "progress": {
    "fraction": 0,
    "bytesProcessed": 0,
    "bytesTotal": 0,
    "rows": 0
  },
  "result": null,
  "error": null,
  "createdAt": "2026-11-01T12:44:10.5968895+00:00",
  "startedAt": null,
  "finishedAt": null
}
```

A failed import changes nothing. Here, the same title again without `replace`:

<!-- example -->
```http request
POST /Yomitan/Dictionaries
Content-Type: application/zip

<example.zip>
```

```http response
HTTP/1.1 202 Accepted

{
  "id": "18479473-e806-4248-8b97-3e5772743ea8",
  "kind": "import",
  "state": "queued",
  "title": null,
  "replace": false,
  "phase": null,
  "progress": {
    "fraction": 0,
    "bytesProcessed": 0,
    "bytesTotal": 0,
    "rows": 0
  },
  "result": null,
  "error": null,
  "createdAt": "2026-11-01T12:44:10.7800838+00:00",
  "startedAt": null,
  "finishedAt": null
}
```

### `GET /Yomitan/Jobs/{id}`

Responds `200` with a job, or `404 not_found`. Jobs live in memory: after a server restart every job is gone, and a
running import has rolled back. Poll at a few hundred milliseconds. Polling is cheap.

<a id="job"></a>A job:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | The job's id |
| `kind` | string | `import` or `delete` |
| `state` | string | `queued`, `running`, `succeeded` or `failed` |
| `title` | string or null | The dictionary, once its index has been read |
| `replace` | boolean | The upload's `replace` |
| `phase` | string or null | The current step, one of `reading`, `replacing`, `terms`, `termMeta`, `kanji`, `kanjiMeta`, `tags`, `committing`, `compacting` |
| `progress.fraction` | number | 0 to 1, of the bank files' decompressed size. It sits at 1 through `committing` and `compacting` |
| `progress.bytesProcessed`, `progress.bytesTotal` | number | Decompressed bytes. Images count toward the first and not the second |
| `progress.rows` | number | Rows imported |
| `result` | object or null | On success: `title`, `revision`, `replaced`, `counts` as in a summary, and `sizeBytes` |
| `error` | object or null | On failure: `code` and `message` |
| `createdAt`, `startedAt`, `finishedAt` | string or null | ISO 8601 times |

The first example's job, finished:

<!-- example job=0 -->
```http request
GET /Yomitan/Jobs/{id}
```

```http response
HTTP/1.1 200 OK

{
  "id": "7d682cf1-60ff-4c1a-98f5-9722528df138",
  "kind": "import",
  "state": "succeeded",
  "title": "Example",
  "replace": false,
  "phase": "compacting",
  "progress": {
    "fraction": 1,
    "bytesProcessed": 691,
    "bytesTotal": 499,
    "rows": 8
  },
  "result": {
    "title": "Example",
    "revision": "2026.01",
    "replaced": false,
    "counts": {
      "terms": {
        "total": 2
      },
      "termMeta": {
        "total": 2,
        "freq": 1,
        "pitch": 1
      },
      "kanji": {
        "total": 1
      },
      "kanjiMeta": {
        "total": 1,
        "freq": 1
      },
      "tagMeta": {
        "total": 2
      },
      "media": {
        "total": 1
      }
    },
    "sizeBytes": 0
  },
  "error": null,
  "createdAt": "2026-11-01T12:44:10.5968895+00:00",
  "startedAt": "2026-11-01T12:44:10.5970279+00:00",
  "finishedAt": "2026-11-01T12:44:10.6978365+00:00"
}
```

The second example's job, which failed:

<!-- example job=1 -->
```http request
GET /Yomitan/Jobs/{id}
```

```http response
HTTP/1.1 200 OK

{
  "id": "18479473-e806-4248-8b97-3e5772743ea8",
  "kind": "import",
  "state": "failed",
  "title": "Example",
  "replace": false,
  "phase": "reading",
  "progress": {
    "fraction": 0,
    "bytesProcessed": 97,
    "bytesTotal": 0,
    "rows": 0
  },
  "result": null,
  "error": {
    "code": "already_exists",
    "message": "A dictionary titled \"Example\" is already installed"
  },
  "createdAt": "2026-11-01T12:44:10.7800838+00:00",
  "startedAt": "2026-11-01T12:44:10.7801596+00:00",
  "finishedAt": "2026-11-01T12:44:10.7833635+00:00"
}
```

### `GET /Yomitan/Dictionaries`

Lists the installed dictionaries in import order. `summary` is what `getDictionaryInfo` returns for that dictionary.
`sizeBytes` is the space it took in the database, indexes included, in whole 4 KB pages, so a tiny dictionary that
fits in existing pages shows 0. `databaseBytes` is the database file, and `freeBytes` is the part of it not in use.

<!-- example -->
```http request
GET /Yomitan/Dictionaries
```

```http response
HTTP/1.1 200 OK

{
  "dictionaries": [
    {
      "title": "Example",
      "sizeBytes": 0,
      "summary": {
        "title": "Example",
        "revision": "2026.01",
        "sequenced": true,
        "version": 3,
        "importDate": 1793537050607,
        "prefixWildcardsSupported": true,
        "counts": {
          "terms": {
            "total": 2
          },
          "termMeta": {
            "total": 2,
            "freq": 1,
            "pitch": 1
          },
          "kanji": {
            "total": 1
          },
          "kanjiMeta": {
            "total": 1,
            "freq": 1
          },
          "tagMeta": {
            "total": 2
          },
          "media": {
            "total": 1
          }
        },
        "styles": ".example { color: teal; }",
        "importSuccess": true,
        "frequencyMode": "rank-based"
      }
    }
  ],
  "databaseBytes": 86016,
  "freeBytes": 0
}
```

## Querying

### `POST /Yomitan/Query`

Runs a batch of operations in one read transaction, so every operation sees the same state of the database, even if
an import commits meanwhile. Put everything a lookup needs in one request. **The batch is the point of this endpoint:
a client should not make one request per database call when it can avoid it.**

The body is `{"operations": [...]}`. The response is `{"results": [...]}` with one entry per operation, in order:

| Field | Type | Meaning |
| --- | --- | --- |
| `rows` | array | What the `DictionaryDatabase` method of that name resolves to, as JSON |
| `truncated` | boolean | The request's budget ran out, so `rows` is incomplete |

If any operation is malformed the whole request fails with 400 and nothing runs. A title that is not installed is not
an error: it matches nothing, as in Yomitan. The same goes for an empty list. An empty string in a `prefix` or `suffix`
`findTermsBulk` is malformed, `invalid_request`: it would match every row.

Each operation names a method of Yomitan's `DictionaryDatabase` and takes that method's arguments. The `Translator`'s
calls map one to one:

| `Translator` calls | `op` | Other fields |
| --- | --- | --- |
| `findTermsBulk(termList, dictionaries, matchType)` | `findTermsBulk` | `termList`, `dictionaries`, `matchType` |
| `findTermsExactBulk(termList, dictionaries)` | `findTermsExactBulk` | `termList`, `dictionaries` |
| `findTermsBySequenceBulk(items)` | `findTermsBySequenceBulk` | `items` |
| `findTermMetaBulk(termList, dictionaries)` | `findTermMetaBulk` | `termList`, `dictionaries` |
| `findKanjiBulk(kanjiList, dictionaries)` | `findKanjiBulk` | `kanjiList`, `dictionaries` |
| `findKanjiMetaBulk(kanjiList, dictionaries)` | `findKanjiMetaBulk` | `kanjiList`, `dictionaries` |
| `findTagMetaBulk(items)` | `findTagMetaBulk` | `items` |
| `getDictionaryInfo()` | `getDictionaryInfo` | None |

The Translator passes `dictionaries` as a `Map` or `Set`. Send its keys as an array of titles.

What an adapter has to do besides the batching:

- **`findTagMetaBulk`'s `rows` line up with `items`, and a miss is `null`.** Yomitan's method returns `undefined`
  there, and the `Translator` tests for exactly that, so turn every `null` into `undefined`. Forgetting this crashes
  `_expandKanjiStats`. A row can lack any field but `name` and `dictionary` if it came from an old index's `tagMeta`.
- **`index` is the position in the list sent**, and the `Translator` uses it to attach rows to its own structures. If
  an adapter merges several `Translator` calls into one operation, or removes duplicates, it has to map `index` back.
  One operation per call needs no mapping.
- **`findTermsBulk` keeps only the first sighting of a row**, walking the list in order, trying the expression before
  the reading for each item. A row whose expression and reading both match comes back once, with
  `matchSource: "term"`. Merging two calls into one operation therefore changes the results. Keep them separate
  operations in the same request.
- **Rows come in Yomitan's order**: by item, then the expression index before the reading index, then by key, then by
  `id`. A `truncated` result is a subset of the full one, taken from the start of that order.
- **`truncated` is sticky.** Once the budget has run out, later operations answer with `truncated: true` and no rows.
  The first `getDictionaryInfo` still answers in full. On `truncated`, split the batch and retry, or accept partial
  results. A `prefix` or `suffix` match of a very short string is what usually gets here, since it can match most of a
  dictionary.

A batch of every operation:

<!-- example -->
```http request
POST /Yomitan/Query
Content-Type: application/json

{
  "operations": [
    {"op": "findTermsBulk", "termList": ["食べる", "たべる", "かな"], "dictionaries": ["Example"], "matchType": "exact"},
    {"op": "findTermsExactBulk", "termList": [{"term": "食べる", "reading": "たべる"}], "dictionaries": ["Example"]},
    {"op": "findTermsBySequenceBulk", "items": [{"query": 2, "dictionary": "Example"}]},
    {"op": "findTermMetaBulk", "termList": ["食べる"], "dictionaries": ["Example"]},
    {"op": "findKanjiBulk", "kanjiList": ["食"], "dictionaries": ["Example"]},
    {"op": "findKanjiMetaBulk", "kanjiList": ["食"], "dictionaries": ["Example"]},
    {"op": "findTagMetaBulk", "items": [{"query": "v1", "dictionary": "Example"}, {"query": "missing", "dictionary": "Example"}]},
    {"op": "getDictionaryInfo"}
  ]
}
```

```http response
HTTP/1.1 200 OK

{
  "results": [
    {
      "rows": [
        {
          "index": 0,
          "matchType": "exact",
          "matchSource": "term",
          "term": "食べる",
          "reading": "たべる",
          "definitionTags": [
            "v1"
          ],
          "termTags": [
            "P"
          ],
          "rules": [
            "v1"
          ],
          "definitions": [
            "to eat",
            {
              "type": "image",
              "path": "pic.png",
              "width": 3,
              "height": 2,
              "title": "A picture"
            },
            {
              "type": "structured-content",
              "content": {
                "tag": "div",
                "content": [
                  "to live on"
                ]
              }
            }
          ],
          "score": 100,
          "dictionary": "Example",
          "id": 1200156,
          "sequence": 1
        },
        {
          "index": 2,
          "matchType": "exact",
          "matchSource": "term",
          "term": "かな",
          "reading": "かな",
          "definitionTags": [],
          "termTags": [],
          "rules": [],
          "definitions": [
            "kana"
          ],
          "score": 0,
          "dictionary": "Example",
          "id": 1200157,
          "sequence": 2
        }
      ],
      "truncated": false
    },
    {
      "rows": [
        {
          "index": 0,
          "matchType": "exact",
          "matchSource": "term",
          "term": "食べる",
          "reading": "たべる",
          "definitionTags": [
            "v1"
          ],
          "termTags": [
            "P"
          ],
          "rules": [
            "v1"
          ],
          "definitions": [
            "to eat",
            {
              "type": "image",
              "path": "pic.png",
              "width": 3,
              "height": 2,
              "title": "A picture"
            },
            {
              "type": "structured-content",
              "content": {
                "tag": "div",
                "content": [
                  "to live on"
                ]
              }
            }
          ],
          "score": 100,
          "dictionary": "Example",
          "id": 1200156,
          "sequence": 1
        }
      ],
      "truncated": false
    },
    {
      "rows": [
        {
          "index": 0,
          "matchType": "exact",
          "matchSource": "sequence",
          "term": "かな",
          "reading": "かな",
          "definitionTags": [],
          "termTags": [],
          "rules": [],
          "definitions": [
            "kana"
          ],
          "score": 0,
          "dictionary": "Example",
          "id": 1200157,
          "sequence": 2
        }
      ],
      "truncated": false
    },
    {
      "rows": [
        {
          "index": 0,
          "term": "食べる",
          "mode": "freq",
          "data": 500,
          "dictionary": "Example"
        },
        {
          "index": 0,
          "term": "食べる",
          "mode": "pitch",
          "data": {
            "reading": "たべる",
            "pitches": [
              {
                "position": 2
              }
            ]
          },
          "dictionary": "Example"
        }
      ],
      "truncated": false
    },
    {
      "rows": [
        {
          "index": 0,
          "character": "食",
          "onyomi": [
            "ショク"
          ],
          "kunyomi": [
            "た.べる"
          ],
          "tags": [
            "jouyou"
          ],
          "definitions": [
            "eat",
            "food"
          ],
          "stats": {
            "strokes": "9"
          },
          "dictionary": "Example"
        }
      ],
      "truncated": false
    },
    {
      "rows": [
        {
          "index": 0,
          "character": "食",
          "mode": "freq",
          "data": 300,
          "dictionary": "Example"
        }
      ],
      "truncated": false
    },
    {
      "rows": [
        {
          "name": "v1",
          "category": "partOfSpeech",
          "order": 0,
          "notes": "ichidan verb",
          "score": 0,
          "dictionary": "Example"
        },
        null
      ],
      "truncated": false
    },
    {
      "rows": [
        {
          "title": "Example",
          "revision": "2026.01",
          "sequenced": true,
          "version": 3,
          "importDate": 1793537050607,
          "prefixWildcardsSupported": true,
          "counts": {
            "terms": {
              "total": 2
            },
            "termMeta": {
              "total": 2,
              "freq": 1,
              "pitch": 1
            },
            "kanji": {
              "total": 1
            },
            "kanjiMeta": {
              "total": 1,
              "freq": 1
            },
            "tagMeta": {
              "total": 2
            },
            "media": {
              "total": 1
            }
          },
          "styles": ".example { color: teal; }",
          "importSuccess": true,
          "frequencyMode": "rank-based"
        }
      ],
      "truncated": false
    }
  ]
}
```

#### `matchType`

`exact`, `prefix` or `suffix`. A row that matches a `prefix` or `suffix` search exactly still reports
`matchType: "exact"`, as in Yomitan. Suffix searches work on every dictionary: the plugin always builds the reversed
indexes, so `prefixWildcardsSupported` is always `true`.

<!-- example -->
```http request
POST /Yomitan/Query
Content-Type: application/json

{
  "operations": [
    {"op": "findTermsBulk", "termList": ["食"], "dictionaries": ["Example"], "matchType": "prefix"},
    {"op": "findTermsBulk", "termList": ["べる"], "dictionaries": ["Example"], "matchType": "suffix"}
  ]
}
```

```http response
HTTP/1.1 200 OK

{
  "results": [
    {
      "rows": [
        {
          "index": 0,
          "matchType": "prefix",
          "matchSource": "term",
          "term": "食べる",
          "reading": "たべる",
          "definitionTags": [
            "v1"
          ],
          "termTags": [
            "P"
          ],
          "rules": [
            "v1"
          ],
          "definitions": [
            "to eat",
            {
              "type": "image",
              "path": "pic.png",
              "width": 3,
              "height": 2,
              "title": "A picture"
            },
            {
              "type": "structured-content",
              "content": {
                "tag": "div",
                "content": [
                  "to live on"
                ]
              }
            }
          ],
          "score": 100,
          "dictionary": "Example",
          "id": 1200156,
          "sequence": 1
        }
      ],
      "truncated": false
    },
    {
      "rows": [
        {
          "index": 0,
          "matchType": "suffix",
          "matchSource": "term",
          "term": "食べる",
          "reading": "たべる",
          "definitionTags": [
            "v1"
          ],
          "termTags": [
            "P"
          ],
          "rules": [
            "v1"
          ],
          "definitions": [
            "to eat",
            {
              "type": "image",
              "path": "pic.png",
              "width": 3,
              "height": 2,
              "title": "A picture"
            },
            {
              "type": "structured-content",
              "content": {
                "tag": "div",
                "content": [
                  "to live on"
                ]
              }
            }
          ],
          "score": 100,
          "dictionary": "Example",
          "id": 1200156,
          "sequence": 1
        }
      ],
      "truncated": false
    }
  ]
}
```

A malformed request:

<!-- example -->
```http request
POST /Yomitan/Query
Content-Type: application/json

{"operations": [{"op": "dropTables"}]}
```

```http response
HTTP/1.1 400 Bad Request

{
  "error": {
    "code": "unknown_operation",
    "message": "Unknown operation \"dropTables\""
  }
}
```

## Media

### `GET /Yomitan/Media`

Gets an image from a dictionary. Glossaries refer to images by `path`, in `{"type": "image", ...}` definitions and in
structured content's `{"tag": "img", ...}`. Both carry the `width` and `height` in pixels.

| Query parameter | Meaning |
| --- | --- |
| `dictionary` | The title, from the row's `dictionary` |
| `path` | The `path` |

Responds with the file, `304` to a matching `If-None-Match`, `404 not_found`, `400 invalid_request` if either
parameter is missing, or `400 unsafe_path` for a path with `..`, a leading `/`, a backslash or a control character.

The request needs the `Authorization` header, so an `<img src>` cannot load this directly. Fetch it, make a `blob:` URL,
and put that in the `<img>`. Only images a glossary refers to are stored, as in Yomitan.

<!-- example -->
```http request
GET /Yomitan/Media?dictionary=Example&path=pic.png
```

```http response
HTTP/1.1 200 OK
Content-Type: image/png
Content-Disposition: inline
X-Content-Type-Options: nosniff
Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; sandbox
Cache-Control: private, max-age=86400
```

The `Content-Type` comes from the file's extension through Yomitan's table in `media-util.js`, not from the
dictionary. SVG is `image/svg+xml` with `Content-Disposition: attachment`.

**Dictionaries are untrusted input, and an SVG is a document that can run script.** A client must only ever show one
through `<img>`, which does not run it. It must not inline it, or use `<object>`, `<embed>` or `<iframe>`, and a `blob:`
URL of one must not be something a person can open, since it has the page's origin. The same caution applies to a
summary's `styles`, which is the dictionary's own CSS: it has to be scoped to the popup, and it can reach the network
through `url()`. Glossaries can too, through their `style` objects. See [client.md](client.md#untrusted-dictionaries)
for how the plugin's own client handles all of this.

<!-- example -->
```http request
GET /Yomitan/Media?dictionary=Example&path=..%2F..%2Fsecret
```

```http response
HTTP/1.1 400 Bad Request

{
  "error": {
    "code": "unsafe_path",
    "message": "That is not a valid media path"
  }
}
```

## Deleting

### `DELETE /Yomitan/Dictionaries`

Admin only. Takes the title in the `title` query parameter, because titles can contain slashes. Responds `202` with a
[job](#job), `404 not_found`, or `400 invalid_request` with no title. Deletes run through the same queue as imports, so one cannot interleave with an import
of the same dictionary. The removal is one transaction, and the disk space goes back to the system afterwards.

<!-- example -->
```http request
DELETE /Yomitan/Dictionaries?title=Example
```

```http response
HTTP/1.1 202 Accepted

{
  "id": "a84f26fc-0788-4e75-bb14-419df4db9275",
  "kind": "delete",
  "state": "queued",
  "title": "Example",
  "replace": false,
  "phase": null,
  "progress": {
    "fraction": 0,
    "bytesProcessed": 0,
    "bytesTotal": 0,
    "rows": 0
  },
  "result": null,
  "error": null,
  "createdAt": "2026-11-01T12:44:10.9957556+00:00",
  "startedAt": null,
  "finishedAt": null
}
```

## Settings

Each user's settings for the client, in a small database of their own, so that saving one never waits for an import. They
live in `yomitan/settings.db` in Jellyfin's data directory.

**Whose settings these are comes from the token and nothing else.** Neither request takes a user id in any form, so
nobody can name another user, and an admin cannot either. An API key belongs to no user, and gets 400 `no_user`.

| Setting | Type | Default | Allowed |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | |
| `hoverDelayMs` | integer | 200 | 0 to 5000 |
| `hoverGraceMs` | integer | 300 | 0 to 5000 |
| `upOnlyEntry` | boolean | `false` | |
| `fontScale` | integer | 100 | 50 to 300, in percent |
| `dictionaryOrder` | array of titles | `[]` | At most 256, each 1 to 4096 characters, no duplicates |
| `disabledDictionaries` | array of titles | `[]` | The same |

[client.md](client.md#settings) says what each one does. A title in a list does not have to be installed, since another
admin can delete a dictionary while someone's page is open. One that is not installed means nothing.

`MaxRequestBytes` for this API is 1048576, and past that the answer is 413 `limit_exceeded`.

### `GET /Yomitan/Settings`

Responds `200` with every setting and the `revision`. A user who has saved nothing has the defaults at revision 0, so the
feature starts off. It is never cached.

<!-- example -->
```http request
GET /Yomitan/Settings
```

```http response
HTTP/1.1 200 OK
Cache-Control: no-store

{
  "revision": 0,
  "settings": {
    "enabled": false,
    "hoverDelayMs": 200,
    "hoverGraceMs": 300,
    "upOnlyEntry": false,
    "fontScale": 100,
    "dictionaryOrder": [],
    "disabledDictionaries": []
  }
}
```

### `PUT /Yomitan/Settings`

Saves the settings the body names, and **leaves the others as they are**, in one transaction. So two devices that each
change a different setting both keep their change. The same setting changed twice keeps the last. Everything is checked
first: one bad value, or one name that is not on the list, refuses the whole request and saves nothing. Names are
case-sensitive, and a name twice is refused.

Responds `200` with every setting as saved. `revision` goes up by one with every save that names anything, so a client
can tell which of two answers is newer. An empty object saves nothing, and is the same as a `GET`.

<!-- example -->
```http request
PUT /Yomitan/Settings
Content-Type: application/json

{"enabled": true, "fontScale": 120, "disabledDictionaries": ["JMnedict"]}
```

```http response
HTTP/1.1 200 OK
Cache-Control: no-store

{
  "revision": 1,
  "settings": {
    "enabled": true,
    "hoverDelayMs": 200,
    "hoverGraceMs": 300,
    "upOnlyEntry": false,
    "fontScale": 120,
    "dictionaryOrder": [],
    "disabledDictionaries": [
      "JMnedict"
    ]
  }
}
```

A value out of bounds:

<!-- example -->
```http request
PUT /Yomitan/Settings
Content-Type: application/json

{"fontScale": 1000}
```

```http response
HTTP/1.1 400 Bad Request

{
  "error": {
    "code": "invalid_setting",
    "message": "fontScale must be a whole number from 50 to 300"
  }
}
```

A name that is not a setting:

<!-- example -->
```http request
PUT /Yomitan/Settings
Content-Type: application/json

{"userId": "someone else"}
```

```http response
HTTP/1.1 400 Bad Request

{
  "error": {
    "code": "unknown_setting",
    "message": "There is no setting called \"userId\""
  }
}
```

## Error codes

| Code | Status, or where it appears | Meaning |
| --- | --- | --- |
| `already_exists` | Job | That title is installed and `replace` is off |
| `cancelled` | Job | The server shut down during the job |
| `empty_upload` | 400 | The upload had no body |
| `incompatible` | Job | The dictionary's `minimumYomitanVersion` is newer than the pinned Yomitan |
| `internal` | Job | A bug or a full disk. The server log has the details |
| `invalid_archive` | Job | Not a readable zip, or two entries with one name |
| `invalid_bank` | Job | A bank or `styles.css` is malformed or breaks Yomitan's schema |
| `invalid_index` | Job | `index.json` is malformed, breaks the schema, or has an unsupported format version |
| `invalid_json` | 400 | The query body is not JSON |
| `invalid_media` | Job | A glossary's image is missing, of an unknown type, or cannot be read |
| `invalid_request` | 400 | The request has the wrong shape |
| `invalid_setting` | 400 | A setting's value has the wrong type or is out of bounds. See [Settings](#settings) |
| `limit_exceeded` | 413, Job | Over one of the [limits](#limits) |
| `missing_index` | Job | No `index.json` at the archive's root |
| `no_user` | 400 | The token belongs to no user, as an API key does, so it has no settings |
| `not_found` | 404, Job | No such dictionary, job or image |
| `queue_full` | 429 | Too many jobs are pending |
| `too_many_dictionaries` | 400 | See [limits](#limits) |
| `too_many_items` | 400 | See [limits](#limits) |
| `too_many_operations` | 400 | See [limits](#limits) |
| `unknown_operation` | 400 | No such `op` |
| `unknown_setting` | 400 | No setting has that name |
| `unsafe_path` | 400, Job | A zip entry, a glossary image or a media request used an unsafe path |
| `upload_failed` | 400 | The upload did not finish |

## Where this differs from Yomitan

The rows are Yomitan's. `tests/e2e/parity.spec.mjs` diffs them against the real thing. These differences are deliberate:

- **An import is all or nothing.** Yomitan keeps what it managed to import and reports the errors. Here any failure,
  including a bad image, fails the import and leaves no trace.
- **Unsafe or duplicate zip entry names refuse the archive**, even for files that would not be read. Yomitan ignores
  names it does not look up, and takes the last of two duplicates.
- **Image sizes come from file headers.** Yomitan decodes images in a page, and the server has no decoder, so a
  corrupt image whose header is fine imports here and fails there. JPEG's EXIF rotation is ignored, so a rotated
  photo reports its width and height swapped. TIFF is refused, which is also what Chromium's decoder does.
- **`prefixWildcardsSupported` is always `true`.** In Yomitan it is an option at import time.
- **A string with a lone surrogate matches nothing.** The `Translator` cuts text by UTF-16 unit, so half of an astral
  character reaches this API, and that is fine: it finds nothing, and `index` still lines up. That is what Yomitan does
  for an exact match. A `prefix` search for half a character would match in Yomitan, on the other half of the key, and
  does not here. Dictionaries containing lone surrogates are refused with `invalid_bank`.
- **A prefix search also matches past U+FFFF on the key's next character**, where IndexedDB's upper bound would stop.
  U+FFFF is a noncharacter, so this has no effect on real text.
- **A `prefix` or `suffix` search for an empty string is refused**, where Yomitan would return the whole dictionary.
  The `Translator` never asks for one: it only searches by prefix or suffix for a wildcard search, with `deinflect`
  off, and returns early when the text is empty.
- **Dictionaries with `v1` term banks follow the schema as written.** Its `maxItems` forbids any definitions, and this
  is true of Yomitan too, so format 1 rows carry no glossary in practice.

`getDictionaryCounts`, `findTagForTitle`, `getMedia` and `drawMedia` have no operation because the `Translator` does
not call them. Dictionary counts are in each summary, and images are served by [`GET /Yomitan/Media`](#get-yomitanmedia).
