using Jellyfin.Plugin.Yomitan.Dictionaries;
using Jellyfin.Plugin.Yomitan.Injection;
using Jellyfin.Plugin.Yomitan.Settings;
using Jellyfin.Plugin.Yomitan.Web;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;

namespace Jellyfin.Plugin.Yomitan;

/// <summary>Registers the plugin's services with the server.</summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<ClientBundle>();
        serviceCollection.AddTransient<IStartupFilter, IndexInjectionStartupFilter>();

        serviceCollection.AddSingleton(services =>
            new DictionaryStore(Path.Combine(services.GetRequiredService<IApplicationPaths>().DataPath, "yomitan")));
        serviceCollection.AddSingleton(services =>
            new SettingsStore(Path.Combine(services.GetRequiredService<IApplicationPaths>().DataPath, "yomitan")));
        serviceCollection.AddSingleton<DictionaryQuery>();
        serviceCollection.AddSingleton<JobQueue>();
        serviceCollection.AddSingleton<Func<ImportLimits>>(() => Plugin.Instance?.Configuration.ToLimits() ?? new ImportLimits());
        serviceCollection.AddSingleton<Func<DictionaryStore>>(services => services.GetRequiredService<DictionaryStore>);
        serviceCollection.AddSingleton<IHostedService, JobWorker>();
    }
}
