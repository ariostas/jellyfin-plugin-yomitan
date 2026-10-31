using Jellyfin.Plugin.Yomitan.Web;
using MediaBrowser.Common.Net;
using MediaBrowser.Controller.Configuration;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;

namespace Jellyfin.Plugin.Yomitan.Injection;

/// <summary>Adds <see cref="IndexInjectionMiddleware"/> to the front of the server's pipeline.</summary>
public class IndexInjectionStartupFilter : IStartupFilter
{
    private readonly IServerConfigurationManager _configuration;
    private readonly ClientBundle _bundle;

    /// <summary>Initializes a new instance of the <see cref="IndexInjectionStartupFilter"/> class.</summary>
    /// <param name="configuration">Server configuration.</param>
    /// <param name="bundle">The embedded client scripts.</param>
    public IndexInjectionStartupFilter(IServerConfigurationManager configuration, ClientBundle bundle)
    {
        _configuration = configuration;
        _bundle = bundle;
    }

    /// <inheritdoc />
    public Action<IApplicationBuilder> Configure(Action<IApplicationBuilder> next)
    {
        return app =>
        {
            // Read once, like the server: it maps BaseUrl while building this pipeline, so a change only
            // takes effect on restart, and that rebuilds this too.
            var baseUrl = _configuration.GetNetworkConfiguration().BaseUrl;
            app.UseMiddleware<IndexInjectionMiddleware>(baseUrl, _bundle.Client.Version);
            next(app);
        };
    }
}
