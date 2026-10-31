using System.Buffers.Binary;
using System.IO.Compression;
using System.Text;
using Jellyfin.Plugin.Yomitan.Dictionaries;
using Xunit;

namespace Jellyfin.Plugin.Yomitan.Tests;

public class HostileArchiveTests
{
    private static readonly (string, string) Index = ("index.json", TestStore.SampleIndex);

    [Theory]
    [InlineData("../evil.png")]
    [InlineData("a/../../evil.png")]
    [InlineData("./evil.png")]
    [InlineData("/etc/passwd")]
    [InlineData("a\\..\\evil.png")]
    [InlineData("C:/evil.png")]
    [InlineData("nul\0.png")]
    [InlineData("line\nbreak.png")]
    public void An_unsafe_entry_name_refuses_the_whole_archive(string name)
    {
        using var test = new TestStore();
        var before = test.Fingerprint();
        var error = Assert.Throws<ImportException>(() => test.Import(Index, (name, "x")));
        Assert.Equal("unsafe_path", error.Code);
        Assert.Equal(before, test.Fingerprint());
    }

    [Theory]
    [InlineData("a.png", true)]
    [InlineData("img/sub dir/日本語.png", true)]
    [InlineData("a..b.png", true)]
    [InlineData("a/", true)]
    [InlineData("", false)]
    [InlineData("a/./b", false)]
    public void Name_rules(string name, bool safe) => Assert.Equal(safe, SafeArchive.IsSafeName(name));

    [Fact]
    public void Two_entries_with_one_name_are_refused()
    {
        using var test = new TestStore();
        var error = Assert.Throws<ImportException>(() => test.Import(Index, ("term_bank_1.json", "[]"), ("term_bank_1.json", "[]")));
        Assert.Equal("invalid_archive", error.Code);
    }

    [Fact]
    public void Not_a_zip_is_refused()
    {
        using var test = new TestStore();
        var path = test.NewPath();
        File.WriteAllText(path, new string('x', 5000));
        Assert.Equal("invalid_archive", Assert.Throws<ImportException>(() => test.Import(path)).Code);
        File.WriteAllText(path, "x");
        Assert.Equal("invalid_archive", Assert.Throws<ImportException>(() => test.Import(path)).Code);
    }

    [Fact]
    public void A_truncated_zip_is_refused()
    {
        using var test = new TestStore();
        var path = test.WriteZip(Index, ("term_bank_1.json", "[]"));
        var bytes = File.ReadAllBytes(path);
        File.WriteAllBytes(path, bytes[..(bytes.Length / 2)]);
        Assert.Equal("invalid_archive", Assert.Throws<ImportException>(() => test.Import(path)).Code);
    }

