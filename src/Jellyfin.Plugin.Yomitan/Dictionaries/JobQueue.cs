using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Yomitan.Dictionaries;

/// <summary>A queued import or delete. Jobs live in memory, so they end with the server process.</summary>
public sealed class DictionaryJob
{
    /// <summary>Initializes a new instance of the <see cref="DictionaryJob"/> class.</summary>
    /// <param name="kind">The job's kind, import or delete.</param>
    public DictionaryJob(string kind)
    {
        Kind = kind;
    }

    /// <summary>Gets the job's id.</summary>
    public Guid Id { get; } = Guid.NewGuid();

    /// <summary>Gets the kind: import or delete.</summary>
    public string Kind { get; }

    /// <summary>Gets the state: queued, running, succeeded or failed.</summary>
    public string State { get; internal set; } = "queued";

    /// <summary>Gets the dictionary's title, once it is known.</summary>
    public string? Title { get; internal set; }

    /// <summary>Gets whether an existing dictionary of the same title may be replaced.</summary>
    public bool Replace { get; internal init; }

    /// <summary>Gets the latest progress.</summary>
    public ImportProgress? Progress { get; internal set; }

    /// <summary>Gets the outcome of a finished import.</summary>
    public ImportResult? Result { get; internal set; }

    /// <summary>Gets the stable error code of a failed job.</summary>
    public string? ErrorCode { get; internal set; }

    /// <summary>Gets the detail of a failed job.</summary>
    public string? ErrorMessage { get; internal set; }

    /// <summary>Gets when the job was created.</summary>
    public DateTimeOffset CreatedAt { get; } = DateTimeOffset.UtcNow;

    /// <summary>Gets when the job started running.</summary>
    public DateTimeOffset? StartedAt { get; internal set; }

    /// <summary>Gets when the job finished.</summary>
    public DateTimeOffset? FinishedAt { get; internal set; }

    /// <summary>Gets the spooled upload of an import.</summary>
    internal string? ArchivePath { get; init; }
}

/// <summary>
/// The queue of dictionary changes. One worker runs them in order, because SQLite has a single writer, and
/// because that way an import and a delete of the same dictionary cannot interleave.
/// </summary>
public sealed class JobQueue
{
    /// <summary>Most jobs waiting or running, counting uploads still arriving, since each one holds disk space.</summary>
    public const int MaxPending = 8;

    /// <summary>Finished jobs kept for status queries.</summary>
    public const int MaxFinished = 64;

    private readonly ConcurrentDictionary<Guid, DictionaryJob> _jobs = new();
    private readonly ConcurrentQueue<Guid> _finished = new();
    private readonly Channel<DictionaryJob> _channel = Channel.CreateUnbounded<DictionaryJob>(new UnboundedChannelOptions { SingleReader = true });
    private int _pending;

    /// <summary>Gets the jobs for the worker to run.</summary>
    internal ChannelReader<DictionaryJob> Pending => _channel.Reader;

    /// <summary>Reserves a slot, which must then be given to <see cref="Submit"/> or <see cref="Release"/>.</summary>
    /// <returns>Whether there was a slot.</returns>
    public bool TryReserve()
    {
        if (Interlocked.Increment(ref _pending) > MaxPending)
        {
            Interlocked.Decrement(ref _pending);
            return false;
        }

        return true;
    }

    /// <summary>Gives back a reserved slot that will not be used.</summary>
    public void Release() => Interlocked.Decrement(ref _pending);

    /// <summary>Queues a job in a reserved slot.</summary>
    /// <param name="job">The job.</param>
    public void Submit(DictionaryJob job)
    {
        _jobs[job.Id] = job;
        _channel.Writer.TryWrite(job);
    }

    /// <summary>Finds a job.</summary>
    /// <param name="id">The job's id.</param>
    /// <returns>The job, or null if it is unknown or long finished.</returns>
    public DictionaryJob? Find(Guid id) => _jobs.GetValueOrDefault(id);

    /// <summary>Records that a job has finished, and forgets the oldest ones.</summary>
    internal void MarkFinished(DictionaryJob job)
    {
        job.FinishedAt = DateTimeOffset.UtcNow;
        Release();
        _finished.Enqueue(job.Id);
        while (_finished.Count > MaxFinished && _finished.TryDequeue(out var oldest))
        {
            _jobs.TryRemove(oldest, out _);
        }
    }
}

/// <summary>Runs queued jobs.</summary>
public sealed class JobWorker : BackgroundService
{
    private readonly JobQueue _queue;
    private readonly Func<DictionaryStore> _store;
    private readonly Func<ImportLimits> _limits;
    private readonly ILogger<JobWorker> _logger;

    /// <summary>Initializes a new instance of the <see cref="JobWorker"/> class.</summary>
    /// <param name="queue">The job queue.</param>
    /// <param name="store">
    /// Gets the dictionaries. This runs at server start, where an exception would stop Jellyfin from booting, so
    /// a database that cannot be opened has to wait until there is a job to fail.
    /// </param>
    /// <param name="limits">Gets the current limits.</param>
    /// <param name="logger">The logger.</param>
    public JobWorker(JobQueue queue, Func<DictionaryStore> store, Func<ImportLimits> limits, ILogger<JobWorker> logger)
    {
        _queue = queue;
        _store = store;
        _limits = limits;
        _logger = logger;
    }

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // An import is CPU and disk work end to end, so keep it off whatever thread started the host.
        await Task.Yield();
        try
        {
            await foreach (var job in _queue.Pending.ReadAllAsync(stoppingToken).ConfigureAwait(false))
            {
                await Task.Run(() => Run(job, stoppingToken), CancellationToken.None).ConfigureAwait(false);
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            // Shutting down. A running import has rolled back, and uploads are removed on the next start.
        }
    }

    private void Run(DictionaryJob job, CancellationToken cancellationToken)
    {
        job.StartedAt = DateTimeOffset.UtcNow;
        job.State = "running";
        try
        {
            if (job.ArchivePath is { } archivePath)
            {
                var importer = new DictionaryImporter(_store(), _limits(), progress =>
                {
                    job.Progress = progress;
                    job.Title ??= progress.Title;
                });
                job.Result = importer.Import(archivePath, job.Replace, cancellationToken);
            }
            else
            {
                _store().Delete(job.Title!);
            }

            job.State = "succeeded";
            _logger.LogInformation("Dictionary {Kind} of {Title} succeeded", job.Kind, job.Title);
        }
        catch (ImportException e)
        {
            Fail(job, e.Code, e.Message);
            _logger.LogWarning("Dictionary {Kind} of {Title} failed: {Code}: {Message}", job.Kind, job.Title, e.Code, e.Message);
        }
        catch (OperationCanceledException)
        {
            Fail(job, "cancelled", "The server shut down during the import");
        }
        catch (Exception e)
        {
            // Bugs and full disks. The transaction has rolled back either way, and details stay in the log.
            Fail(job, "internal", "The import failed on the server. The server log has the details.");
            _logger.LogError(e, "Dictionary {Kind} of {Title} failed", job.Kind, job.Title);
        }
        finally
        {
            if (job.ArchivePath is { } archivePath)
            {
                TryDelete(archivePath);
            }

            _queue.MarkFinished(job);
        }
    }

    private static void Fail(DictionaryJob job, string code, string message)
    {
        job.ErrorCode = code;
        job.ErrorMessage = message;
        job.State = "failed";
    }

    private void TryDelete(string path)
    {
        try
        {
            File.Delete(path);
        }
        catch (IOException e)
        {
            _logger.LogWarning(e, "Could not remove spooled upload {Path}", path);
        }
    }
}
