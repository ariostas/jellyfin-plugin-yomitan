using System.Text.Json;
using Jellyfin.Plugin.Yomitan.Settings;
using Xunit;

namespace Jellyfin.Plugin.Yomitan.Tests;

public sealed class SettingsTests : IDisposable
{
    private readonly string _directory = Path.Combine(Path.GetTempPath(), "yomitan-tests", Guid.NewGuid().ToString("N"));

    public void Dispose()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        if (Directory.Exists(_directory))
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    private static Dictionary<string, object?> Parse(string json)
    {
        using var document = JsonDocument.Parse(json);
        return SettingsValidator.Parse(document.RootElement);
    }

    [Fact]
    public void AUserWithNothingSavedIsOff()
    {
        var store = new SettingsStore(_directory);
        var settings = store.Get(Guid.NewGuid());
        Assert.Equal(0, settings.Revision);
        Assert.Equal(false, settings.Values["enabled"]);
    }

    [Fact]
    public void OnlyUpStartsUnchosenAndTakesAChoiceEitherWay()
    {
        var store = new SettingsStore(_directory);
        var user = Guid.NewGuid();
        Assert.Null(store.Get(user).Values["upOnlyEntry"]);
        Assert.Equal(false, store.Update(user, Parse("""{"upOnlyEntry": false}""")).Values["upOnlyEntry"]);
        Assert.Equal(true, store.Update(user, Parse("""{"upOnlyEntry": true}""")).Values["upOnlyEntry"]);
        Assert.Null(store.Update(user, Parse("""{"upOnlyEntry": null}""")).Values["upOnlyEntry"]);
        Assert.Null(new SettingsStore(_directory).Get(user).Values["upOnlyEntry"]);
    }

    [Fact]
    public void OnlyUpSavedBy010GoesToTheNewDefaultUnlessItWasOn()
    {
        // As 0.1.0 left it: every setting in every row, upOnlyEntry false unless someone turned it on.
        var (untouched, chose) = (Guid.NewGuid(), Guid.NewGuid());
        Directory.CreateDirectory(_directory);
        using (var connection = new Microsoft.Data.Sqlite.SqliteConnection($"Data Source={Path.Combine(_directory, "settings.db")};Pooling=false"))
        {
            connection.Open();
            using var command = connection.CreateCommand();
            command.CommandText = $$"""
                CREATE TABLE user_settings(user_id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL, settings TEXT NOT NULL) WITHOUT ROWID;
                INSERT INTO user_settings VALUES('{{untouched:N}}', 3, '{"enabled":true,"hoverDelayMs":250,"hoverGraceMs":300,"upOnlyEntry":false,"fontScale":100,"dictionaryOrder":[],"disabledDictionaries":[]}');
                INSERT INTO user_settings VALUES('{{chose:N}}', 5, '{"enabled":false,"hoverDelayMs":200,"hoverGraceMs":300,"upOnlyEntry":true,"fontScale":100,"dictionaryOrder":[],"disabledDictionaries":[]}');
                """;
            command.ExecuteNonQuery();
        }

        var store = new SettingsStore(_directory);
        var first = store.Get(untouched);
        Assert.Null(first.Values["upOnlyEntry"]);
        Assert.Equal(3, first.Revision);
        Assert.Equal(true, first.Values["enabled"]);
        Assert.Equal(250, first.Values["hoverDelayMs"]);
        Assert.Equal(true, store.Get(chose).Values["upOnlyEntry"]);

        // Only once: a false chosen from now on is a choice.
        store.Update(untouched, Parse("""{"upOnlyEntry": false}"""));
        Assert.Equal(false, new SettingsStore(_directory).Get(untouched).Values["upOnlyEntry"]);
    }

    [Fact]
    public void SavesAreKeptPerUser()
    {
        var store = new SettingsStore(_directory);
        var (first, second) = (Guid.NewGuid(), Guid.NewGuid());
        store.Update(first, Parse("""{"fontScale": 150}"""));
        store.Update(second, Parse("""{"fontScale": 60}"""));
        Assert.Equal(150, store.Get(first).Values["fontScale"]);
        Assert.Equal(60, store.Get(second).Values["fontScale"]);
    }

    [Fact]
    public void ASaveLeavesWhatItDoesNotName()
    {
        var store = new SettingsStore(_directory);
        var user = Guid.NewGuid();
        store.Update(user, Parse("""{"disabledDictionaries": ["A"], "enabled": true}"""));
        var saved = store.Update(user, Parse("""{"fontScale": 120}"""));
        Assert.Equal(2, saved.Revision);
        Assert.Equal(true, saved.Values["enabled"]);
        Assert.Equal(new[] { "A" }, store.Get(user).Values["disabledDictionaries"]);
    }

    [Fact]
    public void SettingsSurviveReopening()
    {
        var user = Guid.NewGuid();
        new SettingsStore(_directory).Update(user, Parse("""{"hoverDelayMs": 700}"""));
        Assert.Equal(700, new SettingsStore(_directory).Get(user).Values["hoverDelayMs"]);
    }

    [Fact]
    public void AStoredValueThatNoLongerPassesGoesBackToItsDefault()
    {
        var values = SettingsValidator.Restore("""{"fontScale": 9000, "hoverDelayMs": 70, "retired": true}""");
        Assert.Equal(100, values["fontScale"]);
        Assert.Equal(70, values["hoverDelayMs"]);
        Assert.False(values.ContainsKey("retired"));
    }

    [Theory]
    [InlineData("[]")]
    [InlineData("null")]
    [InlineData("\"text\"")]
    [InlineData("{not json")]
    public void AStoredRowThatIsNotAnObjectReadsAsDefaults(string stored)
        => Assert.Equal(SettingsValidator.Defaults(), SettingsValidator.Restore(stored));

    [Theory]
    [InlineData("""{"fontScale": 49}""", "invalid_setting")]
    [InlineData("""{"enabled": "yes"}""", "invalid_setting")]
    [InlineData("""{"enabled": null}""", "invalid_setting")]
    [InlineData("""{"upOnlyEntry": "yes"}""", "invalid_setting")]
    [InlineData("""{"introSeen": null}""", "invalid_setting")]
    [InlineData("""{"dictionaryOrder": ["A", "A"]}""", "invalid_setting")]
    [InlineData("""{"dictionaryOrder": ["\ud800"]}""", "invalid_setting")]
    [InlineData("""{"nope": 1}""", "unknown_setting")]
    [InlineData("""[]""", "invalid_request")]
    [InlineData("""{"enabled": true, "enabled": true}""", "invalid_request")]
    public void BadValuesAreRefused(string json, string code)
    {
        var refused = Assert.Throws<SettingsException>(() => Parse(json));
        Assert.Equal(code, refused.Code);
    }
}
