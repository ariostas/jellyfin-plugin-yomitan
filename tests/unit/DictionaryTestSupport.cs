using System.IO.Compression;
using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.Yomitan.Dictionaries;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Jellyfin.Plugin.Yomitan.Tests;

/// <summary>A store in a temporary directory, with helpers for the hand-made dictionaries these tests build.</summary>
internal sealed class TestStore : IDisposable
{
    public const string SampleIndex = """{"title":"Sample","format":3,"revision":"1","sequenced":true}""";

    private readonly string _directory = Path.Combine(Path.GetTempPath(), "yomitan-tests", Guid.NewGuid().ToString("N"));

    public TestStore()
    {
        Directory.CreateDirectory(_directory);
        Store = new DictionaryStore(Path.Combine(_directory, "data"));
        Query = new DictionaryQuery(Store);
    }

    public DictionaryStore Store { get; }

    public DictionaryQuery Query { get; }

    /// <summary>Writes an archive with deflated entries, in the given order.</summary>
    public string WriteZip(params (string Name, string Content)[] entries)
        => WriteZip(entries.Select(e => (e.Name, Encoding.UTF8.GetBytes(e.Content))).ToArray());

    public string WriteZip((string Name, byte[] Content)[] entries)
    {
        var path = Path.Combine(_directory, $"{Guid.NewGuid():N}.zip");
        using var archive = ZipFile.Open(path, ZipArchiveMode.Create);
        foreach (var (name, content) in entries)
        {
            using var stream = archive.CreateEntry(name).Open();
            stream.Write(content);
        }

        return path;
    }

    public string NewPath() => Path.Combine(_directory, $"{Guid.NewGuid():N}.zip");

    public ImportResult Import(string path, bool replace = false, ImportLimits? limits = null, Action<ImportProgress>? onProgress = null)
        => new DictionaryImporter(Store, limits ?? new ImportLimits(), onProgress).Import(path, replace, TestContext.Current.CancellationToken);

    public ImportResult ImportCancelled(string path, CancellationToken token)
        => new DictionaryImporter(Store, new ImportLimits()).Import(path, replace: false, token);

    public ImportResult Import(params (string Name, string Content)[] entries) => Import(WriteZip(entries));

    /// <summary>Runs one operation and returns its result object.</summary>
    public JsonElement Run(object operation) => RunAll(operation).RootElement.GetProperty("results")[0];

    public JsonDocument RunAll(params object[] operations)
    {
        using var request = JsonDocument.Parse(JsonSerializer.Serialize(new { operations }));
        return JsonDocument.Parse(Query.Execute(request.RootElement));
    }

    /// <summary>Counts every row of every table, for proving that a failure left nothing.</summary>
    public string Fingerprint()
    {
        using var connection = new SqliteConnection($"Data Source={Store.DatabasePath};Mode=ReadOnly;Pooling=False");
        connection.Open();
        var parts = new List<string>();
        foreach (var table in new[] { "dictionaries", "terms", "term_meta", "kanji", "kanji_meta", "tag_meta", "media" })
        {
            using var command = connection.CreateCommand();
            command.CommandText = $"SELECT count(*), coalesce(max(id), 0), coalesce(sum(id), 0) FROM {table}";
            using var reader = command.ExecuteReader();
            reader.Read();
            parts.Add($"{table}={reader.GetInt64(0)}/{reader.GetInt64(1)}/{reader.GetInt64(2)}");
        }

        return string.Join(' ', parts);
    }

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        Directory.Delete(_directory, recursive: true);
    }
}

/// <summary>Finds Yomitan's own test data in the submodule.</summary>
internal static class YomitanData
{
    public static string Directory(string relative)
    {
        for (var directory = new DirectoryInfo(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            var candidate = Path.Combine(directory.FullName, "third_party/yomitan/test/data", relative);
            if (System.IO.Directory.Exists(candidate) || File.Exists(candidate))
            {
                return candidate;
            }
        }

        throw new InvalidOperationException($"Yomitan's test data is missing: {relative}");
    }

    public static (string Name, byte[] Content)[] Files(string dictionary)
        => System.IO.Directory.GetFiles(Directory($"dictionaries/{dictionary}")).Order(StringComparer.Ordinal)
            .Select(file => (Path.GetFileName(file), File.ReadAllBytes(file)))
            .ToArray();
}
