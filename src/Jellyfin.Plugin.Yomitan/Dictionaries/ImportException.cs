namespace Jellyfin.Plugin.Yomitan.Dictionaries;

/// <summary>An import or delete that failed for a reason worth telling the admin.</summary>
public sealed class ImportException : Exception
{
    /// <summary>Initializes a new instance of the <see cref="ImportException"/> class.</summary>
    /// <param name="code">Stable error code, listed in docs/api.md.</param>
    /// <param name="message">Human-readable detail.</param>
    public ImportException(string code, string message)
        : base(message)
    {
        Code = code;
    }

    /// <summary>Gets the stable error code.</summary>
    public string Code { get; }
}
