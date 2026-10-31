using System.Text.Encodings.Web;
using System.Text.Json;
using Jellyfin.Plugin.Yomitan.Dictionaries;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Net.Http.Headers;

namespace Jellyfin.Plugin.Yomitan.Api;

/// <summary>Dictionary management and lookups. docs/api.md is the contract for all of this.</summary>
[ApiController]
[Route("Yomitan")]
public class DictionaryController : ControllerBase
{
    private const string RequiresElevation = "RequiresElevation";
    private const string Json = "application/json; charset=utf-8";

    private static readonly JsonSerializerOptions SerializerOptions = new(JsonSerializerDefaults.Web)
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
    };

    private readonly DictionaryStore _store;
    private readonly DictionaryQuery _query;
    private readonly JobQueue _jobs;
    private readonly Func<ImportLimits> _limits;

    /// <summary>Initializes a new instance of the <see cref="DictionaryController"/> class.</summary>
    /// <param name="store">The dictionaries.</param>
    /// <param name="query">The query engine.</param>
    /// <param name="jobs">The job queue.</param>
    /// <param name="limits">Gets the current import limits.</param>
    public DictionaryController(DictionaryStore store, DictionaryQuery query, JobQueue jobs, Func<ImportLimits> limits)
    {
        _store = store;
        _query = query;
        _jobs = jobs;
        _limits = limits;
    }

    /// <summary>
    /// Accepts a dictionary archive and queues its import. The optional query parameter replace=true lets it
    /// replace a dictionary of the same title. That is read by hand: with any bound parameter, MVC's value
    /// providers would parse a form-encoded body before this runs, and fail on an archive sent with that type.
    /// </summary>
    /// <returns>The queued job.</returns>
    [HttpPost("Dictionaries")]
    [Authorize(Policy = RequiresElevation)]
    [DisableRequestSizeLimit]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    public async Task<IActionResult> Upload()
    {
        var cancellationToken = HttpContext.RequestAborted;
        if (!bool.TryParse(Request.Query["replace"].FirstOrDefault() ?? "false", out var replace))
        {
            return Error(StatusCodes.Status400BadRequest, "invalid_request", "replace must be true or false");
        }

        var maxBytes = _limits().MaxUploadBytes;
        if (Request.ContentLength > maxBytes)
        {
            return Error(StatusCodes.Status413PayloadTooLarge, "limit_exceeded", $"Uploads are limited to {maxBytes} bytes");
        }

        if (!_jobs.TryReserve())
        {
            return Error(StatusCodes.Status429TooManyRequests, "queue_full", $"At most {JobQueue.MaxPending} jobs can wait at once");
        }

        var path = _store.NewUploadPath();
        var submitted = false;
        try
        {
            long received;
            var file = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 1 << 20, FileOptions.Asynchronous);
            await using (file.ConfigureAwait(false))
            {
                received = await Spool(file, maxBytes, cancellationToken).ConfigureAwait(false);
            }

            if (received > maxBytes)
            {
                return Error(StatusCodes.Status413PayloadTooLarge, "limit_exceeded", $"Uploads are limited to {maxBytes} bytes");
            }

            if (received == 0)
            {
                return Error(StatusCodes.Status400BadRequest, "empty_upload", "The request body is empty");
            }

            var job = new DictionaryJob("import") { Replace = replace, ArchivePath = path };
            _jobs.Submit(job);
            submitted = true;
            return AcceptedJob(job);
        }
        catch (Exception e) when (e is IOException or OperationCanceledException or BadHttpRequestException)
        {
            // The client went away, or the disk filled up. Kestrel has already ended a dropped connection.
            return Error(StatusCodes.Status400BadRequest, "upload_failed", "The upload did not finish");
        }
        finally
        {
            if (!submitted)
            {
                System.IO.File.Delete(path);
                _jobs.Release();
            }
        }
    }

    /// <summary>Lists the installed dictionaries.</summary>
    /// <returns>Their summaries and sizes.</returns>
    [HttpGet("Dictionaries")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult List()
    {
        var (databaseBytes, freeBytes) = _store.GetDatabaseSize();
        var dictionaries = _store.List().Select(d => new
        {
            title = d.Title,
            sizeBytes = d.SizeBytes,
            summary = JsonSerializer.Deserialize<JsonElement>(d.Summary),
        });
        return JsonResult(new { dictionaries, databaseBytes, freeBytes });
    }

    /// <summary>Queues the deletion of a dictionary.</summary>
    /// <param name="title">The dictionary's title.</param>
    /// <returns>The queued job.</returns>
    [HttpDelete("Dictionaries")]
    [Authorize(Policy = RequiresElevation)]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    public IActionResult Delete([FromQuery] string? title)
    {
        if (string.IsNullOrEmpty(title))
        {
            return Error(StatusCodes.Status400BadRequest, "invalid_request", "title is required");
        }

        if (!_store.Exists(title))
        {
            return Error(StatusCodes.Status404NotFound, "not_found", "No dictionary has that title");
        }

        if (!_jobs.TryReserve())
        {
            return Error(StatusCodes.Status429TooManyRequests, "queue_full", $"At most {JobQueue.MaxPending} jobs can wait at once");
        }

        var job = new DictionaryJob("delete") { Title = title };
        _jobs.Submit(job);
        return AcceptedJob(job);
    }

    /// <summary>Gets a job's status.</summary>
    /// <param name="id">The job's id.</param>
    /// <returns>The job.</returns>
    [HttpGet("Jobs/{id:guid}")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult GetJob([FromRoute] Guid id)
    {
        var job = _jobs.Find(id);
        return job is null
            ? Error(StatusCodes.Status404NotFound, "not_found", "No such job. Jobs are forgotten on restart.")
            : JsonResult(Describe(job));
    }

    /// <summary>Runs a batch of database operations. It takes no bound parameters, for the reason given on Upload.</summary>
    /// <returns>One result per operation.</returns>
    [HttpPost("Query")]
    [Authorize]
    [RequestSizeLimit(QueryLimits.MaxRequestBytes)]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> Query()
    {
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
            return Error(StatusCodes.Status413PayloadTooLarge, "limit_exceeded", $"Query bodies are limited to {QueryLimits.MaxRequestBytes} bytes");
        }

        using (document)
        {
            try
            {
                return File(_query.Execute(document.RootElement), Json);
            }
            catch (QueryException e)
            {
                return Error(StatusCodes.Status400BadRequest, e.Code, e.Message);
            }
        }
    }

    /// <summary>Gets a dictionary image.</summary>
    /// <param name="dictionary">The dictionary's title.</param>
    /// <param name="path">The image's path in the dictionary.</param>
    /// <returns>The image.</returns>
    [HttpGet("Media")]
    [Authorize]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public IActionResult GetMedia([FromQuery] string? dictionary, [FromQuery] string? path)
    {
        if (string.IsNullOrEmpty(dictionary) || path is null)
        {
            return Error(StatusCodes.Status400BadRequest, "invalid_request", "dictionary and path are required");
        }

        if (!SafeArchive.IsSafeName(path))
        {
            return Error(StatusCodes.Status400BadRequest, "unsafe_path", "That is not a valid media path");
        }

        var media = _store.FindMedia(dictionary, path);
        if (media is null)
        {
            return Error(StatusCodes.Status404NotFound, "not_found", "No such image");
        }

        // The bytes are whatever a dictionary author wrote, and an SVG is a document that can run script. The
        // media type comes from a fixed table, sniffing is off, and the sandbox disables anything active if
        // the response is ever opened as a page. SVG is also a download then, not a page on the server's origin.
        var headers = Response.Headers;
        headers[HeaderNames.XContentTypeOptions] = "nosniff";
        headers[HeaderNames.ContentSecurityPolicy] = "default-src 'none'; style-src 'unsafe-inline'; sandbox";
        headers[HeaderNames.ContentDisposition] = media.MediaType == "image/svg+xml" ? "attachment" : "inline";
        headers[HeaderNames.CacheControl] = "private, max-age=86400";
        return File(media.Content, media.MediaType, lastModified: null, new EntityTagHeaderValue($"\"{media.Id}\""));
    }

    private static object Describe(DictionaryJob job)
    {
        var progress = job.Progress;
        var fraction = job.State == "succeeded"
            ? 1
            : progress is { BytesTotal: > 0 } ? Math.Min(1, (double)progress.BytesProcessed / progress.BytesTotal) : 0;
        return new
        {
            id = job.Id,
            kind = job.Kind,
            state = job.State,
            title = job.Title,
            replace = job.Replace,
            phase = progress?.Phase,
            progress = new
            {
                fraction,
                bytesProcessed = progress?.BytesProcessed ?? 0,
                bytesTotal = progress?.BytesTotal ?? 0,
                rows = progress?.Rows ?? 0,
            },
            result = job.Result is { } result
                ? new { title = result.Title, revision = result.Revision, replaced = result.Replaced, counts = result.Counts, sizeBytes = result.SizeBytes }
                : null,
            error = job.ErrorCode is null ? null : new { code = job.ErrorCode, message = job.ErrorMessage },
            createdAt = job.CreatedAt,
            startedAt = job.StartedAt,
            finishedAt = job.FinishedAt,
        };
    }

    private ContentResult JsonResult(object value, int status = StatusCodes.Status200OK)
        => new() { Content = JsonSerializer.Serialize(value, SerializerOptions), ContentType = Json, StatusCode = status };

    private ContentResult Error(int status, string code, string message)
        => JsonResult(new { error = new { code, message } }, status);

    private ContentResult AcceptedJob(DictionaryJob job)
    {
        Response.Headers.Location = $"{Request.PathBase}/Yomitan/Jobs/{job.Id}";
        return JsonResult(Describe(job), StatusCodes.Status202Accepted);
    }

    /// <summary>Copies the body with async IO, which Kestrel requires, and stops one byte past the limit.</summary>
    private async Task<long> Spool(Stream file, long maxBytes, CancellationToken cancellationToken)
    {
        var buffer = new byte[1 << 20];
        long received = 0;
        while (received <= maxBytes)
        {
            var read = await Request.Body.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
            if (read == 0)
            {
                break;
            }

            received += read;
            await file.WriteAsync(buffer.AsMemory(0, read), cancellationToken).ConfigureAwait(false);
        }

        return received;
    }
}
