using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.Yomitan.Dictionaries;

/// <summary>
/// The plugin's own SQLite database. One file holds every dictionary, images included, so replacing a
/// dictionary is a single transaction. It runs in WAL mode: readers keep seeing the last commit while an import
/// holds the one write transaction, and a crash at any point rolls back to that same commit.
/// </summary>
public sealed class DictionaryStore
{
    private const int SchemaVersion = 1;

    private const string Schema = """
        CREATE TABLE dictionaries(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL UNIQUE,
            summary BLOB NOT NULL,
            size_bytes INTEGER NOT NULL);

        -- ids are never reused, as in Yomitan's IndexedDB stores: the Translator keys on them.
        CREATE TABLE terms(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dict_id INTEGER NOT NULL,
            expression TEXT NOT NULL,
            reading TEXT NOT NULL,
            expression_reverse TEXT NOT NULL,
            reading_reverse TEXT NOT NULL,
            definition_tags TEXT,
            term_tags TEXT,
            rules TEXT,
            score NUMERIC,
            glossary BLOB NOT NULL,
            sequence NUMERIC);
        CREATE INDEX terms_expression ON terms(expression, dict_id);
        CREATE INDEX terms_reading ON terms(reading, dict_id);
        CREATE INDEX terms_sequence ON terms(sequence, dict_id);
        CREATE INDEX terms_expression_reverse ON terms(expression_reverse, dict_id);
        CREATE INDEX terms_reading_reverse ON terms(reading_reverse, dict_id);

        CREATE TABLE term_meta(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dict_id INTEGER NOT NULL,
            expression TEXT NOT NULL,
            mode TEXT NOT NULL,
            data BLOB NOT NULL);
        CREATE INDEX term_meta_expression ON term_meta(expression, dict_id);

        CREATE TABLE kanji(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dict_id INTEGER NOT NULL,
            character TEXT NOT NULL,
            onyomi TEXT NOT NULL,
            kunyomi TEXT NOT NULL,
            tags TEXT NOT NULL,
            meanings BLOB NOT NULL,
            stats BLOB);
        CREATE INDEX kanji_character ON kanji(character, dict_id);

        CREATE TABLE kanji_meta(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dict_id INTEGER NOT NULL,
            character TEXT NOT NULL,
            mode TEXT NOT NULL,
            data BLOB NOT NULL);
        CREATE INDEX kanji_meta_character ON kanji_meta(character, dict_id);

        CREATE TABLE tag_meta(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dict_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            category TEXT,
            sort_order NUMERIC,
            notes TEXT,
            score NUMERIC);
        CREATE INDEX tag_meta_name ON tag_meta(dict_id, name);

        CREATE TABLE media(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            dict_id INTEGER NOT NULL,
            path TEXT NOT NULL,
            media_type TEXT NOT NULL,
            width INTEGER NOT NULL,
            height INTEGER NOT NULL,
            content BLOB NOT NULL);
        CREATE UNIQUE INDEX media_path ON media(dict_id, path);
        """;

    private static readonly string[] RowTables = ["terms", "term_meta", "kanji", "kanji_meta", "tag_meta", "media"];

    private readonly string _readWrite;
    private readonly string _readOnly;

    /// <summary>Initializes a new instance of the <see cref="DictionaryStore"/> class.</summary>
    /// <param name="directory">The plugin's data directory, created if needed.</param>
    public DictionaryStore(string directory)
    {
        Directory.CreateDirectory(directory);
        DatabasePath = Path.Combine(directory, "dictionaries.db");
        UploadDirectory = Path.Combine(directory, "uploads");
        Directory.CreateDirectory(UploadDirectory);

        // Spooled uploads do not outlive the process that was going to import them.
        foreach (var stale in Directory.EnumerateFiles(UploadDirectory))
        {
            File.Delete(stale);
        }

        var connection = new SqliteConnectionStringBuilder { DataSource = DatabasePath, Pooling = true };
        _readWrite = connection.ToString();
        connection.Mode = SqliteOpenMode.ReadOnly;
        _readOnly = connection.ToString();

        Initialize();
    }

