using System.Net;
using System.Net.Http.Headers;
using System.Text;
using Jellyfin.Plugin.Yomitan.Injection;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.Hosting;
using Xunit;

namespace Jellyfin.Plugin.Yomitan.Tests;

public class IndexInjectionMiddlewareTests
{
    private const string Page = "<html><head></head><body><p>日本語</p></body></html>";
    private const string Tag = "<script defer data-yomitan-client src=\"../Yomitan/client.js?v=abc\"></script>";

    private static CancellationToken Cancel => TestContext.Current.CancellationToken;

    private static RequestDelegate Respond(string body, string contentType = "text/html") =>
        context =>
        {
            context.Response.ContentType = contentType;
            context.Response.ContentLength = Encoding.UTF8.GetByteCount(body);
            return context.Response.WriteAsync(body);
        };

    [Theory]
    [InlineData("", "/web/")]
    [InlineData("", "/web/index.html")]
    [InlineData("", "/WEB/")]
    [InlineData("/jf", "/jf/web/")]
    [InlineData("/jf", "/jf/web/index.html")]
    [InlineData("/jf/", "/jf/web/")]
    public async Task InjectsIntoIndexDocument(string baseUrl, string path)
    {
        using var client = Start(Respond(Page), baseUrl);

        var response = await client.GetAsync(path, Cancel);
        var bytes = await response.Content.ReadAsByteArrayAsync(Cancel);

        Assert.Equal(Page.Replace("</body>", Tag + "</body>", StringComparison.Ordinal), Encoding.UTF8.GetString(bytes));
        Assert.Equal(bytes.Length, response.Content.Headers.ContentLength);
    }

    [Theory]
    [InlineData("", "/")]
    [InlineData("", "/web")]
    [InlineData("", "/web/other.html")]
    [InlineData("", "/foo/web/")]
    [InlineData("/jf", "/web/")]
    [InlineData("/jf", "/web/index.html")]
    public async Task LeavesOtherPathsAlone(string baseUrl, string path)
    {
        using var client = Start(Respond(Page), baseUrl);

        Assert.Equal(Page, await client.GetStringAsync(path, Cancel));
    }

    [Fact]
    public async Task HonoursPathBaseSetByAnOuterComponent()
    {
        using var client = Start(
            Respond(Page),
            "/jf",
            before: app => app.Use((context, next) =>
            {
                context.Request.PathBase = "/jf";
                context.Request.Path = "/web/";
                return next();
            }));

        Assert.Contains(Tag, await client.GetStringAsync("/anything", Cancel), StringComparison.Ordinal);
    }

    [Fact]
    public async Task LeavesOtherMethodsAlone()
    {
        using var client = Start(Respond(Page));

        var response = await client.PostAsync("/web/", new StringContent(string.Empty), Cancel);

        Assert.Equal(Page, await response.Content.ReadAsStringAsync(Cancel));
    }

    [Theory]
    [InlineData("<html><body></body><!-- </body> --></html>", "<html><body></body><!-- " + Tag + "</body> --></html>")]
    [InlineData("<HTML><BODY></BODY></HTML>", "<HTML><BODY>" + Tag + "</BODY></HTML>")]
    public async Task InjectsBeforeTheLastClosingBody(string page, string expected)
    {
        using var client = Start(Respond(page));

        Assert.Equal(expected, await client.GetStringAsync("/web/", Cancel));
    }

    [Fact]
    public async Task DoesNotInjectTwice()
    {
        var alreadyTagged = Page.Replace("</body>", Tag + "</body>", StringComparison.Ordinal);
        using var client = Start(Respond(alreadyTagged));

        Assert.Equal(alreadyTagged, await client.GetStringAsync("/web/", Cancel));
    }

    [Fact]
    public async Task TwoInstancesInjectOnce()
    {
        using var client = Start(
            Respond(Page),
            between: app => app.UseMiddleware<IndexInjectionMiddleware>(string.Empty, "abc"));

        var html = await client.GetStringAsync("/web/", Cancel);

        Assert.Single(html.Split(IndexInjectionMiddleware.TagMarker)[1..]);
    }

    [Fact]
    public async Task LeavesADocumentWithoutBodyAlone()
    {
        using var client = Start(Respond("<html>"));

        Assert.Equal("<html>", await client.GetStringAsync("/web/", Cancel));
    }

