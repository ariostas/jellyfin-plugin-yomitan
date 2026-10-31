using Jellyfin.Plugin.Yomitan.Web;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Yomitan.Api;

/// <summary>Serves the client script.</summary>
[ApiController]
[Route("Yomitan")]
public class ClientController : ControllerBase
{
    private readonly ClientBundle _bundle;

    /// <summary>Initializes a new instance of the <see cref="ClientController"/> class.</summary>
    /// <param name="bundle">The embedded client script.</param>
    public ClientController(ClientBundle bundle)
    {
        _bundle = bundle;
    }

    /// <summary>Gets the client script. Anonymous, because it loads with the page, before login.</summary>
    /// <param name="v">Version from the injected script tag. A match means the URL can be cached for good.</param>
    /// <returns>The script.</returns>
    [HttpGet("client.js")]
    [AllowAnonymous]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult GetClient([FromQuery] string? v)
    {
        Response.Headers.CacheControl = string.Equals(v, _bundle.Version, StringComparison.Ordinal)
            ? "public, max-age=31536000, immutable"
            : "no-cache";

        return File(
            _bundle.Content,
            "text/javascript; charset=utf-8",
            lastModified: null,
            new EntityTagHeaderValue($"\"{_bundle.Version}\""));
    }
}
