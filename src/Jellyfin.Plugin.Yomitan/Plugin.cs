using Jellyfin.Plugin.Yomitan.Configuration;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Yomitan;

/// <summary>Plugin entry point.</summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    /// <summary>Initializes a new instance of the <see cref="Plugin"/> class.</summary>
    /// <param name="applicationPaths">Server paths.</param>
    /// <param name="xmlSerializer">Configuration serializer.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <summary>Gets the running plugin, which the server creates after the service container.</summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "Yomitan";

    /// <inheritdoc />
    public override Guid Id => Guid.Parse("95f2db49-f966-44b9-a94f-4784792339fb");

    /// <summary>
    /// Gets the dashboard page and its script. jellyfin-web only routes these for admins, and the page is plain markup
    /// that holds no data. Each user's own settings are in the client, because a non-admin cannot reach this route.
    /// </summary>
    /// <returns>The pages, by the name in their URL.</returns>
    public IEnumerable<PluginPageInfo> GetPages() =>
    [
        new PluginPageInfo
        {
            Name = "yomitan",
            DisplayName = "Yomitan",
            EmbeddedResourcePath = "Jellyfin.Plugin.Yomitan.admin.html",
            EnableInMainMenu = true,
            MenuIcon = "translate",
        },
        new PluginPageInfo
        {
            Name = "yomitan-admin.js",
            EmbeddedResourcePath = "Jellyfin.Plugin.Yomitan.admin.js",
        },
    ];
}
