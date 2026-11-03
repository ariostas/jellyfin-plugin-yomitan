using System.Text.Encodings.Web;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.Yomitan.Dictionaries;

/// <summary>Bounds on one call to the query endpoint. docs/api.md repeats these, and a test keeps it honest.</summary>
public static class QueryLimits
{
    /// <summary>Largest request body.</summary>
    public const int MaxRequestBytes = 4 * 1024 * 1024;

    /// <summary>Most operations in one request.</summary>
    public const int MaxOperations = 64;

    /// <summary>Most lookups across all operations in one request.</summary>
    public const int MaxItems = 4096;

    /// <summary>Most dictionary titles in one operation.</summary>
    public const int MaxDictionaries = 256;

    /// <summary>Most rows across all operations, after which results are cut short.</summary>
    public const int MaxRows = 20_000;

    /// <summary>Cap on the response body, after which results are cut short. The first getDictionaryInfo is never cut.</summary>
    public const int MaxResponseBytes = 32 * 1024 * 1024;

    /// <summary>Time budget in milliseconds, after which results are cut short.</summary>
    public const int MaxDurationMs = 5_000;
}

/// <summary>A malformed query, reported as a 400.</summary>
public sealed class QueryException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="QueryException"/> class.</summary>
    /// <param name="code">Stable error code.</param>
    /// <param name="message">Human-readable detail.</param>
    public QueryException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    /// <summary>Gets the stable error code.</summary>
    public string Code { get; }
}

/// <summary>
/// Runs a batch of database operations in one read transaction, so they see one state of the database. Each
/// operation is a port of the DictionaryDatabase method of the same name in dictionary-database.js, and
/// reproduces its rows and their order. Order matters: findTermsBulk keeps only the first sighting of a row.
/// Lookups run one at a time through a reused statement, so SQLite's bound-parameter limit never applies.
/// </summary>
public sealed class DictionaryQuery
{
    private const string TermColumns = "id, dict_id, expression, reading, definition_tags, term_tags, rules, score, glossary, sequence";

    /// <summary>An upper bound past every string with the prefix in UTF-8 order, where astral characters sort last.</summary>
    private const string PrefixCeiling = "\U0010FFFF";

    /// <summary>SQLite instructions between looks at the clock while a statement runs.</summary>
    private const int ProgressInterval = 10_000;

    /// <summary>SQLITE_INTERRUPT, which a statement stopped by the deadline fails with.</summary>
    private const int SqliteInterrupt = 9;

    /// <summary>More than the keys, punctuation and numbers of any one row take.</summary>
    private const long RowOverhead = 512;

    private readonly DictionaryStore _store;

    /// <summary>Initializes a new instance of the <see cref="DictionaryQuery"/> class.</summary>
    /// <param name="store">The dictionaries.</param>
    public DictionaryQuery(DictionaryStore store)
    {
        _store = store;
    }

    /// <summary>Gets the time budget of a request.</summary>
    internal TimeSpan MaxDuration { get; init; } = TimeSpan.FromMilliseconds(QueryLimits.MaxDurationMs);

    /// <summary>Gets the byte budget of a response.</summary>
    internal long MaxResponseBytes { get; init; } = QueryLimits.MaxResponseBytes;

    /// <summary>Runs a request body.</summary>
    /// <param name="request">The parsed request.</param>
    /// <returns>The response body as UTF-8 JSON.</returns>
    /// <exception cref="QueryException">The request is malformed or over a limit.</exception>
    public byte[] Execute(JsonElement request)
    {
        var operations = Parse(request);

        using var connection = _store.OpenReader();
        using var transaction = connection.BeginTransaction(deferred: true);
        var dictionaries = DictionaryStore.List(connection);
        var deadline = DateTime.UtcNow + MaxDuration;

        // A single range scan can outlast the whole budget, so the deadline also stops a statement that is running.
        // The connection goes back to the pool afterwards, so the handler must not stay on it.
        SQLitePCL.raw.sqlite3_progress_handler(connection.Handle, ProgressInterval, _ => DateTime.UtcNow > deadline ? 1 : 0, null);
        try
        {
            return new Run(connection, dictionaries, deadline, MaxResponseBytes).Execute(operations);
        }
        finally
        {
            SQLitePCL.raw.sqlite3_progress_handler(connection.Handle, 0, null, null);
        }
    }