    /// <summary>Gets the path of the database file.</summary>
    public string DatabasePath { get; }

    /// <summary>Gets the directory where uploads wait to be imported.</summary>
    public string UploadDirectory { get; }

    /// <summary>Gets a path for a new spooled upload.</summary>
    public string NewUploadPath() => Path.Combine(UploadDirectory, $"{Guid.NewGuid():N}.zip");

    /// <summary>Lists the dictionaries in import order.</summary>
    /// <returns>Each dictionary's Yomitan summary and size.</returns>
    public IReadOnlyList<DictionaryRecord> List()
    {
        using var connection = OpenReader();
        return List(connection);
    }

    /// <summary>Gets how large the database is on disk and how much of that is free for reuse.</summary>
    /// <returns>Sizes in bytes.</returns>
    public (long Database, long Free) GetDatabaseSize()
    {
        using var connection = OpenReader();
        var pageSize = ExecuteScalar(connection, "PRAGMA page_size");
        return (ExecuteScalar(connection, "PRAGMA page_count") * pageSize, ExecuteScalar(connection, "PRAGMA freelist_count") * pageSize);
    }

    /// <summary>Checks whether a dictionary is installed.</summary>
    /// <param name="title">The dictionary's title.</param>
    /// <returns>Whether it is.</returns>
    public bool Exists(string title)
    {
        using var connection = OpenReader();
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT 1 FROM dictionaries WHERE title = $title";
        command.Parameters.AddWithValue("$title", title);
        return command.ExecuteScalar() is not null;
    }

    /// <summary>Deletes a dictionary in one transaction, then gives the space back.</summary>
    /// <param name="title">The dictionary's title.</param>
    public void Delete(string title)
    {
        using var connection = OpenWriter();
        using (var transaction = connection.BeginTransaction())
        {
            var id = FindId(connection, transaction, title)
                ?? throw new ImportException("not_found", $"No dictionary is titled {SafeArchive.Printable(title)}");
            DeleteRows(connection, transaction, id);
            transaction.Commit();
        }

        Compact(connection);
    }

    /// <summary>Reads one image.</summary>
    /// <param name="title">The dictionary's title.</param>
    /// <param name="path">The image's path in the dictionary.</param>
    /// <returns>The image, or null if there is none.</returns>
    public MediaFile? FindMedia(string title, string path)
    {
        using var connection = OpenReader();
        using var command = connection.CreateCommand();
        command.CommandText = """
            SELECT m.id, m.media_type, m.width, m.height, m.content
            FROM media m JOIN dictionaries d ON d.id = m.dict_id
            WHERE d.title = $title AND m.path = $path
            """;
        command.Parameters.AddWithValue("$title", title);
        command.Parameters.AddWithValue("$path", path);
        using var reader = command.ExecuteReader();
        return reader.Read()
            ? new MediaFile(reader.GetInt64(0), reader.GetString(1), reader.GetInt32(2), reader.GetInt32(3), reader.GetFieldValue<byte[]>(4))
            : null;
    }

    internal static List<DictionaryRecord> List(SqliteConnection connection)
    {
        using var command = connection.CreateCommand();
        command.CommandText = "SELECT id, title, summary, size_bytes FROM dictionaries ORDER BY id";
        using var reader = command.ExecuteReader();
        var records = new List<DictionaryRecord>();
        while (reader.Read())
        {
            records.Add(new DictionaryRecord(reader.GetInt64(0), reader.GetString(1), reader.GetFieldValue<byte[]>(2), reader.GetInt64(3)));
        }

        return records;
    }

