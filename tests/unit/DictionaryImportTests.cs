using System.Text;
using System.Text.Json;
using Jellyfin.Plugin.Yomitan.Dictionaries;
using Microsoft.Data.Sqlite;
using Xunit;

namespace Jellyfin.Plugin.Yomitan.Tests;

public class DictionaryImportTests
{
    private const string V3Terms = """[["打つ","うつ","vt","v5",5,["to hit"],7,"P"],["打つ","ぶつ","","v5",1,["to strike"],8,""]]""";

    [Fact]
    public void Yomitans_valid_dictionary_imports_with_its_expected_counts()
    {
        using var test = new TestStore();
        var expected = JsonDocument.Parse(File.ReadAllText(YomitanData.Directory("database-test-cases.json")))
            .RootElement.GetProperty("expectedSummary");

        test.Import(test.WriteZip(YomitanData.Files("valid-dictionary1")));

        var summary = test.Run(new { op = "getDictionaryInfo" }).GetProperty("rows")[0];
        foreach (var name in new[] { "title", "revision", "sequenced", "version", "styles", "importSuccess", "prefixWildcardsSupported", "counts" })
        {
            Assert.True(JsonElement.DeepEquals(expected.GetProperty(name), summary.GetProperty(name)), name);
        }
    }

    [Theory]
    [InlineData("invalid-dictionary1", "invalid_index")]
    [InlineData("invalid-dictionary2", "invalid_bank")]
    [InlineData("invalid-dictionary3", "invalid_bank")]
    [InlineData("invalid-dictionary4", "invalid_bank")]
    [InlineData("invalid-dictionary5", "invalid_bank")]
    [InlineData("invalid-dictionary6", "invalid_bank")]
    public void Yomitans_invalid_dictionaries_are_refused(string dictionary, string code)
    {
        using var test = new TestStore();
        var before = test.Fingerprint();
        var error = Assert.Throws<ImportException>(() => test.Import(test.WriteZip(YomitanData.Files(dictionary))));
        Assert.Equal(code, error.Code);
        Assert.Equal(before, test.Fingerprint());
    }

    [Theory]
    [InlineData("""{"title":"T","format":4,"revision":"1"}""", "invalid_index")] // Format version too new.
    [InlineData("""{"title":"T","revision":"1"}""", "invalid_index")] // No format at all.
    [InlineData("""{"title":"","format":3,"revision":"1"}""", "invalid_index")]
    [InlineData("""{"title":"T","format":3,"revision":""}""", "invalid_index")]
    [InlineData("""{"title":"T","format":3,"revision":"1","minimumYomitanVersion":"999.0.0.0"}""", "incompatible")]
    [InlineData("""{"title":"T","format":3,"revision":"1","isUpdatable":true,"indexUrl":"file:///etc/passwd","downloadUrl":"https://example.com/d.zip"}""", "invalid_index")]
    [InlineData("not json", "invalid_index")]
    public void A_bad_index_is_refused(string index, string code)
    {
        using var test = new TestStore();
        var error = Assert.Throws<ImportException>(() => test.Import(("index.json", index)));
        Assert.Equal(code, error.Code);
    }