    private static List<JsonElement> Parse(JsonElement request)
    {
        if (request.ValueKind != JsonValueKind.Object
            || !request.TryGetProperty("operations", out var list)
            || list.ValueKind != JsonValueKind.Array)
        {
            throw new QueryException("invalid_request", "The body must be an object with an \"operations\" array");
        }

        if (list.GetArrayLength() > QueryLimits.MaxOperations)
        {
            throw new QueryException("too_many_operations", $"At most {QueryLimits.MaxOperations} operations are allowed in one request");
        }

        var items = 0L;
        var operations = new List<JsonElement>();
        foreach (var operation in list.EnumerateArray())
        {
            items += Validate(operation);
            operations.Add(operation);
        }

        if (items > QueryLimits.MaxItems)
        {
            throw new QueryException("too_many_items", $"At most {QueryLimits.MaxItems} lookups are allowed in one request; this has {items}");
        }

        return operations;
    }

    /// <summary>Checks an operation's shape and returns how many lookups it has.</summary>
    private static int Validate(JsonElement operation)
    {
        if (operation.ValueKind != JsonValueKind.Object
            || !operation.TryGetProperty("op", out var op)
            || op.ValueKind != JsonValueKind.String)
        {
            throw new QueryException("invalid_request", "Each operation must be an object with an \"op\" string");
        }

        var name = Text(op);
        switch (name)
        {
            case "findTermsBulk":
                RequireString(operation, name, "matchType");
                if (Text(operation.GetProperty("matchType")) is not ("exact" or "prefix" or "suffix"))
                {
                    throw Invalid(name, "matchType must be exact, prefix or suffix");
                }

                RequireDictionaries(operation, name);
                var count = RequireStrings(operation, name, "termList");

                // An empty key would match every row, walking a whole index for each one. The Translator never sends
                // one: it only searches by prefix or suffix for a wildcard, and returns early on empty text.
                if (Text(operation.GetProperty("matchType")) != "exact"
                    && operation.GetProperty("termList").EnumerateArray().Any(item => item.ValueEquals(string.Empty)))
                {
                    throw Invalid(name, "a prefix or suffix search needs a term that is not empty");
                }

                return count;
            case "findTermMetaBulk":
                RequireDictionaries(operation, name);
                return RequireStrings(operation, name, "termList");
            case "findKanjiBulk" or "findKanjiMetaBulk":
                RequireDictionaries(operation, name);
                return RequireStrings(operation, name, "kanjiList");
            case "findTermsExactBulk":
                RequireDictionaries(operation, name);
                return RequireObjects(operation, name, "termList", item =>
                {
                    RequireString(item, name, "term");
                    RequireString(item, name, "reading");
                });
            case "findTermsBySequenceBulk":
                return RequireObjects(operation, name, "items", item =>
                {
                    if (!item.TryGetProperty("query", out var query) || query.ValueKind != JsonValueKind.Number)
                    {
                        throw Invalid(name, "each item's query must be a number");
                    }

                    RequireString(item, name, "dictionary");
                });
            case "findTagMetaBulk":
                return RequireObjects(operation, name, "items", item =>
                {
                    RequireString(item, name, "query");
                    RequireString(item, name, "dictionary");
                });
            case "getDictionaryInfo":
                return 0;
            default:
                throw new QueryException("unknown_operation", $"Unknown operation {SafeArchive.Printable(name ?? string.Empty)}");
        }
    }

    private static QueryException Invalid(string operation, string message) => new("invalid_request", $"{operation}: {message}");

    private static void RequireString(JsonElement parent, string operation, string key)
    {
        if (!parent.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.String)
        {
            throw Invalid(operation, $"{key} must be a string");
        }
    }

    /// <summary>
    /// Decodes a string from a request, or returns null if .NET cannot represent it. The Translator slices text by
    /// UTF-16 unit, so an astral character such as 𠮟 or an emoji regularly reaches here cut in half. No key in the
    /// database has a lone surrogate, because the importer refuses them, so such a string simply matches nothing.
    /// </summary>
    private static string? Text(JsonElement element)
    {
        try
        {
            return element.GetString();
        }
        catch (InvalidOperationException)
        {
            return null;
        }
    }