    internal static long? FindId(SqliteConnection connection, SqliteTransaction transaction, string title)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT id FROM dictionaries WHERE title = $title";
        command.Parameters.AddWithValue("$title", title);
        return command.ExecuteScalar() as long?;
    }

    internal static void DeleteRows(SqliteConnection connection, SqliteTransaction transaction, long id)
    {
        foreach (var table in RowTables)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"DELETE FROM {table} WHERE dict_id = $id";
            command.Parameters.AddWithValue("$id", id);
            command.CommandTimeout = 0;
            command.ExecuteNonQuery();
        }

        using var dictionary = connection.CreateCommand();
        dictionary.Transaction = transaction;
        dictionary.CommandText = "DELETE FROM dictionaries WHERE id = $id";
        dictionary.Parameters.AddWithValue("$id", id);
        dictionary.ExecuteNonQuery();
    }

    /// <summary>Counts the pages in use, which inside a transaction includes its own writes.</summary>
    internal static long UsedBytes(SqliteConnection connection, SqliteTransaction transaction)
    {
        long Read(string pragma)
        {
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = pragma;
            return Convert.ToInt64(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
        }

        return (Read("PRAGMA page_count") - Read("PRAGMA freelist_count")) * Read("PRAGMA page_size");
    }

    /// <summary>Returns freed pages to the file system and folds the WAL into the database.</summary>
    internal static void Compact(SqliteConnection connection)
    {
        Execute(connection, "PRAGMA incremental_vacuum");

        // Readers can hold this back, so it is best effort. The next write's auto-checkpoint catches up.
        Execute(connection, "PRAGMA busy_timeout = 5000");
        Execute(connection, "PRAGMA wal_checkpoint(TRUNCATE)");
        Execute(connection, "PRAGMA busy_timeout = 30000");
    }

    internal SqliteConnection OpenWriter()
    {
        var connection = new SqliteConnection(_readWrite);
        connection.Open();
        Execute(connection, "PRAGMA synchronous = NORMAL; PRAGMA cache_size = -65536;");
        return connection;
    }

    internal SqliteConnection OpenReader()
    {
        var connection = new SqliteConnection(_readOnly);
        connection.Open();
        return connection;
    }

    private static void Execute(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        command.CommandTimeout = 0;
        using var reader = command.ExecuteReader();
        while (reader.Read())
        {
        }
    }

    private static long ExecuteScalar(SqliteConnection connection, string sql)
    {
        using var command = connection.CreateCommand();
        command.CommandText = sql;
        return Convert.ToInt64(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture);
    }

    private void Initialize()
    {
        using var connection = new SqliteConnection(_readWrite);
        connection.Open();

        // auto_vacuum only takes effect before the first table exists.
        Execute(connection, "PRAGMA auto_vacuum = INCREMENTAL");
        Execute(connection, "PRAGMA journal_mode = WAL");
        var version = ExecuteScalar(connection, "PRAGMA user_version");
        if (version == 0)
        {
            using var transaction = connection.BeginTransaction();
            using var command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = $"{Schema}\nPRAGMA user_version = {SchemaVersion};";
            command.ExecuteNonQuery();
            transaction.Commit();
        }
        else if (version != SchemaVersion)
        {
            throw new InvalidOperationException($"{DatabasePath} has schema version {version}; this plugin expects {SchemaVersion}");
        }
    }
}

/// <summary>A dictionary as listed.</summary>
/// <param name="Id">Row id.</param>
/// <param name="Title">The dictionary's title.</param>
/// <param name="Summary">The summary Yomitan would store, as UTF-8 JSON.</param>
/// <param name="SizeBytes">Pages used by this dictionary, including indexes.</param>
public sealed record DictionaryRecord(long Id, string Title, byte[] Summary, long SizeBytes);

/// <summary>A stored image.</summary>
/// <param name="Id">Row id. Never reused, so it identifies these exact bytes.</param>
/// <param name="MediaType">Media type derived from the file name.</param>
/// <param name="Width">Width in pixels.</param>
/// <param name="Height">Height in pixels.</param>
/// <param name="Content">The file.</param>
public sealed record MediaFile(long Id, string MediaType, int Width, int Height, byte[] Content);
