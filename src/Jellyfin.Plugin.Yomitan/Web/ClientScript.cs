using System.Reflection;
using System.Security.Cryptography;

namespace Jellyfin.Plugin.Yomitan.Web;

/// <summary>One embedded script and the hash it is served under.</summary>
public sealed class ClientScript
{
    /// <summary>Initializes a new instance of the <see cref="ClientScript"/> class.</summary>
    /// <param name="resourceName">Name of the embedded resource.</param>
    public ClientScript(string resourceName)
    {
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(resourceName)
            ?? throw new InvalidOperationException($"Embedded resource {resourceName} is missing.");
        using var memory = new MemoryStream();
        resource.CopyTo(memory);

        Content = memory.ToArray();
        Version = Convert.ToHexStringLower(SHA256.HashData(Content))[..16];
    }

    /// <summary>Gets the script.</summary>
    public byte[] Content { get; }

    /// <summary>Gets a hash of the script, used as its ETag and as the cache-busting query string.</summary>
    public string Version { get; }
}
