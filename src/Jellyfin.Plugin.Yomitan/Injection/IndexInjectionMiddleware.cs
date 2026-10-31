using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Primitives;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Yomitan.Injection;

/// <summary>
/// Adds the client script tag to the jellyfin-web index document as it passes through the pipeline.
/// </summary>
/// <remarks>
/// The body comes from the rest of the pipeline, never from disk, so edits made by anything downstream
/// (other plugins, for instance) survive. This runs from an <c>IStartupFilter</c>, which puts it outside the
/// server's <c>BaseUrl</c> mapping: <see cref="HttpRequest.Path"/> still includes the prefix here.
/// </remarks>
public sealed class IndexInjectionMiddleware
{
    /// <summary>Attribute that identifies our tag. If a response already has it, nothing is added.</summary>
    public const string TagMarker = "data-yomitan-client";

    // Without these gone, downstream could answer with compressed bytes, a 304 or a 206, none of which
    // can be edited. A browser that cached the page before the plugin was installed would then keep
    // revalidating that copy and never get the tag.
    private static readonly string[] _requestHeadersToHide =
    [
        HeaderNames.AcceptEncoding,
        HeaderNames.IfMatch,
        HeaderNames.IfModifiedSince,
        HeaderNames.IfNoneMatch,
        HeaderNames.IfRange,
        HeaderNames.IfUnmodifiedSince,
        HeaderNames.Range,
    ];

    private readonly RequestDelegate _next;
    private readonly ILogger<IndexInjectionMiddleware> _logger;
    private readonly string _webRoot;
    private readonly string _webIndex;
    private readonly byte[] _tag;
    private readonly byte[] _tagMarker = Encoding.ASCII.GetBytes(TagMarker);

    /// <summary>Initializes a new instance of the <see cref="IndexInjectionMiddleware"/> class.</summary>
    /// <param name="next">The rest of the pipeline.</param>
    /// <param name="logger">Logger.</param>
    /// <param name="baseUrl">The server's BaseUrl, empty if there is none.</param>
    /// <param name="clientVersion">Version for the script URL's query string.</param>
    public IndexInjectionMiddleware(
        RequestDelegate next,
        ILogger<IndexInjectionMiddleware> logger,
        string baseUrl,
        string clientVersion)
    {
        _next = next;
        _logger = logger;

        var prefix = baseUrl.TrimEnd('/');
        _webRoot = prefix + "/web/";
        _webIndex = prefix + "/web/index.html";

        // Both matched paths sit one level below the root, so this resolves under BaseUrl. Unlike a path
        // built from BaseUrl, it also survives a reverse proxy that serves the server under another prefix.
        _tag = Encoding.UTF8.GetBytes(
            $"<script defer {TagMarker} src=\"../Yomitan/client.js?v={clientVersion}\"></script>");
    }

    /// <summary>Handles a request.</summary>
    /// <param name="context">The request context.</param>
    /// <returns>A task that completes when the response has been written.</returns>
    public async Task InvokeAsync(HttpContext context)
    {
        if (!IsIndexRequest(context.Request))
        {
            await _next(context).ConfigureAwait(false);
            return;
        }

        var requestHeaders = context.Request.Headers;
        var hidden = _requestHeadersToHide.Select(name => (name, value: requestHeaders[name])).ToArray();
        foreach (var (name, _) in hidden)
        {
            requestHeaders.Remove(name);
        }

        var clientBody = context.Response.Body;
        using var buffer = new MemoryStream();
        context.Response.Body = buffer;
        try
        {
            await _next(context).ConfigureAwait(false);
        }
        finally
        {
            context.Response.Body = clientBody;
            foreach (var (name, value) in hidden.Where(h => !StringValues.IsNullOrEmpty(h.value)))
            {
                requestHeaders[name] = value;
            }
        }

        var response = context.Response;
        if (response.StatusCode != StatusCodes.Status200OK || !IsHtml(response.ContentType))
        {
            await clientBody.WriteAsync(buffer.GetBuffer().AsMemory(0, (int)buffer.Length), context.RequestAborted)
                .ConfigureAwait(false);
            return;
        }

        if (!StringValues.IsNullOrEmpty(response.Headers.ContentEncoding))
        {
            _logger.LogWarning(
                "Index document arrived with Content-Encoding {Encoding}, leaving it alone. The Yomitan client will not load.",
                response.Headers.ContentEncoding.ToString());
            await clientBody.WriteAsync(buffer.GetBuffer().AsMemory(0, (int)buffer.Length), context.RequestAborted)
                .ConfigureAwait(false);
            return;
        }

        var body = Inject(buffer.GetBuffer().AsSpan(0, (int)buffer.Length));

        // The downstream validators describe the original file and were not used, so replace them with
        // one for what the client actually gets.
        var etag = new EntityTagHeaderValue($"\"yomitan-{Convert.ToHexStringLower(SHA256.HashData(body))[..32]}\"");
        response.Headers.Remove(HeaderNames.LastModified);
        response.Headers.Remove(HeaderNames.AcceptRanges);
        response.Headers.ETag = etag.ToString();

        if (ClientHasCurrentCopy(context.Request, etag))
        {
            response.StatusCode = StatusCodes.Status304NotModified;
            response.ContentLength = null;
            response.ContentType = null;
            return;
        }

        response.ContentLength = body.Length;
        await clientBody.WriteAsync(body, context.RequestAborted).ConfigureAwait(false);
    }

    private static bool ClientHasCurrentCopy(HttpRequest request, EntityTagHeaderValue etag)
    {
        return request.GetTypedHeaders().IfNoneMatch.Any(
            candidate => candidate.Equals(EntityTagHeaderValue.Any) || candidate.Compare(etag, useStrongComparison: false));
    }

    private static bool IsHtml(string? contentType)
    {
        return contentType?.StartsWith("text/html", StringComparison.OrdinalIgnoreCase) == true;
    }

    private bool IsIndexRequest(HttpRequest request)
    {
        if (!HttpMethods.IsGet(request.Method))
        {
            return false;
        }

        var path = request.PathBase.Add(request.Path).Value;
        return string.Equals(path, _webRoot, StringComparison.OrdinalIgnoreCase)
            || string.Equals(path, _webIndex, StringComparison.OrdinalIgnoreCase);
    }

    private byte[] Inject(ReadOnlySpan<byte> html)
    {
        if (html.IndexOf(_tagMarker) >= 0)
        {
            return html.ToArray();
        }

        // Search on Latin-1 so string offsets are byte offsets. The bytes of "</body>" cannot occur inside
        // a multi-byte UTF-8 sequence, and splicing bytes leaves the rest of the document exactly as it was.
        var position = Encoding.Latin1.GetString(html).LastIndexOf("</body>", StringComparison.OrdinalIgnoreCase);
        if (position < 0)
        {
            _logger.LogWarning("Index document has no </body>, leaving it alone. The Yomitan client will not load.");
            return html.ToArray();
        }

        var result = new byte[html.Length + _tag.Length];
        html[..position].CopyTo(result);
        _tag.CopyTo(result.AsSpan(position));
        html[position..].CopyTo(result.AsSpan(position + _tag.Length));
        return result;
    }
}
