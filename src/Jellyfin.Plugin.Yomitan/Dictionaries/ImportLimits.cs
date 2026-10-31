namespace Jellyfin.Plugin.Yomitan.Dictionaries;

/// <summary>Bounds on what an import may consume. The defaults fit the largest dictionaries in common use.</summary>
public sealed record ImportLimits
{
    private const long MiB = 1024 * 1024;
    private const long GiB = 1024 * MiB;

    /// <summary>Gets the largest upload accepted.</summary>
    public long MaxUploadBytes { get; init; } = 4 * GiB;

    /// <summary>Gets the most that may be decompressed from one archive.</summary>
    public long MaxDecompressedBytes { get; init; } = 8 * GiB;

    /// <summary>Gets the most entries an archive may have.</summary>
    public int MaxEntries { get; init; } = 200_000;

    /// <summary>Gets the largest decompressed bank file. A bank is held in memory while it is imported.</summary>
    public long MaxBankBytes { get; init; } = 256 * MiB;

    /// <summary>Gets the largest decompressed image.</summary>
    public long MaxMediaBytes { get; init; } = 32 * MiB;

    /// <summary>Gets the largest decompressed index.json or styles.css.</summary>
    public long MaxMetadataBytes { get; init; } = 4 * MiB;
}