    [Fact]
    public void Too_many_entries_are_refused_before_they_are_loaded()
    {
        using var test = new TestStore();
        var entries = Enumerable.Range(0, 11).Select(i => ($"f{i}", "x")).Prepend(Index).ToArray();
        var error = Assert.Throws<ImportException>(() => test.Import(test.WriteZip(entries), limits: new ImportLimits { MaxEntries = 10 }));
        Assert.Equal("limit_exceeded", error.Code);
        Assert.Contains("entries", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_central_directory_of_huge_names_is_refused()
    {
        using var test = new TestStore();
        var entries = Enumerable.Range(0, 5).Select(i => ($"{new string('n', 2000)}{i}", "x")).Prepend(Index).ToArray();
        var error = Assert.Throws<ImportException>(() => test.Import(test.WriteZip(entries), limits: new ImportLimits { MaxEntries = 10 }));
        Assert.Equal("limit_exceeded", error.Code);
        Assert.Contains("central directory", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void A_bank_over_the_limit_is_refused_by_its_declared_size()
    {
        using var test = new TestStore();
        var bank = "[" + new string(' ', 5000) + "]";
        var error = Assert.Throws<ImportException>(() => test.Import(test.WriteZip(Index, ("term_bank_1.json", bank)), limits: new ImportLimits { MaxBankBytes = 4096 }));
        Assert.Equal("limit_exceeded", error.Code);
    }

    [Fact]
    public void Total_size_is_capped_by_declared_sizes_including_entries_never_read()
    {
        using var test = new TestStore();
        var error = Assert.Throws<ImportException>(() => test.Import(test.WriteZip(Index, ("junk.bin", new string('x', 50_000))), limits: new ImportLimits { MaxDecompressedBytes = 10_000 }));
        Assert.Equal("limit_exceeded", error.Code);
    }

    /// <summary>
    /// A deflated bomb that lies about its size. On this runtime the decompressor stops at the declared size, so
    /// what comes out is cut short and is no longer valid JSON.
    /// </summary>
    [Fact]
    public void A_deflated_bomb_with_a_false_size_is_cut_off_at_that_size()
    {
        using var test = new TestStore();
        var path = test.WriteZip(Index, ("term_bank_1.json", "[" + new string(' ', 2_000_000) + "]"));
        ForgeDeclaredSize(path, "term_bank_1.json", 10);

        Assert.Equal("invalid_bank", Assert.Throws<ImportException>(() => test.Import(path, limits: new ImportLimits { MaxBankBytes = 4096 })).Code);
    }

    /// <summary>
    /// A stored entry is read to its compressed length whatever size it declares, so nothing but counting real
    /// output stops this one.
    /// </summary>
    [Fact]
    public void A_stored_entry_with_a_false_size_is_stopped_by_counting()
    {
        using var test = new TestStore();
        var path = test.NewPath();
        using (var archive = ZipFile.Open(path, ZipArchiveMode.Create))
        {
            using (var stream = new StreamWriter(archive.CreateEntry("index.json", CompressionLevel.NoCompression).Open()))
            {
                stream.Write(TestStore.SampleIndex);
            }

            using (var stream = new StreamWriter(archive.CreateEntry("term_bank_1.json", CompressionLevel.NoCompression).Open()))
            {
                stream.Write("[" + new string(' ', 100_000) + "]");
            }
        }

        ForgeDeclaredSize(path, "term_bank_1.json", 10);

        var error = Assert.Throws<ImportException>(() => test.Import(path, limits: new ImportLimits { MaxBankBytes = 4096 }));
        Assert.Equal("limit_exceeded", error.Code);
        Assert.Contains("term_bank_1.json", error.Message, StringComparison.Ordinal);
    }

    [Fact]
    public void The_total_counts_real_output_across_every_read()
    {
        using var test = new TestStore();
        var path = test.WriteZip(("a.bin", new string(' ', 100_000)));
        using var file = File.OpenRead(path);
        using var archive = new SafeArchive(file, new ImportLimits { MaxDecompressedBytes = 150_000 });

        Assert.Equal(100_000, archive.ReadAllBytes(archive.Find("a.bin")!, 100_000).Length);
        Assert.Equal(100_000, archive.BytesRead);
        Assert.Equal("limit_exceeded", Assert.Throws<ImportException>(() => archive.ReadAllBytes(archive.Find("a.bin")!, 100_000)).Code);
    }

    [Theory]
    [InlineData("[[\"語\"]]")] // Too few columns.
    [InlineData("[")] // Truncated JSON.
    [InlineData("{}")] // Not an array.
    [InlineData("null")]
    [InlineData("[[\"語\",\"ご\",\"\",\"\",\"high\",[],1,\"\"]]")] // Score must be a number.
    [InlineData("[[\"語\",\"ご\",\"\",\"\",1e999,[],1,\"\"]]")] // Not a finite number.
    [InlineData("[[\"語\",\"ご\",\"\",\"\",0,[{\"type\":\"sound\"}],1,\"\"]]")] // Unknown glossary type.
    [InlineData("[[\"\\ud83d\",\"ご\",\"\",\"\",0,[],1,\"\"]]")] // A lone surrogate, which .NET strings refuse.
    public void A_malformed_bank_fails_cleanly(string bank)
    {
        using var test = new TestStore();
        var before = test.Fingerprint();
        var error = Assert.Throws<ImportException>(() => test.Import(Index, ("term_bank_1.json", """[["良","りょう","","",0,["good"],1,""]]"""), ("term_bank_2.json", bank)));
        Assert.Equal("invalid_bank", error.Code);
        Assert.Equal(before, test.Fingerprint());
    }

    [Fact]
    public void Nesting_past_the_depth_limit_fails_cleanly()
    {
        using var test = new TestStore();
        var deep = string.Concat(Enumerable.Repeat("""{"tag":"div","content":""", 5000)) + "\"x\"" + new string('}', 5000);
        var error = Assert.Throws<ImportException>(() => test.Import(Index, ("term_bank_1.json", """[["語","ご","","",0,[{"type":"structured-content","content":""" + deep + """}],1,""]]""")));
        Assert.Equal("invalid_bank", error.Code);
    }

    /// <summary>Rewrites an entry's uncompressed size in its local and central headers.</summary>
    private static void ForgeDeclaredSize(string path, string name, uint size)
    {
        var bytes = File.ReadAllBytes(path);
        var nameBytes = Encoding.UTF8.GetBytes(name);
        for (var i = 0; i + 46 < bytes.Length; i++)
        {
            var signature = BinaryPrimitives.ReadUInt32LittleEndian(bytes.AsSpan(i));
            if (signature == 0x04034b50 && bytes.AsSpan(i + 30).StartsWith(nameBytes))
            {
                BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(i + 22), size);
            }
            else if (signature == 0x02014b50 && bytes.AsSpan(i + 46).StartsWith(nameBytes))
            {
                BinaryPrimitives.WriteUInt32LittleEndian(bytes.AsSpan(i + 24), size);
            }
        }

        File.WriteAllBytes(path, bytes);
    }
}
