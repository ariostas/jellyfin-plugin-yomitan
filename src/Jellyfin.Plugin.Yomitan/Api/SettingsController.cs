using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Plugin.Yomitan.Settings;
using MediaBrowser.Controller.Net;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Yomitan.Api;

/// <summary>
/// The signed-in user's own settings. Neither route takes a user id in any form: whose settings these are comes from
/// the token alone, so nobody can name somebody else's, admins included. docs/api.md is the contract.
/// </summary>
[ApiController]
[Route("Yomitan")]
public class SettingsController : ControllerBase
{
    private const string Json = "application/json; charset=utf-8";

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly SettingsStore _store;
    private readonly IAuthorizationContext _authorization;

    /// <summary>Initializes a new instance of the <see cref="SettingsController"/> class.</summary>
    /// <param name="store">The settings.</param>
    /// <param name="authorization">Tells who the token belongs to.</param>
    public SettingsController(SettingsStore store, IAuthorizationContext authorization)
    {
        _store = store;
        _authorization = authorization;
    }

    /// <summary>Gets the signed-in user's settings.</summary>
    /// <returns>Every setting, and the revision.</returns>
    [HttpGet("Settings")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> GetSettings()
    {
        var userId = await GetUserId().ConfigureAwait(false);
        return userId is { } id ? Describe(_store.Get(id)) : NoUser();
    }

    /// <summary>Saves the settings named in the body. Those not named stay as they are.</summary>
    /// <returns>Every setting as saved, and the revision.</returns>
    [HttpPut("Settings")]
    [Authorize]
    [RequestSizeLimit(SettingsValidator.MaxRequestBytes)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> PutSettings()
    {
        if (await GetUserId().ConfigureAwait(false) is not { } userId)
        {
            return NoUser();
        }

        JsonDocument document;
        try
        {
            document = await JsonDocument.ParseAsync(Request.Body, default, HttpContext.RequestAborted).ConfigureAwait(false);
        }
        catch (JsonException e)
        {
            return Error(StatusCodes.Status400BadRequest, "invalid_json", e.Message);
        }
        catch (BadHttpRequestException e) when (e.StatusCode == StatusCodes.Status413PayloadTooLarge)
        {
            return Error(StatusCodes.Status413PayloadTooLarge, "limit_exceeded", $"Settings are limited to {SettingsValidator.MaxRequestBytes} bytes");
        }

        using (document)
        {
            try
            {
                return Describe(_store.Update(userId, SettingsValidator.Parse(document.RootElement)));
            }
            catch (SettingsException e)
            {
                return Error(StatusCodes.Status400BadRequest, e.Code, e.Message);
            }
        }
    }

    /// <summary>Gets the user the token belongs to. An API key belongs to nobody.</summary>
    private async Task<Guid?> GetUserId()
    {
        var info = await _authorization.GetAuthorizationInfo(HttpContext).ConfigureAwait(false);
        return info.IsAuthenticated && !info.IsApiKey && !info.UserId.Equals(Guid.Empty) ? info.UserId : null;
    }

    private ContentResult NoUser()
        => Error(StatusCodes.Status400BadRequest, "no_user", "Settings belong to a user, and this token has none");

    private ContentResult Describe(UserSettings settings)
    {
        Response.Headers[HeaderNames.CacheControl] = "no-store";
        return JsonResult(new { revision = settings.Revision, settings = settings.Values }, StatusCodes.Status200OK);
    }

    private ContentResult JsonResult(object value, int status)
        => new() { Content = JsonSerializer.Serialize(value, SerializerOptions), ContentType = Json, StatusCode = status };

    private ContentResult Error(int status, string code, string message)
        => JsonResult(new { error = new { code, message } }, status);
}