    [Fact]
    public async Task HidesEncodingAndConditionalHeadersFromDownstreamOnly()
    {
        string? seenByDownstream = null;
        string? seenAfterwards = null;
        using var client = Start(
            context =>
            {
                seenByDownstream = string.Join(
                    ',',
                    new[] { "Accept-Encoding", "If-None-Match", "If-Modified-Since", "Range", "If-Range" }
                        .Where(name => context.Request.Headers.ContainsKey(name)));
                return Respond(Page)(context);
            },
            before: app => app.Use(async (context, next) =>
            {
                await next();
                seenAfterwards = context.Request.Headers.AcceptEncoding;
            }));

        using var request = new HttpRequestMessage(HttpMethod.Get, "/web/");
        request.Headers.TryAddWithoutValidation("Accept-Encoding", "br");
        request.Headers.TryAddWithoutValidation("If-None-Match", "\"stale\"");
        request.Headers.TryAddWithoutValidation("If-Modified-Since", "Mon, 26 Oct 2026 21:19:35 GMT");
        request.Headers.TryAddWithoutValidation("Range", "bytes=0-1");
        request.Headers.TryAddWithoutValidation("If-Range", "\"stale\"");
        await client.SendAsync(request, Cancel);

        Assert.Equal(string.Empty, seenByDownstream);
        Assert.Equal("br", seenAfterwards);
    }

    [Fact]
    public async Task PassesThroughACompressedBodyUntouched()
    {
        byte[] compressed = [0x1f, 0x8b, 0x08, 0x00];
        using var client = Start(context =>
        {
            context.Response.ContentType = "text/html";
            context.Response.Headers.ContentEncoding = "gzip";
            return context.Response.Body.WriteAsync(compressed).AsTask();
        });

        var response = await client.GetAsync("/web/", Cancel);

        Assert.Equal(compressed, await response.Content.ReadAsByteArrayAsync(Cancel));
        Assert.Equal("gzip", Assert.Single(response.Content.Headers.ContentEncoding));
    }

    [Fact]
    public async Task PassesThroughOtherStatusesAndContentTypes()
    {
        using var notFound = Start(context =>
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return Respond(Page)(context);
        });
        using var notHtml = Start(Respond(Page, "text/plain"));

        var response = await notFound.GetAsync("/web/", Cancel);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(Page, await response.Content.ReadAsStringAsync(Cancel));
        Assert.Equal(Page, await notHtml.GetStringAsync("/web/", Cancel));
    }

    [Fact]
    public async Task AnswersRevalidationWithItsOwnValidator()
    {
        using var client = Start(context =>
        {
            context.Response.Headers.ETag = "\"stock\"";
            context.Response.Headers.LastModified = "Mon, 26 Oct 2026 21:19:35 GMT";
            context.Response.Headers.AcceptRanges = "bytes";
            return Respond(Page)(context);
        });

        var first = await client.GetAsync("/web/", Cancel);
        var etag = first.Headers.ETag!;
        Assert.NotEqual("\"stock\"", etag.Tag);
        Assert.Null(first.Content.Headers.LastModified);
        Assert.Empty(first.Headers.AcceptRanges);

        using var matching = new HttpRequestMessage(HttpMethod.Get, "/web/");
        matching.Headers.IfNoneMatch.Add(etag);
        var second = await client.SendAsync(matching, Cancel);
        Assert.Equal(HttpStatusCode.NotModified, second.StatusCode);
        Assert.Empty(await second.Content.ReadAsByteArrayAsync(Cancel));
        Assert.Equal(etag, second.Headers.ETag);

        using var stale = new HttpRequestMessage(HttpMethod.Get, "/web/");
        stale.Headers.IfNoneMatch.Add(new EntityTagHeaderValue("\"stock\""));
        var third = await client.SendAsync(stale, Cancel);
        Assert.Equal(HttpStatusCode.OK, third.StatusCode);
    }

    [Fact]
    public async Task RestoresTheResponseBodyWhenDownstreamThrows()
    {
        Stream? bodyBefore = null;
        Stream? bodyAfter = null;
        using var client = Start(
            _ => throw new InvalidOperationException("boom"),
            before: app => app.Use(async (context, next) =>
            {
                bodyBefore = context.Response.Body;
                try
                {
                    await next();
                }
                catch (InvalidOperationException)
                {
                    bodyAfter = context.Response.Body;
                    context.Response.StatusCode = StatusCodes.Status500InternalServerError;
                }
            }));

        var response = await client.GetAsync("/web/", Cancel);

        Assert.Equal(HttpStatusCode.InternalServerError, response.StatusCode);
        Assert.Same(bodyBefore, bodyAfter);
    }

    /// <summary>Starts a pipeline of: before, the middleware, between, downstream.</summary>
    private static HttpClient Start(
        RequestDelegate downstream,
        string baseUrl = "",
        Action<IApplicationBuilder>? before = null,
        Action<IApplicationBuilder>? between = null)
    {
        var host = new HostBuilder()
            .ConfigureWebHost(web => web
                .UseTestServer()
                .Configure(app =>
                {
                    before?.Invoke(app);
                    app.UseMiddleware<IndexInjectionMiddleware>(baseUrl, "abc");
                    between?.Invoke(app);
                    app.Run(downstream);
                }))
            .Start();
        return host.GetTestClient();
    }
}
