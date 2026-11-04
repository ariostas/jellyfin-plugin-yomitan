using System.Text.Json;

namespace Jellyfin.Plugin.Yomitan.Settings;

/// <summary>A settings request that is refused, with a stable code from docs/api.md.</summary>
public sealed class SettingsException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="SettingsException"/> class.</summary>
    /// <param name="code">Stable error code.</param>
    /// <param name="message">Human-readable detail.</param>
    public SettingsException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    /// <summary>Gets the stable error code.</summary>
    public string Code { get; }
}

/// <summary>
/// The one description of a user's settings: their names, defaults and bounds. Everything a client sends passes
/// through here before it is stored, and so does everything read back, so a bound tightened in a later version
/// cannot hand an old value to a client.
/// </summary>
public static class SettingsValidator
{
    /// <summary>The largest body accepted.</summary>
    public const int MaxRequestBytes = 1 << 20;

    /// <summary>The most titles a list can hold. It matches the query API's limit on one operation.</summary>
    public const int MaxDictionaries = 256;

    /// <summary>The longest dictionary title, in UTF-16 units.</summary>
    public const int MaxTitleLength = 4096;

    /// <summary>The longest hover delay or grace period, in milliseconds.</summary>
    public const int MaxHoverMs = 5000;

    /// <summary>The smallest font scale, in percent.</summary>
    public const int MinFontScale = 50;

    /// <summary>The largest font scale, in percent.</summary>
    public const int MaxFontScale = 300;

    private static readonly Dictionary<string, Func<JsonElement, object?>> Readers = new(StringComparer.Ordinal)
    {
        ["enabled"] = element => ReadBoolean("enabled", element),
        ["hoverDelayMs"] = element => ReadInteger("hoverDelayMs", element, 0, MaxHoverMs),
        ["hoverGraceMs"] = element => ReadInteger("hoverGraceMs", element, 0, MaxHoverMs),
        ["upOnlyEntry"] = element => ReadChoice("upOnlyEntry", element),
        ["fontScale"] = element => ReadInteger("fontScale", element, MinFontScale, MaxFontScale),
        ["dictionaryOrder"] = element => ReadTitles("dictionaryOrder", element),
        ["disabledDictionaries"] = element => ReadTitles("disabledDictionaries", element),
        ["introSeen"] = element => ReadBoolean("introSeen", element),
    };

    /// <summary>Gets a new copy of the defaults. A user who has saved nothing has exactly these.</summary>
    /// <returns>Every setting, by name, in the order documented.</returns>
    public static Dictionary<string, object?> Defaults() => new(StringComparer.Ordinal)
    {
        ["enabled"] = false,
        ["hoverDelayMs"] = 200,
        ["hoverGraceMs"] = 300,
        // Not chosen yet, so the client goes by the layout: Up only, apart from jellyfin-web's TV layout.
        ["upOnlyEntry"] = null,
        ["fontScale"] = 100,
        ["dictionaryOrder"] = Array.Empty<string>(),
        ["disabledDictionaries"] = Array.Empty<string>(),
        ["introSeen"] = false,
    };

    /// <summary>Checks a request. One bad value refuses all of it.</summary>
    /// <param name="body">The request's root element.</param>
    /// <returns>The values it sets, by name.</returns>
    /// <exception cref="SettingsException">If anything is not as documented.</exception>
    public static Dictionary<string, object?> Parse(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object)
        {
            throw new SettingsException("invalid_request", "The body must be a JSON object");
        }

        var values = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (var property in body.EnumerateObject())
        {
            if (!Readers.TryGetValue(property.Name, out var reader))
            {
                throw new SettingsException("unknown_setting", $"There is no setting called \"{property.Name}\"");
            }

            if (!values.TryAdd(property.Name, reader(property.Value)))
            {
                throw new SettingsException("invalid_request", $"\"{property.Name}\" appears twice");
            }
        }

        return values;
    }

    /// <summary>Reads what was stored, on top of the defaults. A value that no longer passes is left out.</summary>
    /// <param name="stored">The JSON from the store, or null if the user has none.</param>
    /// <returns>Every setting, by name.</returns>
    public static Dictionary<string, object?> Restore(string? stored)
    {
        var values = Defaults();
        if (stored is null)
        {
            return values;
        }

        using var document = JsonDocument.Parse(stored);
        foreach (var property in document.RootElement.EnumerateObject())
        {
            if (Readers.TryGetValue(property.Name, out var reader))
            {
                try
                {
                    values[property.Name] = reader(property.Value);
                }
                catch (SettingsException)
                {
                    // It stays at its default, and the next save of this setting replaces it.
                }
            }
        }

        return values;
    }

    private static bool ReadBoolean(string name, JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        _ => throw new SettingsException("invalid_setting", $"{name} must be true or false"),
    };

    private static bool? ReadChoice(string name, JsonElement element) => element.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.False => false,
        JsonValueKind.Null => null,
        _ => throw new SettingsException("invalid_setting", $"{name} must be true, false or null"),
    };

    private static int ReadInteger(string name, JsonElement element, int minimum, int maximum)
    {
        if (element.ValueKind != JsonValueKind.Number || !element.TryGetInt32(out var value) || value < minimum || value > maximum)
        {
            throw new SettingsException("invalid_setting", $"{name} must be a whole number from {minimum} to {maximum}");
        }

        return value;
    }

    private static string[] ReadTitles(string name, JsonElement element)
    {
        if (element.ValueKind != JsonValueKind.Array)
        {
            throw new SettingsException("invalid_setting", $"{name} must be an array of dictionary titles");
        }

        if (element.GetArrayLength() > MaxDictionaries)
        {
            throw new SettingsException("invalid_setting", $"{name} can hold at most {MaxDictionaries} titles");
        }

        var titles = new List<string>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (var item in element.EnumerateArray())
        {
            // A title need not be installed: another admin can delete one while this user's page is open.
            if (item.ValueKind != JsonValueKind.String || !TryReadTitle(item, out var title))
            {
                throw new SettingsException("invalid_setting", $"{name} must hold titles of 1 to {MaxTitleLength} characters");
            }

            if (!seen.Add(title))
            {
                throw new SettingsException("invalid_setting", $"{name} holds a title twice");
            }

            titles.Add(title);
        }

        return [.. titles];
    }

    private static bool TryReadTitle(JsonElement item, out string title)
    {
        title = string.Empty;
        try
        {
            title = item.GetString()!;
        }
        catch (InvalidOperationException)
        {
            // A lone surrogate in an escape, which cannot be stored as UTF-8.
            return false;
        }

        return title.Length is > 0 and <= MaxTitleLength;
    }
}