    private static JsonElement RequireArray(JsonElement parent, string operation, string key)
    {
        if (!parent.TryGetProperty(key, out var value) || value.ValueKind != JsonValueKind.Array)
        {
            throw Invalid(operation, $"{key} must be an array");
        }

        return value;
    }

    private static int RequireStrings(JsonElement parent, string operation, string key)
    {
        var list = RequireArray(parent, operation, key);
        foreach (var item in list.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.String)
            {
                throw Invalid(operation, $"{key} must contain only strings");
            }
        }

        return list.GetArrayLength();
    }

    private static int RequireObjects(JsonElement parent, string operation, string key, Action<JsonElement> check)
    {
        var list = RequireArray(parent, operation, key);
        foreach (var item in list.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
            {
                throw Invalid(operation, $"{key} must contain only objects");
            }

            check(item);
        }

        return list.GetArrayLength();
    }

    private static void RequireDictionaries(JsonElement parent, string operation)
    {
        if (RequireStrings(parent, operation, "dictionaries") > QueryLimits.MaxDictionaries)
        {
            throw new QueryException("too_many_dictionaries", $"{operation}: at most {QueryLimits.MaxDictionaries} dictionaries are allowed");
        }
    }

    /// <summary>One request: the snapshot's dictionaries, the output, and what is left of the budget.</summary>
    private sealed class Run
    {
        private readonly SqliteConnection _connection;
        private readonly List<DictionaryRecord> _dictionaries;
        private readonly Dictionary<long, string> _titles;
        private readonly Dictionary<string, long> _ids;
        private readonly MemoryStream _output = new();
        private readonly Utf8JsonWriter _writer;
        private readonly DateTime _deadline;
        private readonly long _maxBytes;
        private int _rowsLeft = QueryLimits.MaxRows;
        private bool _truncated;
        private bool _sentDictionaryInfo;

        public Run(SqliteConnection connection, List<DictionaryRecord> dictionaries, DateTime deadline, long maxBytes)
        {
            _connection = connection;
            _deadline = deadline;
            _maxBytes = maxBytes;
            _dictionaries = dictionaries;
            _titles = dictionaries.ToDictionary(d => d.Id, d => d.Title);
            _ids = dictionaries.ToDictionary(d => d.Title, d => d.Id, StringComparer.Ordinal);
            _writer = new Utf8JsonWriter(_output, new JsonWriterOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping, SkipValidation = true });
        }

        public byte[] Execute(List<JsonElement> operations)
        {
            _writer.WriteStartObject();
            _writer.WriteStartArray("results");
            foreach (var operation in operations)
            {
                // Once the budget has run out, later operations still answer, empty and marked.
                var alreadyOut = _truncated;
                _writer.WriteStartObject();
                _writer.WriteStartArray("rows");
                try
                {
                    Dispatch(operation);
                }
                catch (SqliteException e) when (e.SqliteErrorCode == SqliteInterrupt)
                {
                    // The deadline stopped a statement. Nothing is written while one runs, so the output is whole.
                    _truncated = true;
                }

                _writer.WriteEndArray();
                _writer.WriteBoolean("truncated", _truncated || alreadyOut);
                _writer.WriteEndObject();
            }

            _writer.WriteEndArray();
            _writer.WriteEndObject();
            _writer.Flush();
            return _output.ToArray();
        }

        private void Dispatch(JsonElement operation)
        {
            var name = Text(operation.GetProperty("op"));
            if (name == "getDictionaryInfo")
            {
                // A client needs the list whatever else happened, so the first one always answers. It still counts, and
                // a summary can hold megabytes of styles, so a second one only answers if it fits.
                if (_sentDictionaryInfo
                    && (_truncated || Written + _dictionaries.Sum(dictionary => dictionary.Summary.Length + 1L) > _maxBytes))
                {
                    _truncated = true;
                    return;
                }

                _sentDictionaryInfo = true;
                foreach (var dictionary in _dictionaries)
                {
                    _writer.WriteRawValue(dictionary.Summary, skipInputValidation: true);
                }

                return;
            }

            if (_truncated)
            {
                return;
            }

            switch (name)
            {
                case "findTermsBulk":
                    FindTerms(operation);
                    break;
                case "findTermsExactBulk":
                    FindTermsExact(operation);
                    break;
                case "findTermsBySequenceBulk":
                    FindTermsBySequence(operation);
                    break;
                case "findTermMetaBulk":
                    FindMeta(operation, "termList", "term_meta", "expression", "term");
                    break;
                case "findKanjiMetaBulk":
                    FindMeta(operation, "kanjiList", "kanji_meta", "character", "character");
                    break;
                case "findKanjiBulk":
                    FindKanji(operation);
                    break;
                case "findTagMetaBulk":
                    FindTagMeta(operation);
                    break;
                default:
                    throw new InvalidOperationException($"Unhandled operation {name}");
            }
        }

        /// <summary>Gets what has been written so far, which is what the byte budget is charged.</summary>
        private long Written => _writer.BytesCommitted + _writer.BytesPending;

        /// <summary>
        /// Takes the row from the budget, or marks the results cut short. <paramref name="bound"/> is at least what the
        /// row will write, so the response stays within the budget, and what it really wrote is charged afterwards.
        /// </summary>
        private bool Spend(long bound)
        {
            _rowsLeft--;
            if (_rowsLeft < 0 || Written + bound > _maxBytes)
            {
                _truncated = true;
            }

            return !_truncated;
        }

        /// <summary>The most a string can take as JSON: six bytes for a character escaped as \u0000, quotes included.</summary>
        private static long Bound(string? text) => text is null ? 0 : (6L * text.Length) + 2;

        private long Bound(TermRow row)
            => RowOverhead + row.Glossary.Length + Bound(row.Expression) + Bound(row.Reading) + Bound(row.DefinitionTags)
                + Bound(row.TermTags) + Bound(row.Rules) + Bound(_titles[row.DictionaryId]);

        private bool OutOfTime()
        {
            if (DateTime.UtcNow > _deadline)
            {
                _truncated = true;
            }

            return _truncated;
        }

        /// <summary>Resolves titles to a SQL list of ids. Unknown titles simply match nothing, as in Yomitan.</summary>
        private string? DictionaryFilter(JsonElement operation)
        {
            var ids = operation.GetProperty("dictionaries").EnumerateArray()
                .Select(title => Text(title) is { } name && _ids.TryGetValue(name, out var id) ? id : (long?)null)
                .OfType<long>()
                .Distinct()
                .ToList();
            return ids.Count == 0 ? null : string.Join(',', ids);
        }

        private SqliteCommand Prepare(string sql, params string[] parameters)
        {
            var command = _connection.CreateCommand();
            command.CommandText = sql;
            foreach (var parameter in parameters)
            {
                command.Parameters.Add(new SqliteParameter(parameter, DBNull.Value));
            }

            return command;
        }

        /// <summary>Port of findTermsBulk and _findMultiBulk with its visited set.</summary>
        private void FindTerms(JsonElement operation)
        {
            var filter = DictionaryFilter(operation);
            if (filter is null)
            {
                return;
            }

            var matchType = Text(operation.GetProperty("matchType"))!;
            var exact = matchType == "exact";
            var reverse = matchType == "suffix";
            string[] columns = reverse ? ["expression_reverse", "reading_reverse"] : ["expression", "reading"];

            using var first = PrepareTermLookup(columns[0], exact, filter);
            using var second = PrepareTermLookup(columns[1], exact, filter);
            SqliteCommand[] commands = [first, second];

            var visited = new HashSet<long>();
            var rows = new List<TermRow>();
            var itemIndex = 0;
            foreach (var element in operation.GetProperty("termList").EnumerateArray())
            {
                if (Text(element) is not { } item)
                {
                    itemIndex++;
                    continue;
                }

                var key = reverse ? DictionaryImporter.StringReverse(item) : item;
                for (var indexIndex = 0; indexIndex < commands.Length; indexIndex++)
                {
                    if (OutOfTime())
                    {
                        return;
                    }

                    var command = commands[indexIndex];
                    command.Parameters["$key"].Value = key;
                    if (!exact)
                    {
                        command.Parameters["$end"].Value = key + PrefixCeiling;
                    }

                    var full = ReadTerms(command, rows, sortKeyColumn: 10);

                    // IndexedDB orders keys by UTF-16 unit and SQLite by UTF-8 byte. They disagree on astral
                    // characters, and visited makes the order observable.
                    if (!exact)
                    {
                        rows.Sort(static (a, b) =>
                        {
                            var order = string.CompareOrdinal(a.SortKey, b.SortKey);
                            return order != 0 ? order : a.Id.CompareTo(b.Id);
                        });
                    }

                    var matchSource = indexIndex == 0 ? "term" : "reading";
                    foreach (var row in rows)
                    {
                        if (!visited.Add(row.Id))
                        {
                            continue;
                        }

                        if (!Spend(Bound(row)))
                        {
                            return;
                        }

                        var isExact = (indexIndex == 0 ? row.Expression : row.Reading) == item;
                        WriteTerm(row, itemIndex, isExact ? "exact" : matchType, matchSource);
                    }

                    rows.Clear();
                    if (full)
                    {
                        // Rows past the limit were never read, even if visited kept this from spending it all.
                        _truncated = true;
                        return;
                    }
                }

                itemIndex++;
            }
        }

        private SqliteCommand PrepareTermLookup(string column, bool exact, string filter)
        {
            return exact
                ? Prepare(
                    $"SELECT {TermColumns}, {column} FROM terms WHERE {column} = $key AND dict_id IN ({filter}) ORDER BY id LIMIT $limit",
                    "$key",
                    "$limit")
                : Prepare(
                    $"SELECT {TermColumns}, {column} FROM terms WHERE {column} >= $key AND {column} < $end AND dict_id IN ({filter}) ORDER BY {column}, id LIMIT $limit",
                    "$key",
                    "$end",
                    "$limit");
        }

        /// <summary>Port of findTermsExactBulk.</summary>
        private void FindTermsExact(JsonElement operation)
        {
            var filter = DictionaryFilter(operation);
            if (filter is null)
            {
                return;
            }

            using var command = Prepare(
                $"SELECT {TermColumns} FROM terms WHERE expression = $term AND reading = $reading AND dict_id IN ({filter}) ORDER BY id LIMIT $limit",
                "$term",
                "$reading",
                "$limit");
            var rows = new List<TermRow>();
            var itemIndex = 0;
            foreach (var item in operation.GetProperty("termList").EnumerateArray())
            {
                if (Text(item.GetProperty("term")) is { } term && Text(item.GetProperty("reading")) is { } reading)
                {
                    command.Parameters["$term"].Value = term;
                    command.Parameters["$reading"].Value = reading;
                    var full = ReadTerms(command, rows, sortKeyColumn: null);
                    if (!WriteAll(rows, itemIndex, "term", full))
                    {
                        return;
                    }
                }

                itemIndex++;
            }
        }

        /// <summary>Port of findTermsBySequenceBulk.</summary>
        private void FindTermsBySequence(JsonElement operation)
        {
            using var command = Prepare($"SELECT {TermColumns} FROM terms WHERE sequence = $sequence AND dict_id = $dict ORDER BY id LIMIT $limit", "$sequence", "$dict", "$limit");
            var rows = new List<TermRow>();
            var itemIndex = 0;
            foreach (var item in operation.GetProperty("items").EnumerateArray())
            {
                if (Text(item.GetProperty("dictionary")) is { } title && _ids.TryGetValue(title, out var dictionaryId))
                {
                    command.Parameters["$sequence"].Value = item.GetProperty("query").GetDouble();
                    command.Parameters["$dict"].Value = dictionaryId;
                    var full = ReadTerms(command, rows, sortKeyColumn: null);
                    if (!WriteAll(rows, itemIndex, "sequence", full))
                    {
                        return;
                    }
                }

                itemIndex++;
            }
        }

        private bool WriteAll(List<TermRow> rows, int itemIndex, string matchSource, bool full)
        {
            if (OutOfTime() || full)
            {
                _truncated = true;
            }

            if (_truncated)
            {
                return false;
            }

            foreach (var row in rows)
            {
                if (!Spend(Bound(row)))
                {
                    return false;
                }

                WriteTerm(row, itemIndex, "exact", matchSource);
            }

            rows.Clear();
            return true;
        }

        /// <summary>
        /// Reads at most what the budget allows, and returns whether it had to stop there. It stops on bytes as well as
        /// rows, since one key can hold thousands of large glossaries, and they are read before any is written.
        /// </summary>
        private bool ReadTerms(SqliteCommand command, List<TermRow> rows, int? sortKeyColumn)
        {
            var limit = _rowsLeft + 1L;
            command.Parameters["$limit"].Value = limit;
            var bytesLeft = _maxBytes - Written;
            using var reader = command.ExecuteReader();
            while (reader.Read())
            {
                var row = new TermRow(
                    reader.GetInt64(0),
                    reader.GetInt64(1),
                    reader.GetString(2),
                    reader.GetString(3),
                    reader.IsDBNull(4) ? null : reader.GetString(4),
                    reader.IsDBNull(5) ? null : reader.GetString(5),
                    reader.IsDBNull(6) ? null : reader.GetString(6),
                    reader.GetDouble(7),
                    reader.GetFieldValue<byte[]>(8),
                    reader.IsDBNull(9) ? -1 : reader.GetDouble(9),
                    sortKeyColumn is { } column ? reader.GetString(column) : string.Empty);

                // A row that does not fit could not be written either, so reading on would be wasted.
                bytesLeft -= Bound(row);
                if (bytesLeft < 0)
                {
                    return true;
                }

                rows.Add(row);
            }

            return rows.Count >= limit;
        }

        /// <summary>Port of _createTerm.</summary>
        private void WriteTerm(TermRow row, int index, string matchType, string matchSource)
        {
            _writer.WriteStartObject();
            _writer.WriteNumber("index", index);
            _writer.WriteString("matchType", matchType);
            _writer.WriteString("matchSource", matchSource);
            _writer.WriteString("term", row.Expression);
            _writer.WriteString("reading", row.Reading);
            WriteField("definitionTags", row.DefinitionTags);
            WriteField("termTags", row.TermTags);
            WriteField("rules", row.Rules);
            _writer.WritePropertyName("definitions");
            _writer.WriteRawValue(row.Glossary, skipInputValidation: true);
            _writer.WriteNumber("score", row.Score);
            _writer.WriteString("dictionary", _titles[row.DictionaryId]);
            _writer.WriteNumber("id", row.Id);
            _writer.WriteNumber("sequence", row.Sequence);
            _writer.WriteEndObject();
        }

        /// <summary>Port of _splitField, including its empty strings for doubled spaces.</summary>
        private void WriteField(string name, string? field)
        {
            _writer.WriteStartArray(name);
            if (!string.IsNullOrEmpty(field))
            {
                foreach (var part in field.Split(' '))
                {
                    _writer.WriteStringValue(part);
                }
            }

            _writer.WriteEndArray();
        }

        /// <summary>Port of findTermMetaBulk and findKanjiMetaBulk, which differ only in the key's name.</summary>
        private void FindMeta(JsonElement operation, string listName, string table, string column, string keyName)
        {
            var filter = DictionaryFilter(operation);
            if (filter is null)
            {
                return;
            }

            using var command = Prepare($"SELECT dict_id, mode, data FROM {table} WHERE {column} = $key AND dict_id IN ({filter}) ORDER BY id", "$key");
            var itemIndex = 0;
            foreach (var item in operation.GetProperty(listName).EnumerateArray())
            {
                if (OutOfTime())
                {
                    return;
                }

                if (Text(item) is not { } key)
                {
                    itemIndex++;
                    continue;
                }

                command.Parameters["$key"].Value = key;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var data = reader.GetFieldValue<byte[]>(2);
                        var mode = reader.GetString(1);
                        var title = _titles[reader.GetInt64(0)];
                        if (!Spend(RowOverhead + data.Length + Bound(key) + Bound(mode) + Bound(title)))
                        {
                            return;
                        }

                        _writer.WriteStartObject();
                        _writer.WriteNumber("index", itemIndex);
                        _writer.WriteString(keyName, key);
                        _writer.WriteString("mode", mode);
                        _writer.WritePropertyName("data");
                        _writer.WriteRawValue(data, skipInputValidation: true);
                        _writer.WriteString("dictionary", title);
                        _writer.WriteEndObject();
                    }
                }

                itemIndex++;
            }
        }

        /// <summary>Port of findKanjiBulk and _createKanji.</summary>
        private void FindKanji(JsonElement operation)
        {
            var filter = DictionaryFilter(operation);
            if (filter is null)
            {
                return;
            }

            using var command = Prepare(
                $"SELECT dict_id, onyomi, kunyomi, tags, meanings, stats FROM kanji WHERE character = $key AND dict_id IN ({filter}) ORDER BY id",
                "$key");
            var itemIndex = 0;
            foreach (var item in operation.GetProperty("kanjiList").EnumerateArray())
            {
                if (OutOfTime())
                {
                    return;
                }

                if (Text(item) is not { } key)
                {
                    itemIndex++;
                    continue;
                }

                command.Parameters["$key"].Value = key;
                using (var reader = command.ExecuteReader())
                {
                    while (reader.Read())
                    {
                        var meanings = reader.GetFieldValue<byte[]>(4);
                        var stats = reader.IsDBNull(5) ? "{}"u8.ToArray() : reader.GetFieldValue<byte[]>(5);
                        var onyomi = reader.GetString(1);
                        var kunyomi = reader.GetString(2);
                        var tags = reader.GetString(3);
                        var title = _titles[reader.GetInt64(0)];
                        var bound = RowOverhead + meanings.Length + stats.Length + Bound(key) + Bound(onyomi) + Bound(kunyomi) + Bound(tags) + Bound(title);
                        if (!Spend(bound))
                        {
                            return;
                        }

                        _writer.WriteStartObject();
                        _writer.WriteNumber("index", itemIndex);
                        _writer.WriteString("character", key);
                        WriteField("onyomi", onyomi);
                        WriteField("kunyomi", kunyomi);
                        WriteField("tags", tags);
                        _writer.WritePropertyName("definitions");
                        _writer.WriteRawValue(meanings, skipInputValidation: true);
                        _writer.WritePropertyName("stats");
                        _writer.WriteRawValue(stats, skipInputValidation: true);
                        _writer.WriteString("dictionary", title);
                        _writer.WriteEndObject();
                    }
                }

                itemIndex++;
            }
        }

        /// <summary>Port of findTagMetaBulk. Rows line up with the items, and a miss is null.</summary>
        private void FindTagMeta(JsonElement operation)
        {
            using var command = Prepare("SELECT name, category, sort_order, notes, score FROM tag_meta WHERE dict_id = $dict AND name = $name ORDER BY id LIMIT 1", "$dict", "$name");
            foreach (var item in operation.GetProperty("items").EnumerateArray())
            {
                if (OutOfTime())
                {
                    return;
                }

                var title = Text(item.GetProperty("dictionary"));
                var name = Text(item.GetProperty("query"));
                if (title is null || name is null || !_ids.TryGetValue(title, out var dictionaryId))
                {
                    if (!WriteMissingTag())
                    {
                        return;
                    }

                    continue;
                }

                command.Parameters["$dict"].Value = dictionaryId;
                command.Parameters["$name"].Value = name;
                using var reader = command.ExecuteReader();
                if (!reader.Read())
                {
                    if (!WriteMissingTag())
                    {
                        return;
                    }

                    continue;
                }

                // A tag from an index's obsolete tagMeta can lack any field but its name.
                var tagName = reader.GetString(0);
                var category = reader.IsDBNull(1) ? null : reader.GetString(1);
                var notes = reader.IsDBNull(3) ? null : reader.GetString(3);
                if (!Spend(RowOverhead + Bound(tagName) + Bound(category) + Bound(notes) + Bound(title)))
                {
                    return;
                }

                _writer.WriteStartObject();
                _writer.WriteString("name", tagName);
                if (category is not null)
                {
                    _writer.WriteString("category", category);
                }

                if (!reader.IsDBNull(2))
                {
                    _writer.WriteNumber("order", reader.GetDouble(2));
                }

                if (notes is not null)
                {
                    _writer.WriteString("notes", notes);
                }

                if (!reader.IsDBNull(4))
                {
                    _writer.WriteNumber("score", reader.GetDouble(4));
                }

                _writer.WriteString("dictionary", title);
                _writer.WriteEndObject();
            }
        }

        private bool WriteMissingTag()
        {
            if (!Spend(RowOverhead))
            {
                return false;
            }

            _writer.WriteNullValue();
            return true;
        }
    }

    private sealed record TermRow(
        long Id,
        long DictionaryId,
        string Expression,
        string Reading,
        string? DefinitionTags,
        string? TermTags,
        string? Rules,
        double Score,
        byte[] Glossary,
        double Sequence,
        string SortKey);
}
