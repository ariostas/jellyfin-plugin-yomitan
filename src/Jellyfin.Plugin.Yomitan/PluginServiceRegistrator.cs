using Jellyfin.Plugin.Yomitan.Injection;
using Jellyfin.Plugin.Yomitan.Web;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Yomitan;

/// <summary>Registers the plugin's services with the server.</summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<ClientBundle>();
        serviceCollection.AddTransient<IStartupFilter, IndexInjectionStartupFilter>();
    }
}
