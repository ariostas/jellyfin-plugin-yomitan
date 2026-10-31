using Jellyfin.Plugin.Yomitan.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Yomitan;

/// <summary>Plugin entry point.</summary>
public class Plugin : BasePlugin<PluginConfiguration>
{
    /// <summary>Initializes a new instance of the <see cref="Plugin"/> class.</summary>
    /// <param name="applicationPaths">Server paths.</param>
    /// <param name="xmlSerializer">Configuration serializer.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
    }

    /// <inheritdoc />
    public override string Name => "Yomitan";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("95f2db49-f966-44b9-a94f-4784792339fb");
}
