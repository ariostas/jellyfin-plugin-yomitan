using System.Text.Json;
using Jellyfin.Plugin.Yomitan.Dictionaries;
using Xunit;

namespace Jellyfin.Plugin.Yomitan.Tests;

/// <summary>
/// The rules of the query layer that do not depend on a fixture's content. Agreement with real Yomitan is proved
/// by tests/e2e/parity.spec.mjs. These cover what that fixture cannot reach, and the limits.
/// </summary>
public class DictionaryQueryTests
{
    private static readonly string[] Sample = ["Sample"];

    [Fact]
    public void A_row_matching_on_both_indexes_comes_back_once_as_a_term_match()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", """[["かな","かな","","",0,["kana"],1,""]]"""));
        var row = Assert.Single(test.Run(new { op = "findTermsBulk", termList = new[] { "かな" }, dictionaries = Sample, matchType = "exact" }).GetProperty("rows").EnumerateArray());
        Assert.Equal("term", row.GetProperty("matchSource").GetString());
    }

    [Fact]
    public void A_row_is_kept_by_the_first_item_that_finds_it()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", """[["語","ご","","",0,["word"],1,""]]"""));
        var rows = test.Run(new { op = "findTermsBulk", termList = new[] { "ご", "語" }, dictionaries = Sample, matchType = "exact" }).GetProperty("rows");
        var row = Assert.Single(rows.EnumerateArray());
        Assert.Equal(0, row.GetProperty("index").GetInt32());
        Assert.Equal("reading", row.GetProperty("matchSource").GetString());
    }

    /// <summary>
    /// 𠮟 sorts after every BMP character in UTF-8, but before the BMP's top in UTF-16. A plain SQLite range
    /// up to U+FFFF would miss it, and SQLite's order would put it after ｱ, unlike IndexedDB.
    /// </summary>
    [Fact]
    public void Prefix_matches_astral_characters_in_utf16_order()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", """[["あｱ","あ","","",0,[],1,""],["あ𠮟","あ","","",0,[],2,""],["あい","あ","","",0,[],3,""]]"""));
        var rows = test.Run(new { op = "findTermsBulk", termList = new[] { "あ" }, dictionaries = new[] { "Sample" }, matchType = "prefix" }).GetProperty("rows");
        var terms = rows.EnumerateArray().Where(r => r.GetProperty("matchSource").GetString() == "term").Select(r => r.GetProperty("term").GetString()!).ToArray();
        Assert.Equal(["あい", "あ𠮟", "あｱ"], terms);
    }

    [Fact]
    public void Suffix_reverses_by_code_point()
    {
        using var test = new TestStore();
        Assert.Equal("𠮟あ", DictionaryImporter.StringReverse("あ𠮟"));
        Assert.Equal("c\uD83Db", DictionaryImporter.StringReverse("b\uD83Dc"));

        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", """[["あ𠮟","あ","","",0,[],1,""],["𠮟る","しかる","","",0,[],2,""]]"""));
        var rows = test.Run(new { op = "findTermsBulk", termList = new[] { "𠮟" }, dictionaries = Sample, matchType = "suffix" }).GetProperty("rows");
        var row = Assert.Single(rows.EnumerateArray());
        Assert.Equal("あ𠮟", row.GetProperty("term").GetString());
        Assert.Equal("suffix", row.GetProperty("matchType").GetString());
    }

    /// <summary>
    /// The Translator cuts text by UTF-16 unit, so half of 𠮟 reaches the server as a lone surrogate. Real JMdict
    /// lookups found this: it used to be a 500 on any subtitle with an astral character or emoji.
    /// </summary>
    [Fact]
    public void A_string_cut_through_a_surrogate_pair_matches_nothing_and_keeps_later_indexes_right()
    {
        using var test = new TestStore();
        test.Import(
            ("index.json", TestStore.SampleIndex),
            ("term_bank_1.json", """[["𠮟る","しかる","","",0,[],1,""]]"""),
            ("term_meta_bank_1.json", """[["𠮟る","freq",1]]"""),
            ("kanji_bank_1.json", """[["𠮟","シツ","","",[],{}]]"""),
            ("kanji_meta_bank_1.json", """[["𠮟","freq",1]]"""),
            ("tag_bank_1.json", """[["n","c",0,"",0]]"""));

        const string Lone = "\"\\ud842\"";
        const string List = """["\ud842","\udfb7","a\ud842b","𠮟る"]""";
        using var request = JsonDocument.Parse($$"""
            {"operations":[
                {"op":"findTermsBulk","termList":{{List}},"dictionaries":["Sample",{{Lone}}],"matchType":"exact"},
                {"op":"findTermsBulk","termList":[{{Lone}}],"dictionaries":["Sample"],"matchType":"prefix"},
                {"op":"findTermsBulk","termList":[{{Lone}}],"dictionaries":["Sample"],"matchType":"suffix"},
                {"op":"findTermsExactBulk","termList":[{"term":{{Lone}},"reading":"x"},{"term":"x","reading":{{Lone}}},{"term":"𠮟る","reading":"しかる"}],"dictionaries":["Sample"]},
                {"op":"findTermsBySequenceBulk","items":[{"query":1,"dictionary":{{Lone}}},{"query":1,"dictionary":"Sample"}]},
                {"op":"findTermMetaBulk","termList":{{List}},"dictionaries":["Sample"]},
                {"op":"findKanjiBulk","kanjiList":[{{Lone}},"𠮟"],"dictionaries":["Sample"]},
                {"op":"findKanjiMetaBulk","kanjiList":[{{Lone}},"𠮟"],"dictionaries":["Sample"]},
                {"op":"findTagMetaBulk","items":[{"query":{{Lone}},"dictionary":"Sample"},{"query":"n","dictionary":{{Lone}}},{"query":"n","dictionary":"Sample"}]}
            ]}
            """);
        using var response = JsonDocument.Parse(test.Query.Execute(request.RootElement));
        var results = response.RootElement.GetProperty("results");

        int[] expectedIndexes = [3, -1, -1, 2, 1, 3, 1, 1];
        for (var i = 0; i < expectedIndexes.Length; i++)
        {
            var rows = results[i].GetProperty("rows");
            if (expectedIndexes[i] < 0)
            {
                Assert.Equal(0, rows.GetArrayLength());
            }
            else
            {
                Assert.Equal(expectedIndexes[i], Assert.Single(rows.EnumerateArray()).GetProperty("index").GetInt32());
            }
        }

        var tags = results[8].GetProperty("rows");
        Assert.Equal(JsonValueKind.Null, tags[0].ValueKind);
        Assert.Equal(JsonValueKind.Null, tags[1].ValueKind);
        Assert.Equal("n", tags[2].GetProperty("name").GetString());
    }

    [Theory]
    [InlineData("""{"operations":[{"op":"\ud842"}]}""", "unknown_operation")]
    [InlineData("""{"operations":[{"op":"findTermsBulk","termList":[],"dictionaries":[],"matchType":"\ud842"}]}""", "invalid_request")]
    public void A_lone_surrogate_in_a_keyword_is_a_bad_request_not_a_crash(string body, string code)
    {
        using var test = new TestStore();
        using var request = JsonDocument.Parse(body);
        Assert.Equal(code, Assert.Throws<QueryException>(() => test.Query.Execute(request.RootElement)).Code);
    }

    [Fact]
    public void Unknown_titles_and_empty_lists_match_nothing()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", """[["語","ご","","",0,[],1,""]]"""));
        using var results = test.RunAll(
            new { op = "findTermsBulk", termList = new[] { "語" }, dictionaries = new[] { "Nope" }, matchType = "exact" },
            new { op = "findTermsBulk", termList = new[] { "語" }, dictionaries = Array.Empty<string>(), matchType = "exact" },
            new { op = "findTermsBulk", termList = Array.Empty<string>(), dictionaries = Sample, matchType = "exact" },
            new { op = "findTermsBySequenceBulk", items = new[] { new { query = 1, dictionary = "Nope" } } });
        foreach (var result in results.RootElement.GetProperty("results").EnumerateArray())
        {
            Assert.Equal(0, result.GetProperty("rows").GetArrayLength());
            Assert.False(result.GetProperty("truncated").GetBoolean());
        }
    }

    [Fact]
    public void Tag_results_line_up_with_items_and_a_miss_is_null()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("tag_bank_1.json", """[["n","noun",1,"Noun",2],["n","second",9,"",0]]"""));
        var rows = test.Run(new { op = "findTagMetaBulk", items = new[] { new { query = "x", dictionary = "Sample" }, new { query = "n", dictionary = "Sample" }, new { query = "n", dictionary = "Nope" } } }).GetProperty("rows");
        Assert.Equal(JsonValueKind.Null, rows[0].ValueKind);
        Assert.Equal("noun", rows[1].GetProperty("category").GetString());
        Assert.Equal(JsonValueKind.Null, rows[2].ValueKind);
    }

    [Fact]
    public void Old_index_tags_are_added_once_per_tag_bank_and_lost_without_one()
    {
        using var test = new TestStore();
        const string Index = """{"title":"Tags","format":3,"revision":"1","tagMeta":{"old":{"category":"c"}}}""";
        var withBanks = test.Import(("index.json", Index), ("tag_bank_1.json", "[]"), ("tag_bank_2.json", "[]"));
        Assert.Equal(2, withBanks.Counts["tagMeta"]["total"]);
        var row = test.Run(new { op = "findTagMetaBulk", items = new[] { new { query = "old", dictionary = "Tags" } } }).GetProperty("rows")[0];
        Assert.Equal("c", row.GetProperty("category").GetString());
        Assert.False(row.TryGetProperty("order", out _));

        var without = test.Import(("index.json", Index.Replace("\"Tags\"", "\"NoBanks\"", StringComparison.Ordinal)));
        Assert.Equal(0, without.Counts["tagMeta"]["total"]);
    }

    [Fact]
    public void One_request_can_batch_every_kind_of_operation()
    {
        using var test = new TestStore();
        test.Import(test.WriteZip(YomitanData.Files("valid-dictionary1")));
        var dictionaries = new[] { "Test Dictionary" };
        using var results = test.RunAll(
            new { op = "getDictionaryInfo" },
            new { op = "findTermsBulk", termList = new[] { "打つ" }, dictionaries, matchType = "exact" },
            new { op = "findTermsExactBulk", termList = new[] { new { term = "打つ", reading = "うつ" } }, dictionaries },
            new { op = "findTermsBySequenceBulk", items = new[] { new { query = 2, dictionary = dictionaries[0] } } },
            new { op = "findTermMetaBulk", termList = new[] { "打つ" }, dictionaries },
            new { op = "findKanjiBulk", kanjiList = new[] { "打" }, dictionaries },
            new { op = "findKanjiMetaBulk", kanjiList = new[] { "打" }, dictionaries },
            new { op = "findTagMetaBulk", items = new[] { new { query = "E1", dictionary = dictionaries[0] } } });
        var counts = results.RootElement.GetProperty("results").EnumerateArray().Select(r => r.GetProperty("rows").GetArrayLength()).ToArray();
        Assert.Equal(8, counts.Length);
        Assert.All(counts, count => Assert.True(count > 0));
    }

    [Theory]
    [InlineData("[]", "invalid_request")]
    [InlineData("""{"operations":{}}""", "invalid_request")]
    [InlineData("""{"operations":[1]}""", "invalid_request")]
    [InlineData("""{"operations":[{"op":"dropTables"}]}""", "unknown_operation")]
    [InlineData("""{"operations":[{"op":"findTermsBulk","termList":["a"],"dictionaries":[],"matchType":"regex"}]}""", "invalid_request")]
    [InlineData("""{"operations":[{"op":"findTermsBulk","termList":[1],"dictionaries":[],"matchType":"exact"}]}""", "invalid_request")]
    [InlineData("""{"operations":[{"op":"findTermsExactBulk","termList":[{"term":"a"}],"dictionaries":[]}]}""", "invalid_request")]
    [InlineData("""{"operations":[{"op":"findTermsBySequenceBulk","items":[{"query":"1","dictionary":"a"}]}]}""", "invalid_request")]
    public void Malformed_requests_are_refused(string body, string code)
    {
        using var test = new TestStore();
        using var request = JsonDocument.Parse(body);
        Assert.Equal(code, Assert.Throws<QueryException>(() => test.Query.Execute(request.RootElement)).Code);
    }

    [Fact]
    public void Batch_limits_are_enforced()
    {
        using var test = new TestStore();
        var operation = new { op = "getDictionaryInfo" };
        var tooManyOperations = Enumerable.Repeat<object>(operation, QueryLimits.MaxOperations + 1).ToArray();
        Assert.Equal("too_many_operations", Assert.Throws<QueryException>(() => test.RunAll(tooManyOperations)).Code);

        var terms = Enumerable.Repeat("a", (QueryLimits.MaxItems / 2) + 1).ToArray();
        var half = new { op = "findTermMetaBulk", termList = terms, dictionaries = Sample };
        Assert.Equal("too_many_items", Assert.Throws<QueryException>(() => test.RunAll(half, half)).Code);

        var titles = Enumerable.Repeat("a", QueryLimits.MaxDictionaries + 1).ToArray();
        Assert.Equal("too_many_dictionaries", Assert.Throws<QueryException>(() => test.Run(new { op = "findKanjiBulk", kanjiList = new[] { "a" }, dictionaries = titles })).Code);
    }

    /// <summary>The largest batch allowed, far past the 999 parameters some SQLite builds stop at.</summary>
    [Fact]
    public void The_largest_batch_works_and_finds_the_last_item()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", """[["末","まつ","","",0,["end"],1,""]]"""));
        var terms = Enumerable.Range(0, QueryLimits.MaxItems - 1).Select(i => $"t{i}").Append("末").ToArray();
        var row = Assert.Single(test.Run(new { op = "findTermsBulk", termList = terms, dictionaries = Sample, matchType = "exact" }).GetProperty("rows").EnumerateArray());
        Assert.Equal(QueryLimits.MaxItems - 1, row.GetProperty("index").GetInt32());
    }

    [Fact]
    public void Row_budget_cuts_results_short_and_says_so()
    {
        using var test = new TestStore();
        var rows = string.Join(',', Enumerable.Range(0, QueryLimits.MaxRows + 10).Select(i => $"""["あ{i}","あ","","",0,[],{i},""]"""));
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", $"[{rows}]"));

        using var results = test.RunAll(
            new { op = "findTermsBulk", termList = new[] { "あ" }, dictionaries = Sample, matchType = "prefix" },
            new { op = "findKanjiBulk", kanjiList = new[] { "あ" }, dictionaries = Sample },
            new { op = "getDictionaryInfo" });
        var list = results.RootElement.GetProperty("results");
        Assert.True(list[0].GetProperty("truncated").GetBoolean());
        Assert.Equal(QueryLimits.MaxRows, list[0].GetProperty("rows").GetArrayLength());
        Assert.True(list[1].GetProperty("truncated").GetBoolean());
        Assert.Equal(1, list[2].GetProperty("rows").GetArrayLength());
    }

    [Fact]
    public void Byte_budget_cuts_results_short_and_says_so()
    {
        using var test = new TestStore();
        var glossary = new string('x', 1024 * 1024);
        var rows = string.Join(',', Enumerable.Range(0, 40).Select(i => $"""["語","ご","","",0,["{glossary}"],{i},""]"""));
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", $"[{rows}]"));

        var result = test.Run(new { op = "findTermsBulk", termList = new[] { "語" }, dictionaries = Sample, matchType = "exact" });

        Assert.True(result.GetProperty("truncated").GetBoolean());
        Assert.InRange(result.GetProperty("rows").GetArrayLength(), 1, (QueryLimits.MaxResponseBytes / glossary.Length) + 1);
    }

    [Fact]
    public void Time_budget_cuts_results_short_and_says_so()
    {
        using var test = new TestStore();
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", """[["語","ご","","",0,[],1,""]]"""));
        var query = new DictionaryQuery(test.Store) { MaxDuration = TimeSpan.Zero };

        using var request = JsonDocument.Parse("""{"operations":[{"op":"findTermsBulk","termList":["語"],"dictionaries":["Sample"],"matchType":"exact"}]}""");
        using var response = JsonDocument.Parse(query.Execute(request.RootElement));

        var result = response.RootElement.GetProperty("results")[0];
        Assert.True(result.GetProperty("truncated").GetBoolean());
        Assert.Equal(0, result.GetProperty("rows").GetArrayLength());
    }

    /// <summary>The visited set can swallow a full page, so the budget alone would not notice the cut.</summary>
    [Fact]
    public void A_full_page_of_rows_already_seen_still_counts_as_truncated()
    {
        using var test = new TestStore();
        var rows = string.Join(',', Enumerable.Range(0, QueryLimits.MaxRows + 10).Select(i => $"""["あ{i}","あ","","",0,[],{i},""]"""));
        test.Import(("index.json", TestStore.SampleIndex), ("term_bank_1.json", $"[{rows}]"));

        // Asking for "あ1" first takes the budget's first bite, then "あ" reads a page full of repeats.
        var result = test.Run(new { op = "findTermsBulk", termList = new[] { "あ1", "あ" }, dictionaries = Sample, matchType = "prefix" });
        Assert.True(result.GetProperty("truncated").GetBoolean());
    }
}
