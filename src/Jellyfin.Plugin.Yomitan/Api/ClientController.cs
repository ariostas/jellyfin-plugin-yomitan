using Jellyfin.Plugin.Yomitan.Web;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Yomitan.Api;

/// <summary>Serves the client scripts.</summary>
[ApiController]
[Route("Yomitan")]
public class ClientController : ControllerBase
{
    private readonly ClientBundle _bundle;

    /// <summary>Initializes a new instance of the <see cref="ClientController"/> class.</summary>
    /// <param name="bundle">The embedded client scripts.</param>
    public ClientController(ClientBundle bundle)
    {
        _bundle = bundle;
    }

    /// <summary>Gets the loader. Anonymous, because it loads with the page, before login.</summary>
    /// <param name="v">Version from the injected script tag. A match means the URL can be cached for good.</param>
    /// <returns>The script.</returns>
    [HttpGet("client.js")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult GetClient([FromQuery] string? v) => ServeScript(_bundle.Client, v);

    /// <summary>
    /// Gets the engine. Anonymous like the loader: it is the same public code, and holds no data. Everything it
    /// asks the server for goes through the signed-in API.
    /// </summary>
    /// <param name="v">Version built into the loader. A match means the URL can be cached for good.</param>
    /// <returns>The script.</returns>
    [HttpGet("engine.js")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult GetEngine([FromQuery] string? v) => ServeScript(_bundle.Engine, v);

    /// <summary>Gets a user's settings page. Anonymous like the others, for the same reasons.</summary>
    /// <param name="v">Version built into the loader. A match means the URL can be cached for good.</param>
    /// <returns>The script.</returns>
    [HttpGet("settings-page.js")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult GetSettingsPage([FromQuery] string? v) => ServeScript(_bundle.SettingsPage, v);

    private FileContentResult ServeScript(ClientScript script, string? requestedVersion)
    {
        Response.Headers.CacheControl = string.Equals(requestedVersion, script.Version, StringComparison.Ordinal)
            ? "public, max-age=31536000, immutable"
            : "no-cache";

        return File(
            script.Content,
            "text/javascript; charset=utf-8",
            lastModified: null,
            new EntityTagHeaderValue($"\"{script.Version}\""));
    }
}
