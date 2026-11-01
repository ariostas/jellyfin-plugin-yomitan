namespace Jellyfin.Plugin.Yomitan.Web;

/// <summary>The client scripts embedded in the plugin assembly.</summary>
public sealed class ClientBundle
{
    /// <summary>Initializes a new instance of the <see cref="ClientBundle"/> class.</summary>
    public ClientBundle()
    {
        Client = new ClientScript("Jellyfin.Plugin.Yomitan.client.js");
        Engine = new ClientScript("Jellyfin.Plugin.Yomitan.engine.js");
        SettingsPage = new ClientScript("Jellyfin.Plugin.Yomitan.settings-page.js");
    }

    /// <summary>Gets the small loader that every page gets.</summary>
    public ClientScript Client { get; }

    /// <summary>Gets the engine, which the loader fetches when a video starts.</summary>
    public ClientScript Engine { get; }

    /// <summary>Gets a user's settings page, which the loader fetches when someone opens it.</summary>
    public ClientScript SettingsPage { get; }
}
