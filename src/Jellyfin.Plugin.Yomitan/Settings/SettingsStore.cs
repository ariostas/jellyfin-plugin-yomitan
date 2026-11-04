using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Jellyfin.Plugin.Yomitan.Settings;

/// <summary>One user's settings, and how many times they have been saved.</summary>
/// <param name="Revision">Goes up with every save, so a client can tell an old answer from a new one.</param>
/// <param name="Values">Every setting, by name.</param>
public sealed record UserSettings(long Revision, IReadOnlyDictionary<string, object?> Values);

/// <summary>
/// Per-user settings, in a small SQLite file of their own. They stay out of the dictionary database because an import
/// holds that one's write transaction for minutes, and nobody should wait that long to save a checkbox. The key is
/// always the id Jellyfin authenticated, which callers get from the token and never from a request.
/// </summary>
public sealed class SettingsStore
{
    private const string Schema = """
        CREATE TABLE IF NOT EXISTS user_settings(
            user_id TEXT PRIMARY KEY NOT NULL,
            revision INTEGER NOT NULL,
            settings TEXT NOT NULL) WITHOUT ROWID;
        """;

    /// <summary>
    /// What the rows mean, in <c>user_version</c>. 0 is 0.1.0, where <c>upOnlyEntry</c> was false unless chosen. 1 lets
    /// it be null, for a user who has not chosen, which the client reads as the default for its layout.
    /// </summary>
    private const int FormatVersion = 1;

    private readonly string _connectionString;

    /// <summary>Initializes a new instance of the <see cref="SettingsStore"/> class.</summary>
    /// <param name="directory">Where the database goes. It is created if missing.</param>
    public SettingsStore(string directory)
    {
        Directory.CreateDirectory(directory);
        _connectionString = new SqliteConnectionStringBuilder
        {
            DataSource = Path.Combine(directory, "settings.db"),
            Pooling = true,
            DefaultTimeout = 30,
        }.ToString();

        using var connection = Open();
        using var command = connection.CreateCommand();
        command.CommandText = $"PRAGMA journal_mode = WAL; {Schema}";
        command.ExecuteNonQuery();
        Migrate(connection);
    }

    /// <summary>Gets a user's settings.</summary>
    /// <param name="userId">The authenticated user.</param>
    /// <returns>Their settings, or the defaults at revision 0.</returns>
    public UserSettings Get(Guid userId)
    {
        using var connection = Open();
        return Read(connection, null, userId);
    }

    /// <summary>
    /// Saves the named values and leaves the others as they are, in one transaction. Two devices that each change a
    /// different setting therefore both keep their change.
    /// </summary>
    /// <param name="userId">The authenticated user.</param>
    /// <param name="values">What <see cref="SettingsValidator.Parse"/> returned.</param>
    /// <returns>The settings as they are now.</returns>
    public UserSettings Update(Guid userId, IReadOnlyDictionary<string, object?> values)
    {
        using var connection = Open();
        // Immediate, so two saves queue up here and neither merges into what the other is replacing.
        using var transaction = connection.BeginTransaction(deferred: false);
        var current = Read(connection, transaction, userId);
        if (values.Count == 0)
        {
            return current;
        }

        var merged = new Dictionary<string, object?>(current.Values.ToDictionary(), StringComparer.Ordinal);
        foreach (var (name, value) in values)
        {
            merged[name] = value;
        }

        var revision = current.Revision + 1;
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = """
            INSERT INTO user_settings(user_id, revision, settings) VALUES($user, $revision, $settings)
            ON CONFLICT(user_id) DO UPDATE SET revision = excluded.revision, settings = excluded.settings
            """;
        command.Parameters.AddWithValue("$user", Key(userId));
        command.Parameters.AddWithValue("$revision", revision);
        command.Parameters.AddWithValue("$settings", JsonSerializer.Serialize(merged));
        command.ExecuteNonQuery();
        transaction.Commit();
        return new UserSettings(revision, merged);
    }

    private static string Key(Guid userId) => userId.ToString("N");

    /// <summary>
    /// Brings rows from an older plugin up to <see cref="FormatVersion"/>, once. A newer format is left alone: Restore
    /// already falls back to the default for any value it cannot read.
    /// </summary>
    private static void Migrate(SqliteConnection connection)
    {
        using var transaction = connection.BeginTransaction(deferred: false);
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "PRAGMA user_version";
        if (Convert.ToInt64(command.ExecuteScalar(), System.Globalization.CultureInfo.InvariantCulture) >= FormatVersion)
        {
            return;
        }

        // 0.1.0 stored every setting with every save, so a false here is nearly always the old default and not a
        // choice. It goes, and the user gets the new default. A true was a choice, and stays.
        var changed = new List<(string User, string Settings)>();
        command.CommandText = "SELECT user_id, settings FROM user_settings";
        using (var reader = command.ExecuteReader())
        {
            while (reader.Read())
            {
                if (WithoutOldDefault(reader.GetString(1)) is { } settings)
                {
                    changed.Add((reader.GetString(0), settings));
                }
            }
        }

        command.CommandText = "UPDATE user_settings SET settings = $settings WHERE user_id = $user";
        var user = command.Parameters.Add("$user", SqliteType.Text);
        var stored = command.Parameters.Add("$settings", SqliteType.Text);
        foreach (var row in changed)
        {
            user.Value = row.User;
            stored.Value = row.Settings;
            command.ExecuteNonQuery();
        }

        command.Parameters.Clear();
        command.CommandText = $"PRAGMA user_version = {FormatVersion}";
        command.ExecuteNonQuery();
        transaction.Commit();
    }

    /// <returns>The settings without a false <c>upOnlyEntry</c>, or null if there is nothing to change.</returns>
    private static string? WithoutOldDefault(string stored)
    {
        try
        {
            if (JsonNode.Parse(stored) is JsonObject settings && settings["upOnlyEntry"]?.GetValueKind() == JsonValueKind.False)
            {
                settings.Remove("upOnlyEntry");
                return settings.ToJsonString();
            }
        }
        catch (JsonException)
        {
            // Restore cannot read it either, so it is no worse for being left.
        }

        return null;
    }

    private static UserSettings Read(SqliteConnection connection, SqliteTransaction? transaction, Guid userId)
    {
        using var command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT revision, settings FROM user_settings WHERE user_id = $user";
        command.Parameters.AddWithValue("$user", Key(userId));
        using var reader = command.ExecuteReader();
        return reader.Read()
            ? new UserSettings(reader.GetInt64(0), SettingsValidator.Restore(reader.GetString(1)))
            : new UserSettings(0, SettingsValidator.Defaults());
    }

    private SqliteConnection Open()
    {
        var connection = new SqliteConnection(_connectionString);
        connection.Open();
        return connection;
    }
}
