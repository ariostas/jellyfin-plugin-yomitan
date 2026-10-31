using System.Reflection;
using System.Security.Cryptography;

namespace Jellyfin.Plugin.Yomitan.Web;

/// <summary>The client script embedded in the plugin assembly.</summary>
public sealed class ClientBundle
{
    private const string ResourceName = "Jellyfin.Plugin.Yomitan.client.js";

    /// <summary>Initializes a new instance of the <see cref="ClientBundle"/> class.</summary>
    public ClientBundle()
    {
        using var resource = Assembly.GetExecutingAssembly().GetManifestResourceStream(ResourceName)
            ?? throw new InvalidOperationException($"Embedded resource {ResourceName} is missing.");
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