    [Fact]
    public void A_missing_index_is_refused_and_a_nested_one_is_named()
    {
        using var test = new TestStore();
        Assert.Equal("missing_index", Assert.Throws<ImportException>(() => test.Import(("term_bank_1.json", "[]"))).Code);
        var nested = Assert.Throws<ImportException>(() => test.Import(("dict/index.json", TestStore.SampleIndex)));
        Assert.Equal("missing_index", nested.Code);
        Assert.Contains("dict/index.json", nested.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_bom_is_tolerated_as_it_is_by_TextDecoder()
    {
        using var test = new TestStore();
        var result = test.Import(("index.json", "\uFEFF" + TestStore.SampleIndex), ("term_bank_1.json", "\uFEFF" + V3Terms));
        Assert.Equal(2, result.Counts["terms"]["total"]);
    }

    [Fact]
    public void Format_1_uses_the_v1_schemas_and_its_quirks()
    {
        using var test = new TestStore();
        const string Index = """{"title":"Old","version":1,"revision":"1"}""";
        test.Import(("index.json", Index), ("term_bank_1.json", """[["語","ご",null,"",3]]"""), ("kanji_bank_1.json", """[["語","ゴ","かた.る","jouyou"]]"""));

        var term = test.Run(new { op = "findTermsBulk", termList = new[] { "語" }, dictionaries = new[] { "Old" }, matchType = "exact" }).GetProperty("rows")[0];
        Assert.Equal(-1, term.GetProperty("sequence").GetInt32());
        Assert.Equal(0, term.GetProperty("definitionTags").GetArrayLength());
        Assert.Equal(0, term.GetProperty("termTags").GetArrayLength());
        var kanji = test.Run(new { op = "findKanjiBulk", kanjiList = new[] { "語" }, dictionaries = new[] { "Old" } }).GetProperty("rows")[0];
        Assert.Equal(JsonValueKind.Object, kanji.GetProperty("stats").ValueKind);

        // The v1 schema's maxItems really does forbid definitions, so a v1 row with one fails in Yomitan too.
        var error = Assert.Throws<ImportException>(() => test.Import(("index.json", """{"title":"Old2","version":1,"revision":"1"}"""), ("term_bank_1.json", """[["語","ご","","",3,"word"]]""")));
        Assert.Equal("invalid_bank", error.Code);
    }

    [Fact]
    public void Glossary_objects_are_stored_as_the_importer_stores_them()
    {
        using var test = new TestStore();
        var png = ImageTests.Png(3, 2);
        var files = new (string, byte[])[]
        {
            ("index.json", Encoding.UTF8.GetBytes(TestStore.SampleIndex)),
            ("img/a.png", png),
            ("unreferenced.png", png),
            ("term_bank_1.json", Encoding.UTF8.GetBytes("""
                [["語","ご","","",0,[
                    {"type":"text","text":"plain"},
                    {"type":"image","path":"img/a.png","width":10,"title":"t","alt":"a"},
                    {"type":"structured-content","content":[{"tag":"div","data":{"k":"v"},"content":{"tag":"img","path":"img/a.png","height":4,"sizeUnits":"em","data":{"dropped":"yes"}}}]},
                    ["行く",["past"]]
                ],1,""]]
                """)),
        };
        var result = test.Import(test.WriteZip(files));
        Assert.Equal(1, result.Counts["media"]["total"]);

        var definitions = test.Run(new { op = "findTermsBulk", termList = new[] { "語" }, dictionaries = new[] { "Sample" }, matchType = "exact" })
            .GetProperty("rows")[0].GetProperty("definitions");
        using var expected = JsonDocument.Parse("""
            [
                "plain",
                {"type":"image","path":"img/a.png","width":3,"height":2,"preferredWidth":10,"title":"t","alt":"a"},
                {"type":"structured-content","content":[{"tag":"div","data":{"k":"v"},"content":{"tag":"img","path":"img/a.png","width":3,"height":2,"preferredHeight":4,"sizeUnits":"em"}}]},
                ["行く",["past"]]
            ]
            """);
        Assert.True(JsonElement.DeepEquals(expected.RootElement, definitions), definitions.GetRawText());
        Assert.NotNull(test.Store.FindMedia("Sample", "img/a.png"));
        Assert.Null(test.Store.FindMedia("Sample", "unreferenced.png"));
    }

    [Theory]
    [InlineData("""{"type":"image","path":"../secret.png"}""", "unsafe_path")]
    [InlineData("""{"type":"image","path":"/etc/passwd"}""", "unsafe_path")]
    [InlineData("""{"type":"image","path":"missing.png"}""", "invalid_media")]
    [InlineData("""{"type":"image","path":"notes.txt"}""", "invalid_media")]
    [InlineData("""{"type":"image","path":"fake.png"}""", "invalid_media")]
    public void Bad_image_references_fail_the_import(string definition, string code)
    {
        using var test = new TestStore();
        var before = test.Fingerprint();
        var error = Assert.Throws<ImportException>(() => test.Import(
            ("index.json", TestStore.SampleIndex),
            ("notes.txt", "x"),
            ("fake.png", "this is not a png"),
            ("term_bank_1.json", $"""[["語","ご","","",0,[{definition}],1,""]]""")));
        Assert.Equal(code, error.Code);
        Assert.Equal(before, test.Fingerprint());
    }

    [Fact]
    public void Importing_a_title_twice_without_replace_is_refused_and_changes_nothing()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", V3Terms));
        var before = test.Fingerprint();

        var error = Assert.Throws<ImportException>(() => test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", "[]")));

        Assert.Equal("already_exists", error.Code);
        Assert.Equal(before, test.Fingerprint());
    }

    [Fact]
    public void Replace_swaps_the_dictionary_and_never_reuses_ids()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", V3Terms));
        var oldId = test.Run(new { op = "findTermsBulk", termList = new[] { "打つ" }, dictionaries = new[] { "Sample" }, matchType = "exact" }).GetProperty("rows")[1].GetProperty("id").GetInt64();

        var result = test.Import(test.WriteZip(("index.json", """{"title":"Sample","format":3,"revision":"2"}"""), ("term_bank_1.json", """[["新","しん","","",0,["new"],1,""]]""")), replace: true);

        Assert.True(result.Replaced);
        var dictionaries = new[] { "Sample" };
        Assert.Equal(0, test.Run(new { op = "findTermsBulk", termList = new[] { "打つ" }, dictionaries, matchType = "exact" }).GetProperty("rows").GetArrayLength());
        var row = test.Run(new { op = "findTermsBulk", termList = new[] { "新" }, dictionaries, matchType = "exact" }).GetProperty("rows")[0];
        Assert.True(row.GetProperty("id").GetInt64() > oldId);
        Assert.Equal("2", Assert.Single(test.Store.List()).Summary is var summary ? JsonDocument.Parse(summary).RootElement.GetProperty("revision").GetString() : null);
    }

    /// <summary>The failure comes last, after every other bank has gone in, so a partial write would show.</summary>
    [Fact]
    public void A_replacement_failing_midway_leaves_the_previous_version_intact()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", V3Terms), ("tag_bank_1.json", """[["vt","pos",0,"transitive",0]]"""));
        var before = test.Fingerprint();
        var rowsBefore = test.Run(new { op = "findTermsBulk", termList = new[] { "打つ" }, dictionaries = new[] { "Sample" }, matchType = "exact" }).GetRawText();

        var replacement = test.WriteZip(
            ("index.json", """{"title":"Sample","format":3,"revision":"2"}"""),
            ("term_bank_1.json", """[["新","しん","","",0,["new"],1,""]]"""),
            ("kanji_bank_1.json", """[["新","シン","","",["new"],{}]]"""),
            ("tag_bank_1.json", "[[1,2,3]]"));
        var phases = new List<string>();
        var error = Assert.Throws<ImportException>(() => test.Import(replacement, replace: true, onProgress: p => phases.Add(p.Phase)));

        Assert.Equal("invalid_bank", error.Code);
        Assert.Contains("kanji", phases);
        Assert.Contains("replacing", phases);
        Assert.Equal(before, test.Fingerprint());
        Assert.Equal(rowsBefore, test.Run(new { op = "findTermsBulk", termList = new[] { "打つ" }, dictionaries = new[] { "Sample" }, matchType = "exact" }).GetRawText());
        Assert.Equal(0, test.Run(new { op = "findTermsBulk", termList = new[] { "新" }, dictionaries = new[] { "Sample" }, matchType = "exact" }).GetProperty("rows").GetArrayLength());
    }

    /// <summary>
    /// An import larger than the writer's 64 MB page cache spills pages into the WAL before it commits. When it fails
    /// in its last bank, all of that used to stay on disk beside the database.
    /// </summary>
    [Fact]
    public void A_failed_import_leaves_no_large_wal_behind()
    {
        using var test = new TestStore();
        var glossary = new string('x', 4096);
        var rows = string.Join(',', Enumerable.Range(0, 30_000).Select(i => $"""["語{i}","ご","","",0,["{glossary}"],{i},""]"""));
        var path = test.WriteZip(("index.json", TestStore.SampleIndex), ("term_bank_1.json", $"[{rows}]"), ("tag_bank_1.json", "[[1]]"));

        Assert.Equal("invalid_bank", Assert.Throws<ImportException>(() => test.Import(path)).Code);

        var wal = new FileInfo(test.Store.DatabasePath + "-wal");
        Assert.InRange(wal.Exists ? wal.Length : 0, 0, 1024 * 1024);
    }

    /// <summary>A WAL that a crash, or an older version, left large is given back when the store opens.</summary>
    [Fact]
    public void Opening_the_store_gives_back_a_large_wal()
    {
        using var test = new TestStore();
        using var other = new SqliteConnection($"Data Source={test.Store.DatabasePath};Pooling=False");
        other.Open();
        using (var command = other.CreateCommand())
        {
            command.CommandText = """
                PRAGMA wal_autocheckpoint = 0;
                CREATE TABLE filler(data BLOB);
                WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 2000) INSERT INTO filler SELECT randomblob(4096) FROM n;
                DROP TABLE filler;
                """;
            command.ExecuteNonQuery();
        }

        var wal = new FileInfo(test.Store.DatabasePath + "-wal");
        Assert.True(wal.Length > 4 * 1024 * 1024, $"the WAL is only {wal.Length} bytes");

        _ = new DictionaryStore(Path.GetDirectoryName(test.Store.DatabasePath)!);
        wal.Refresh();
        Assert.InRange(wal.Exists ? wal.Length : 0, 0, 1024 * 1024);
    }

    [Fact]
    public void Readers_see_the_old_version_until_a_replacement_commits()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", V3Terms));
        var replacement = test.WriteZip(("index.json", """{"title":"Sample","format":3,"revision":"2"}"""), ("term_bank_1.json", """[["新","しん","","",0,["new"],1,""]]"""));

        var query = new { op = "findTermsBulk", termList = new[] { "打つ", "新" }, dictionaries = new[] { "Sample" }, matchType = "exact" };
        var seen = new List<int>();
        test.Import(replacement, replace: true, onProgress: p =>
        {
            if (p.Phase == "committing")
            {
                seen.Add(test.Run(query).GetProperty("rows").EnumerateArray().Count(row => row.GetProperty("term").GetString() == "打つ"));
            }
        });

        Assert.Equal(2, Assert.Single(seen));
        Assert.Equal("新", Assert.Single(test.Run(query).GetProperty("rows").EnumerateArray()).GetProperty("term").GetString());
    }

    [Fact]
    public void Cancelling_rolls_back()
    {
        using var test = new TestStore();
        var before = test.Fingerprint();
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        Assert.ThrowsAny<OperationCanceledException>(() => test.ImportCancelled(test.WriteZip(("index.json", TestStore.SampleIndex), ("term_bank_1.json", V3Terms)), cancellation.Token));
        Assert.Equal(before, test.Fingerprint());
    }

    [Fact]
    public void Delete_empties_every_table_and_a_second_delete_reports_it_is_gone()
    {
        using var test = new TestStore();
        var empty = test.Fingerprint();
        test.Import(test.WriteZip(YomitanData.Files("valid-dictionary1")));

        test.Store.Delete("Test Dictionary");

        Assert.Equal(empty.Replace("/0/0", string.Empty, StringComparison.Ordinal), string.Join(' ', test.Fingerprint().Split(' ').Select(p => p[..p.IndexOf('/', StringComparison.Ordinal)])));
        Assert.Equal("not_found", Assert.Throws<ImportException>(() => test.Store.Delete("Test Dictionary")).Code);
    }

    [Fact]
    public async Task Failed_jobs_report_their_code_and_remove_the_upload()
    {
        using var test = new TestStore();
        var queue = new JobQueue();
        using var worker = new JobWorker(queue, () => test.Store, () => new ImportLimits(), Microsoft.Extensions.Logging.Abstractions.NullLogger<JobWorker>.Instance);
        await worker.StartAsync(TestContext.Current.CancellationToken);

        var path = test.Store.NewUploadPath();
        File.Copy(test.WriteZip(("index.json", "{}")), path);
        Assert.True(queue.TryReserve());
        var job = new DictionaryJob("import") { ArchivePath = path };
        queue.Submit(job);
        Wait(() => job.FinishedAt is not null);

        Assert.Equal("failed", job.State);
        Assert.Equal("invalid_index", job.ErrorCode);
        Assert.False(File.Exists(path));

        // The slot came back, so the queue does not fill up with failures.
        for (var i = 0; i < JobQueue.MaxPending; i++)
        {
            Assert.True(queue.TryReserve());
        }

        Assert.False(queue.TryReserve());
        await worker.StopAsync(TestContext.Current.CancellationToken);
    }

    /// <summary>The worker starts with the server, and a broken database must not stop that.</summary>
    [Fact]
    public async Task A_store_that_cannot_open_fails_the_job_and_not_the_worker()
    {
        using var test = new TestStore();
        var queue = new JobQueue();
        using var worker = new JobWorker(queue, () => throw new InvalidOperationException("corrupt"), () => new ImportLimits(), Microsoft.Extensions.Logging.Abstractions.NullLogger<JobWorker>.Instance);
        await worker.StartAsync(TestContext.Current.CancellationToken);

        Assert.True(queue.TryReserve());
        var job = new DictionaryJob("import") { ArchivePath = test.WriteZip(("index.json", "{}")) };
        queue.Submit(job);
        Wait(() => job.FinishedAt is not null);

        Assert.Equal("internal", job.ErrorCode);
        Assert.DoesNotContain("corrupt", job.ErrorMessage, StringComparison.Ordinal);
        await worker.StopAsync(TestContext.Current.CancellationToken);
    }

    private static void Wait(Func<bool> condition)
    {
        var deadline = DateTime.UtcNow.AddSeconds(30);
        while (!condition())
        {
            Assert.True(DateTime.UtcNow < deadline, "Timed out");
            Thread.Sleep(10);
        }
    }
}
