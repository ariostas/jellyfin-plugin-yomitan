using Jellyfin.Plugin.Yomitan.Dictionaries;
using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Yomitan.Configuration;

/// <summary>Plugin configuration: the bounds on dictionary imports. See <see cref="ImportLimits"/>.</summary>
public class PluginConfiguration : BasePluginConfiguration
{
    private static readonly ImportLimits Defaults = new();

    /// <summary>Gets or sets the largest upload accepted.</summary>
    public long MaxUploadBytes { get; set; } = Defaults.MaxUploadBytes;

    /// <summary>Gets or sets the most that may be decompressed from one archive.</summary>
    public long MaxDecompressedBytes { get; set; } = Defaults.MaxDecompressedBytes;

    /// <summary>Gets or sets the most entries an archive may have.</summary>
    public int MaxEntries { get; set; } = Defaults.MaxEntries;

    /// <summary>Gets or sets the largest decompressed bank file.</summary>
    public long MaxBankBytes { get; set; } = Defaults.MaxBankBytes;

    /// <summary>Gets or sets the largest decompressed image.</summary>
    public long MaxMediaBytes { get; set; } = Defaults.MaxMediaBytes;

    /// <summary>Gets or sets the largest decompressed index.json or styles.css.</summary>
    public long MaxMetadataBytes { get; set; } = Defaults.MaxMetadataBytes;

    /// <summary>Gets the limits as the importer takes them.</summary>
    /// <returns>The limits.</returns>
    public ImportLimits ToLimits() => new()
    {
        MaxUploadBytes = MaxUploadBytes,
        MaxDecompressedBytes = MaxDecompressedBytes,
        MaxEntries = MaxEntries,
        MaxBankBytes = MaxBankBytes,
        MaxMediaBytes = MaxMediaBytes,
        MaxMetadataBytes = MaxMetadataBytes,
    };
}
