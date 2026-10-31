using System.Buffers;
using System.Globalization;
using System.IO.Compression;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.Yomitan.Dictionaries;

/// <summary>
/// Imports a Yomitan dictionary archive. This is a port of ext/js/dictionary/dictionary-importer.js, and the
/// stored rows must stay what that code stores, because the Translator runs against them. It differs in that
/// everything happens in one transaction, so any failure leaves the database exactly as it was.
/// </summary>
public sealed partial class DictionaryImporter
{
    /// <summary>The Yomitan release this plugin pins, compared with a dictionary's minimumYomitanVersion.</summary>
    public const string YomitanVersion = "26.10.22.0";

    private const int RowsPerProgressUpdate = 1000;

    private static readonly JsonDocumentOptions JsonOptions = new() { MaxDepth = 256 };

    private static readonly JsonWriterOptions WriterOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        SkipValidation = true,
    };

    private readonly DictionaryStore _store;
    private readonly ImportLimits _limits;
    private readonly Action<ImportProgress> _onProgress;

    /// <summary>Initializes a new instance of the <see cref="DictionaryImporter"/> class.</summary>
    /// <param name="store">Where the dictionary goes.</param>
    /// <param name="limits">Bounds on the archive.</param>
    /// <param name="onProgress">Called as the import advances, on the importing thread.</param>
    public DictionaryImporter(DictionaryStore store, ImportLimits limits, Action<ImportProgress>? onProgress = null)
    {
        _store = store;
        _limits = limits;
        _onProgress = onProgress ?? (_ => { });
    }

    /// <summary>Imports an archive.</summary>
    /// <param name="archivePath">The spooled upload.</param>
    /// <param name="replace">Whether an existing dictionary of the same title is replaced rather than an error.</param>
    /// <param name="cancellationToken">Stops the import, rolling it back.</param>
    /// <returns>What was imported.</returns>
    /// <exception cref="ImportException">The archive was refused. Nothing was changed.</exception>
    public ImportResult Import(string archivePath, bool replace, CancellationToken cancellationToken = default)
    {
        using var file = new FileStream(archivePath, FileMode.Open, FileAccess.Read, FileShare.Read, 1 << 16, FileOptions.RandomAccess);
        if (file.Length > _limits.MaxUploadBytes)
        {
            throw new ImportException("limit_exceeded", $"The archive is larger than {_limits.MaxUploadBytes} bytes");
        }

        using var archive = new SafeArchive(file, _limits);
        var run = new Run(this, archive, cancellationToken);
        return run.Execute(replace);
    }

    [GeneratedRegex(@"^term_bank_(\d+)\.json$", RegexOptions.ECMAScript)]
    private static partial Regex TermBankName();

    [GeneratedRegex(@"^term_meta_bank_(\d+)\.json$", RegexOptions.ECMAScript)]
    private static partial Regex TermMetaBankName();

    [GeneratedRegex(@"^kanji_bank_(\d+)\.json$", RegexOptions.ECMAScript)]
    private static partial Regex KanjiBankName();

    [GeneratedRegex(@"^kanji_meta_bank_(\d+)\.json$", RegexOptions.ECMAScript)]
    private static partial Regex KanjiMetaBankName();

    [GeneratedRegex(@"^tag_bank_(\d+)\.json$", RegexOptions.ECMAScript)]
    private static partial Regex TagBankName();

    /// <summary>Port of dictionary-data-util.js compareRevisions: whether current is older than latest.</summary>
    private static bool IsOlderRevision(string current, string latest)
    {
        static bool IsSimple(string version) => version.Length > 0 && version.Split('.').All(part => part.Length > 0 && part.All(char.IsAsciiDigit));

        var currentParts = current.Split('.');
        var latestParts = latest.Split('.');
        if (!IsSimple(current) || !IsSimple(latest) || currentParts.Length != latestParts.Length)
        {
            return string.CompareOrdinal(current, latest) < 0;
        }

        for (var i = 0; i < currentParts.Length; i++)
        {
            var a = double.Parse(currentParts[i], CultureInfo.InvariantCulture);
            var b = double.Parse(latestParts[i], CultureInfo.InvariantCulture);
            if (a != b)
            {
                return a < b;
            }
        }

        return false;
    }

    private static bool IsHttpUrl(JsonNode? value)
        => value?.GetValueKind() == JsonValueKind.String
            && Uri.TryCreate(value.GetValue<string>(), UriKind.Absolute, out var url)
            && (url.Scheme == Uri.UriSchemeHttp || url.Scheme == Uri.UriSchemeHttps);

    private static byte[] Utf8(JsonElement element) => Encoding.UTF8.GetBytes(element.GetRawText());

    /// <summary>One import: the archive, the open transaction, and the prepared statements.</summary>
    private sealed class Run
    {
        private readonly DictionaryImporter _importer;
        private readonly SafeArchive _archive;
        private readonly ImportLimits _limits;
        private readonly CancellationToken _cancellationToken;
        private readonly Dictionary<string, Dictionary<string, long>> _counts = new(StringComparer.Ordinal)
        {
            ["terms"] = new(StringComparer.Ordinal) { ["total"] = 0 },
            ["termMeta"] = new(StringComparer.Ordinal) { ["total"] = 0 },
            ["kanji"] = new(StringComparer.Ordinal) { ["total"] = 0 },
            ["kanjiMeta"] = new(StringComparer.Ordinal) { ["total"] = 0 },
            ["tagMeta"] = new(StringComparer.Ordinal) { ["total"] = 0 },
            ["media"] = new(StringComparer.Ordinal) { ["total"] = 0 },
        };

        private readonly Dictionary<string, (int Width, int Height)> _media = new(StringComparer.Ordinal);
        private readonly ArrayBufferWriter<byte> _glossaryBuffer = new(16 * 1024);
        private readonly Utf8JsonWriter _glossary;

        private SqliteConnection _connection = null!;
        private SqliteTransaction _transaction = null!;
        private long _dictionaryId;
        private string _title = string.Empty;
        private SqliteCommand _insertTerm = null!;
        private SqliteCommand _insertTermMeta = null!;
        private SqliteCommand _insertKanji = null!;
        private SqliteCommand _insertKanjiMeta = null!;
        private SqliteCommand _insertTag = null!;
        private SqliteCommand _insertMedia = null!;
        private long _rows;
        private long _bytesTotal;
        private string _phase = "reading";
        private string _currentFile = string.Empty;

        public Run(DictionaryImporter importer, SafeArchive archive, CancellationToken cancellationToken)
        {
            _importer = importer;
            _archive = archive;
            _limits = importer._limits;
            _cancellationToken = cancellationToken;
            _glossary = new Utf8JsonWriter(_glossaryBuffer, WriterOptions);
        }

        public ImportResult Execute(bool replace)
        {
            Report();
            var index = ReadIndex(out var version);
            _title = index["title"]!.GetValue<string>();
            Report();

            var v1 = version == 1;
            var termSchema = JsonSchema.Load(v1 ? "dictionary-term-bank-v1" : "dictionary-term-bank-v3");
            var termMetaSchema = JsonSchema.Load("dictionary-term-meta-bank-v3");
            var kanjiSchema = JsonSchema.Load(v1 ? "dictionary-kanji-bank-v1" : "dictionary-kanji-bank-v3");
            var kanjiMetaSchema = JsonSchema.Load("dictionary-kanji-meta-bank-v3");
            var tagSchema = JsonSchema.Load("dictionary-tag-bank-v3");

            // Same file selection and archive order as Yomitan: ids are assigned in this order.
            var termFiles = Find(TermBankName());
            var termMetaFiles = Find(TermMetaBankName());
            var kanjiFiles = Find(KanjiBankName());
            var kanjiMetaFiles = Find(KanjiMetaBankName());
            var tagFiles = Find(TagBankName());
            _bytesTotal = termFiles.Concat(termMetaFiles).Concat(kanjiFiles).Concat(kanjiMetaFiles).Concat(tagFiles).Sum(e => e.Length);

            var existing = _importer._store.Exists(_title);
            if (existing && !replace)
            {
                throw new ImportException("already_exists", $"A dictionary titled {SafeArchive.Printable(_title)} is already installed");
            }

            using (_connection = _importer._store.OpenWriter())
            {
                using (_transaction = _connection.BeginTransaction())
                {
                    PrepareStatements();
                    var previous = DictionaryStore.FindId(_connection, _transaction, _title);
                    if (previous is { } previousId)
                    {
                        _phase = "replacing";
                        Report();
                        DictionaryStore.DeleteRows(_connection, _transaction, previousId);
                    }

                    var usedBefore = DictionaryStore.UsedBytes(_connection, _transaction);
                    var summary = CreateSummary(index, version);
                    InsertDictionary();

                    _phase = "terms";
                    foreach (var file in termFiles)
                    {
                        ImportBank(file, termSchema, v1 ? InsertTermV1 : InsertTermV3);
                    }

                    _phase = "termMeta";
                    foreach (var file in termMetaFiles)
                    {
                        ImportBank(file, termMetaSchema, InsertTermMeta);
                    }

                    _phase = "kanji";
                    foreach (var file in kanjiFiles)
                    {
                        ImportBank(file, kanjiSchema, v1 ? InsertKanjiV1 : InsertKanjiV3);
                    }

                    _phase = "kanjiMeta";
                    foreach (var file in kanjiMetaFiles)
                    {
                        ImportBank(file, kanjiMetaSchema, InsertKanjiMeta);
                    }

                    _phase = "tags";
                    foreach (var file in tagFiles)
                    {
                        ImportBank(file, tagSchema, InsertTag);

                        // As in Yomitan, the obsolete index tagMeta is added once per tag bank, so with no tag
                        // banks it is dropped.
                        InsertIndexTags(index);
                    }

                    summary["styles"] = ReadStyles();
                    summary["counts"] = CountsToJson();

                    _phase = "committing";
                    Report();
                    var size = DictionaryStore.UsedBytes(_connection, _transaction) - usedBefore;
                    UpdateDictionary(summary, size);
                    DisposeStatements();
                    _transaction.Commit();

                    _phase = "compacting";
                    Report();
                    DictionaryStore.Compact(_connection);

                    return new ImportResult(_title, index["revision"]!.GetValue<string>(), previous.HasValue, _counts, size);
                }
            }
        }

        private List<ZipArchiveEntry> Find(Regex pattern)
            => _archive.Entries.Where(entry => pattern.IsMatch(entry.FullName)).ToList();

        private void Report()
            => _importer._onProgress(new ImportProgress(_phase, _title.Length == 0 ? null : _title, _archive.BytesRead, _bytesTotal, _rows));

        /// <summary>Port of _readAndValidateIndex.</summary>
        private JsonObject ReadIndex(out int version)
        {
            var entry = _archive.Find("index.json");
            if (entry is null)
            {
                var nested = _archive.Entries.FirstOrDefault(e => e.FullName.EndsWith("/index.json", StringComparison.Ordinal));
                throw new ImportException(
                    "missing_index",
                    nested is null
                        ? "No dictionary index found in archive"
                        : $"Dictionary index found at {SafeArchive.Printable(nested.FullName)} when it must be in the archive's root directory");
            }

            using var document = ParseJson(entry, _limits.MaxMetadataBytes, "invalid_index");
            if (!JsonSchema.Load("dictionary-index").IsValid(document.RootElement))
            {
                throw new ImportException("invalid_index", "index.json does not match the dictionary index schema, or has an unsupported format version");
            }

            var root = document.RootElement;
            var hasFormat = root.TryGetProperty("format", out var format);
            version = (hasFormat ? format : root.GetProperty("version")).GetInt32();
            if (string.IsNullOrEmpty(root.GetProperty("title").GetString()) || string.IsNullOrEmpty(root.GetProperty("revision").GetString()))
            {
                throw new ImportException("invalid_index", "Unrecognized dictionary format: the title and revision must not be empty");
            }

            return JsonNode.Parse(root.GetRawText(), null, new JsonDocumentOptions { MaxDepth = 256 })!.AsObject();
        }

        /// <summary>Port of _createSummary. Counts and styles are filled in once they are known.</summary>
        private JsonObject CreateSummary(JsonObject index, int version)
        {
            var summary = new JsonObject
            {
                ["title"] = _title,
                ["revision"] = index["revision"]!.DeepClone(),
                ["sequenced"] = index["sequenced"]?.GetValueKind() == JsonValueKind.True,
                ["version"] = version,
                ["importDate"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["prefixWildcardsSupported"] = true,
                ["counts"] = CountsToJson(),
                ["styles"] = string.Empty,
                ["importSuccess"] = true,
            };

            if (index["minimumYomitanVersion"]?.GetValue<string>() is { } minimum)
            {
                if (IsOlderRevision(YomitanVersion, minimum))
                {
                    throw new ImportException("incompatible", $"Dictionary is incompatible with this version of Yomitan ({YomitanVersion}; minimum required: {minimum})");
                }

                summary["minimumYomitanVersion"] = minimum;
            }

            foreach (var key in new[] { "author", "url", "description", "attribution", "frequencyMode", "sourceLanguage", "targetLanguage" })
            {
                if (index[key]?.GetValueKind() == JsonValueKind.String)
                {
                    summary[key] = index[key]!.DeepClone();
                }
            }

            if (index["isUpdatable"] is { } updatable)
            {
                if (updatable.GetValueKind() != JsonValueKind.True || !IsHttpUrl(index["indexUrl"]) || !IsHttpUrl(index["downloadUrl"]))
                {
                    throw new ImportException("invalid_index", "Invalid index data for updatable dictionary");
                }

                summary["isUpdatable"] = true;
                summary["indexUrl"] = index["indexUrl"]!.DeepClone();
                summary["downloadUrl"] = index["downloadUrl"]!.DeepClone();
            }

            return summary;
        }

        private JsonObject CountsToJson()
        {
            var counts = new JsonObject();
            foreach (var (name, group) in _counts)
            {
                var values = new JsonObject();
                foreach (var (key, value) in group)
                {
                    values[key] = value;
                }

                counts[name] = values;
            }

            return counts;
        }

        private string ReadStyles()
        {
            var entry = _archive.Find("styles.css");
            if (entry is null)
            {
                return string.Empty;
            }

            var styles = new UTF8Encoding(false).GetString(_archive.ReadAllBytes(entry, _limits.MaxMetadataBytes)).TrimStart('﻿');
            if (styles.Length == 0)
            {
                throw new ImportException("invalid_bank", "No styles found: styles.css is empty");
            }

            return styles;
        }

        private JsonDocument ParseJson(ZipArchiveEntry entry, long maxBytes, string errorCode)
        {
            try
            {
                using var stream = _archive.Open(entry, maxBytes);
                return JsonDocument.Parse(stream, JsonOptions);
            }
            catch (JsonException e)
            {
                throw new ImportException(errorCode, $"{entry.FullName} is not valid JSON: {e.Message}");
            }
            catch (InvalidDataException e)
            {
                throw new ImportException("invalid_archive", $"Cannot read {entry.FullName}: {e.Message}");
            }
        }

        private void ImportBank(ZipArchiveEntry file, JsonSchema schema, Action<JsonElement> insert)
        {
            _cancellationToken.ThrowIfCancellationRequested();
            _currentFile = file.FullName;
            using var document = ParseJson(file, _limits.MaxBankBytes, "invalid_bank");
            var rows = document.RootElement;
            schema.ValidateBank(rows, file.FullName);

            try
            {
                foreach (var row in rows.EnumerateArray())
                {
                    insert(row);
                    if (++_rows % RowsPerProgressUpdate == 0)
                    {
                        _cancellationToken.ThrowIfCancellationRequested();
                        Report();
                    }
                }
            }
            catch (InvalidOperationException e)
            {
                // Valid JSON the runtime cannot decode to a string, such as a lone surrogate.
                throw new ImportException("invalid_bank", $"{_currentFile} has an unreadable value: {e.Message}");
            }

            Report();
        }

        private void PrepareStatements()
        {
            _insertTerm = Prepare(
                "INSERT INTO terms(dict_id, expression, reading, expression_reverse, reading_reverse, definition_tags, term_tags, rules, score, glossary, sequence) VALUES($d, $0, $1, $2, $3, $4, $5, $6, $7, $8, $9)",
                10);
            _insertTermMeta = Prepare("INSERT INTO term_meta(dict_id, expression, mode, data) VALUES($d, $0, $1, $2)", 3);
            _insertKanji = Prepare("INSERT INTO kanji(dict_id, character, onyomi, kunyomi, tags, meanings, stats) VALUES($d, $0, $1, $2, $3, $4, $5)", 6);
            _insertKanjiMeta = Prepare("INSERT INTO kanji_meta(dict_id, character, mode, data) VALUES($d, $0, $1, $2)", 3);
            _insertTag = Prepare("INSERT INTO tag_meta(dict_id, name, category, sort_order, notes, score) VALUES($d, $0, $1, $2, $3, $4)", 5);
            _insertMedia = Prepare("INSERT INTO media(dict_id, path, media_type, width, height, content) VALUES($d, $0, $1, $2, $3, $4)", 5);
        }

        private SqliteCommand Prepare(string sql, int parameterCount)
        {
            var command = _connection.CreateCommand();
            command.Transaction = _transaction;
            command.CommandText = sql;
            command.CommandTimeout = 0;
            command.Parameters.Add(new SqliteParameter("$d", DBNull.Value));
            for (var i = 0; i < parameterCount; i++)
            {
                command.Parameters.Add(new SqliteParameter($"${i}", DBNull.Value));
            }

            return command;
        }

        private void DisposeStatements()
        {
            _insertTerm.Dispose();
            _insertTermMeta.Dispose();
            _insertKanji.Dispose();
            _insertKanjiMeta.Dispose();
            _insertTag.Dispose();
            _insertMedia.Dispose();
        }

        private void InsertDictionary()
        {
            using var command = _connection.CreateCommand();
            command.Transaction = _transaction;
            command.CommandText = "INSERT INTO dictionaries(title, summary, size_bytes) VALUES($title, x'', 0) RETURNING id";
            command.Parameters.AddWithValue("$title", _title);
            _dictionaryId = (long)command.ExecuteScalar()!;
            foreach (var insert in new[] { _insertTerm, _insertTermMeta, _insertKanji, _insertKanjiMeta, _insertTag, _insertMedia })
            {
                insert.Parameters["$d"].Value = _dictionaryId;
            }
        }

        private void UpdateDictionary(JsonObject summary, long size)
        {
            using var command = _connection.CreateCommand();
            command.Transaction = _transaction;
            command.CommandText = "UPDATE dictionaries SET summary = $summary, size_bytes = $size WHERE id = $id";
            command.Parameters.AddWithValue("$summary", JsonSerializer.SerializeToUtf8Bytes(summary, new JsonSerializerOptions { Encoder = WriterOptions.Encoder }));
            command.Parameters.AddWithValue("$size", size);
            command.Parameters.AddWithValue("$id", _dictionaryId);
            command.ExecuteNonQuery();
        }

        private static object Nullable(string? value) => (object?)value ?? DBNull.Value;

        private void Set(SqliteCommand command, int index, object value) => command.Parameters[index + 1].Value = value;

        private void InsertTermV3(JsonElement row)
        {
            WriteGlossary(row[5].EnumerateArray(), row[0].GetString()!);
            InsertTerm(row, row[6].GetDouble(), row[7].GetString());
        }

        private void InsertTermV1(JsonElement row)
        {
            WriteGlossary(row.EnumerateArray().Skip(5), row[0].GetString()!);
            InsertTerm(row, null, null);
        }

        private void InsertTerm(JsonElement row, double? sequence, string? termTags)
        {
            var expression = row[0].GetString()!;
            var reading = row[1].GetString()!;
            if (reading.Length == 0)
            {
                reading = expression;
            }

            var command = _insertTerm;
            Set(command, 0, expression);
            Set(command, 1, reading);
            Set(command, 2, StringReverse(expression));
            Set(command, 3, StringReverse(reading));
            Set(command, 4, Nullable(row[2].ValueKind == JsonValueKind.String ? row[2].GetString() : null));
            Set(command, 5, Nullable(termTags));
            Set(command, 6, row[3].GetString()!);
            Set(command, 7, row[4].GetDouble());
            Set(command, 8, _glossaryBuffer.WrittenSpan.ToArray());
            Set(command, 9, sequence.HasValue ? sequence.Value : DBNull.Value);
            command.ExecuteNonQuery();
            _counts["terms"]["total"]++;
        }

        private void InsertTermMeta(JsonElement row)
        {
            var mode = row[1].GetString()!;
            Set(_insertTermMeta, 0, row[0].GetString()!);
            Set(_insertTermMeta, 1, mode);
            Set(_insertTermMeta, 2, Utf8(row[2]));
            _insertTermMeta.ExecuteNonQuery();
            CountMeta("termMeta", mode);
        }

        private void InsertKanjiV3(JsonElement row)
        {
            InsertKanji(row, Utf8(row[4]), Utf8(row[5]));
        }

        private void InsertKanjiV1(JsonElement row)
        {
            var meanings = new JsonArray([.. row.EnumerateArray().Skip(4).Select(m => JsonValue.Create(m.GetString()))]);
            InsertKanji(row, Encoding.UTF8.GetBytes(meanings.ToJsonString()), null);
        }

        private void InsertKanji(JsonElement row, byte[] meanings, byte[]? stats)
        {
            Set(_insertKanji, 0, row[0].GetString()!);
            Set(_insertKanji, 1, row[1].GetString()!);
            Set(_insertKanji, 2, row[2].GetString()!);
            Set(_insertKanji, 3, row[3].GetString()!);
            Set(_insertKanji, 4, meanings);
            Set(_insertKanji, 5, (object?)stats ?? DBNull.Value);
            _insertKanji.ExecuteNonQuery();
            _counts["kanji"]["total"]++;
        }

        private void InsertKanjiMeta(JsonElement row)
        {
            var mode = row[1].GetString()!;
            Set(_insertKanjiMeta, 0, row[0].GetString()!);
            Set(_insertKanjiMeta, 1, mode);
            Set(_insertKanjiMeta, 2, Utf8(row[2]));
            _insertKanjiMeta.ExecuteNonQuery();
            CountMeta("kanjiMeta", mode);
        }

        private void CountMeta(string group, string mode)
        {
            var counts = _counts[group];
            counts["total"]++;
            counts[mode] = counts.GetValueOrDefault(mode) + 1;
        }

        private void InsertTag(JsonElement row)
        {
            WriteTag(row[0].GetString()!, row[1].GetString(), row[2].GetDouble(), row[3].GetString(), row[4].GetDouble());
        }

        private void InsertIndexTags(JsonObject index)
        {
            if (index["tagMeta"] is not JsonObject tags)
            {
                return;
            }

            foreach (var (name, value) in tags)
            {
                var tag = value!.AsObject();
                WriteTag(name, tag["category"]?.GetValue<string>(), tag["order"]?.GetValue<double>(), tag["notes"]?.GetValue<string>(), tag["score"]?.GetValue<double>());
            }
        }

        private void WriteTag(string name, string? category, double? order, string? notes, double? score)
        {
            Set(_insertTag, 0, name);
            Set(_insertTag, 1, Nullable(category));
            Set(_insertTag, 2, order.HasValue ? order.Value : DBNull.Value);
            Set(_insertTag, 3, Nullable(notes));
            Set(_insertTag, 4, score.HasValue ? score.Value : DBNull.Value);
            _insertTag.ExecuteNonQuery();
            _counts["tagMeta"]["total"]++;
        }

        /// <summary>Writes the stored form of a glossary into the buffer: the "Extended data support" step.</summary>
        private void WriteGlossary(IEnumerable<JsonElement> definitions, string expression)
        {
            _glossaryBuffer.ResetWrittenCount();
            _glossary.Reset();
            _glossary.WriteStartArray();
            foreach (var definition in definitions)
            {
                if (definition.ValueKind == JsonValueKind.Object)
                {
                    WriteGlossaryObject(definition, expression);
                }
                else
                {
                    definition.WriteTo(_glossary);
                }
            }

            _glossary.WriteEndArray();
            _glossary.Flush();
        }

        /// <summary>Port of _formatDictionaryTermGlossaryObject.</summary>
        private void WriteGlossaryObject(JsonElement definition, string expression)
        {
            switch (definition.GetProperty("type").GetString())
            {
                case "text":
                    definition.GetProperty("text").WriteTo(_glossary);
                    break;
                case "image":
                    _glossary.WriteStartObject();
                    _glossary.WriteString("type", "image");
                    WriteImage(definition, expression);
                    _glossary.WriteEndObject();
                    break;
                case "structured-content":
                    _glossary.WriteStartObject();
                    _glossary.WriteString("type", "structured-content");
                    _glossary.WritePropertyName("content");
                    WriteContent(definition.GetProperty("content"), expression);
                    _glossary.WriteEndObject();
                    break;
                default:
                    throw new ImportException("invalid_bank", $"Unhandled data type in {_currentFile}");
            }
        }

        /// <summary>Port of _prepareStructuredContent.</summary>
        private void WriteContent(JsonElement content, string expression)
        {
            switch (content.ValueKind)
            {
                case JsonValueKind.Array:
                    _glossary.WriteStartArray();
                    foreach (var child in content.EnumerateArray())
                    {
                        WriteContent(child, expression);
                    }

                    _glossary.WriteEndArray();
                    break;
                case JsonValueKind.Object when content.TryGetProperty("tag", out var tag) && tag.ValueEquals("img"):
                    _glossary.WriteStartObject();
                    _glossary.WriteString("tag", "img");
                    WriteImage(content, expression);
                    foreach (var key in new[] { "verticalAlign", "border", "borderRadius", "sizeUnits" })
                    {
                        CopyIf(content, key, JsonValueKind.String);
                    }

                    _glossary.WriteEndObject();
                    break;
                case JsonValueKind.Object:
                    _glossary.WriteStartObject();
                    foreach (var property in content.EnumerateObject())
                    {
                        _glossary.WritePropertyName(property.Name);
                        if (property.NameEquals("content"u8))
                        {
                            WriteContent(property.Value, expression);
                        }
                        else
                        {
                            property.Value.WriteTo(_glossary);
                        }
                    }

                    _glossary.WriteEndObject();
                    break;
                default:
                    content.WriteTo(_glossary);
                    break;
            }
        }

        /// <summary>Port of _createImageData. The source's width and height become the preferred size.</summary>
        private void WriteImage(JsonElement source, string expression)
        {
            var path = source.GetProperty("path").GetString()!;
            var (width, height) = GetImage(path, expression);
            _glossary.WriteString("path", path);
            _glossary.WriteNumber("width", width);
            _glossary.WriteNumber("height", height);
            if (source.TryGetProperty("width", out var preferredWidth) && preferredWidth.ValueKind == JsonValueKind.Number)
            {
                _glossary.WritePropertyName("preferredWidth");
                preferredWidth.WriteTo(_glossary);
            }

            if (source.TryGetProperty("height", out var preferredHeight) && preferredHeight.ValueKind == JsonValueKind.Number)
            {
                _glossary.WritePropertyName("preferredHeight");
                preferredHeight.WriteTo(_glossary);
            }

            foreach (var key in new[] { "title", "alt", "description" })
            {
                CopyIf(source, key, JsonValueKind.String);
            }

            CopyBooleanIf(source, "pixelated");
            CopyIf(source, "imageRendering", JsonValueKind.String);
            CopyIf(source, "appearance", JsonValueKind.String);
            CopyBooleanIf(source, "background");
            CopyBooleanIf(source, "collapsed");
            CopyBooleanIf(source, "collapsible");
        }

        private void CopyIf(JsonElement source, string key, JsonValueKind kind)
        {
            if (source.TryGetProperty(key, out var value) && value.ValueKind == kind)
            {
                _glossary.WritePropertyName(key);
                value.WriteTo(_glossary);
            }
        }

        private void CopyBooleanIf(JsonElement source, string key)
        {
            if (source.TryGetProperty(key, out var value) && value.ValueKind is JsonValueKind.True or JsonValueKind.False)
            {
                _glossary.WriteBoolean(key, value.GetBoolean());
            }
        }

        /// <summary>Port of _getImageMedia. Only images a glossary refers to are stored, as in Yomitan.</summary>
        private (int Width, int Height) GetImage(string path, string expression)
        {
            if (_media.TryGetValue(path, out var known))
            {
                return known;
            }

            string Where() => $"at path {SafeArchive.Printable(path)} for {SafeArchive.Printable(expression)}";

            if (!SafeArchive.IsSafeName(path))
            {
                throw new ImportException("unsafe_path", $"Unsafe image path {Where()}");
            }

            var entry = _archive.Find(path) ?? throw new ImportException("invalid_media", $"Could not find image {Where()}");
            var mediaType = ImageFormats.MediaTypeOf(path) ?? throw new ImportException("invalid_media", $"Could not determine media type for image {Where()}");
            var content = _archive.ReadAllBytes(entry, _limits.MaxMediaBytes);
            var size = ImageFormats.ReadSize(content, mediaType) ?? throw new ImportException("invalid_media", $"Could not load image {Where()}");

            Set(_insertMedia, 0, path);
            Set(_insertMedia, 1, mediaType);
            Set(_insertMedia, 2, size.Width);
            Set(_insertMedia, 3, size.Height);
            Set(_insertMedia, 4, content);
            _insertMedia.ExecuteNonQuery();
            _counts["media"]["total"]++;
            _media.Add(path, size);
            return size;
        }
    }

    /// <summary>Port of stringReverse: reverses code points, not UTF-16 units.</summary>
    internal static string StringReverse(string text)
    {
        return string.Create(text.Length, text, static (target, source) =>
        {
            var length = source.Length;
            for (var i = 0; i < length; i++)
            {
                if (i + 1 < length && char.IsSurrogatePair(source[i], source[i + 1]))
                {
                    target[length - i - 2] = source[i];
                    target[length - i - 1] = source[i + 1];
                    i++;
                }
                else
                {
                    target[length - i - 1] = source[i];
                }
            }
        });
    }
}

/// <summary>Where an import has got to.</summary>
/// <param name="Phase">The step: reading, replacing, terms, termMeta, kanji, kanjiMeta, tags, committing or compacting.</param>
/// <param name="Title">The dictionary's title, once the index has been read.</param>
/// <param name="BytesProcessed">Decompressed bytes read.</param>
/// <param name="BytesTotal">Declared decompressed size of the bank files.</param>
/// <param name="Rows">Rows imported.</param>
public sealed record ImportProgress(string Phase, string? Title, long BytesProcessed, long BytesTotal, long Rows);

/// <summary>A finished import.</summary>
/// <param name="Title">The dictionary's title.</param>
/// <param name="Revision">The dictionary's revision.</param>
/// <param name="Replaced">Whether an existing dictionary of that title was replaced.</param>
/// <param name="Counts">Row counts, shaped like Yomitan's summary counts.</param>
/// <param name="SizeBytes">Pages used in the database.</param>
public sealed record ImportResult(string Title, string Revision, bool Replaced, IReadOnlyDictionary<string, Dictionary<string, long>> Counts, long SizeBytes);
