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

    private static Dictionary<string, object> Parse(string json)
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
    [InlineData("""{"fontScale": 49}""", "invalid_setting")]
    [InlineData("""{"enabled": "yes"}""", "invalid_setting")]
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
