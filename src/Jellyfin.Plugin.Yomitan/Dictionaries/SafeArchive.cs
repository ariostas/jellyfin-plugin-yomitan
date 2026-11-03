using System.Buffers.Binary;
using System.IO.Compression;

namespace Jellyfin.Plugin.Yomitan.Dictionaries;

/// <summary>
/// A dictionary zip that is treated as hostile. Nothing here ever writes an entry name to the file system,
/// but names still flow to clients and logs, so any unsafe name rejects the whole archive.
/// </summary>
internal sealed class SafeArchive : IDisposable
{
    private readonly ZipArchive _zip;
    private readonly Dictionary<string, ZipArchiveEntry> _byName = new(StringComparer.Ordinal);
    private readonly ImportLimits _limits;
    private long _bytesRead;

    public SafeArchive(Stream archive, ImportLimits limits)
    {
        _limits = limits;
        CheckCentralDirectory(archive, limits.MaxEntries);
        archive.Position = 0;

        try
        {
            _zip = new ZipArchive(archive, ZipArchiveMode.Read, leaveOpen: true);
            Entries = [.. _zip.Entries];
        }
        catch (InvalidDataException e)
        {
            throw new ImportException("invalid_archive", $"Not a readable zip file: {e.Message}");
        }

        long declared = 0;
        foreach (var entry in Entries)
        {
            if (!IsSafeName(entry.FullName))
            {
                throw new ImportException("unsafe_path", $"Archive entry has an unsafe name: {Printable(entry.FullName)}");
            }

            if (!_byName.TryAdd(entry.FullName, entry))
            {
                throw new ImportException("invalid_archive", $"Archive has two entries named {Printable(entry.FullName)}");
            }

            // Only a fast path. The sizes are the archive's own claim, so Open counts what really comes out.
            declared += Math.Min(entry.Length, limits.MaxDecompressedBytes + 1);
            if (declared > limits.MaxDecompressedBytes)
            {
                throw LimitExceeded($"Archive decompresses to more than {limits.MaxDecompressedBytes} bytes");
            }
        }
    }

    /// <summary>Gets the entries in archive order.</summary>
    public IReadOnlyList<ZipArchiveEntry> Entries { get; }

    /// <summary>Gets how many decompressed bytes have been read so far.</summary>
    public long BytesRead => Volatile.Read(ref _bytesRead);

    /// <summary>Checks an entry name, or a media path taken from a dictionary or a request.</summary>
    public static bool IsSafeName(string name)
    {
        if (name.Length == 0 || name[0] == '/' || name.Any(c => c == '\\' || char.IsControl(c)))
        {
            return false;
        }

        if (name.Length >= 2 && name[1] == ':' && char.IsAsciiLetter(name[0]))
        {
            return false;
        }

        return !name.Split('/').Any(segment => segment is "." or "..");
    }

    public ZipArchiveEntry? Find(string name) => _byName.GetValueOrDefault(name);

    /// <summary>Opens an entry for reading at most <paramref name="maxBytes"/> decompressed bytes.</summary>
    public Stream Open(ZipArchiveEntry entry, long maxBytes)
    {
        if (entry.Length > maxBytes)
        {
            throw LimitExceeded($"{Printable(entry.FullName)} is larger than the limit of {maxBytes} bytes");
        }

        try
        {
            return new CappedStream(entry.Open(), this, entry.FullName, maxBytes);
        }
        catch (Exception e) when (e is InvalidDataException or NotSupportedException)
        {
            throw new ImportException("invalid_archive", $"Cannot read {Printable(entry.FullName)}: {e.Message}");
        }
    }

    public byte[] ReadAllBytes(ZipArchiveEntry entry, long maxBytes)
    {
        using var input = Open(entry, maxBytes);
        using var output = new MemoryStream();
        try
        {
            input.CopyTo(output);
        }
        catch (InvalidDataException e)
        {
            throw new ImportException("invalid_archive", $"Cannot read {Printable(entry.FullName)}: {e.Message}");
        }

        return output.ToArray();
    }

    public void Dispose() => _zip.Dispose();

    /// <summary>Makes a hostile name safe to show.</summary>
    internal static string Printable(string name)
    {
        var clean = new string(name.Select(c => char.IsControl(c) ? '?' : c).Take(200).ToArray());
        return $"\"{clean}\"";
    }

    private static ImportException LimitExceeded(string message) => new("limit_exceeded", message);

    /// <summary>
    /// Counts entries by walking the central directory before ZipArchive allocates an object for each one.
    /// Reading Entries first and checking the count afterwards would let the archive exhaust memory.
    /// </summary>
    private static void CheckCentralDirectory(Stream archive, int maxEntries)
    {
        const int EndRecordSize = 22;
        const int HeaderSize = 46;
        const uint EndSignature = 0x06054b50;
        const uint Locator64Signature = 0x07064b50;
        const uint End64Signature = 0x06064b50;
        const uint HeaderSignature = 0x02014b50;

        var length = archive.Length;
        var tailSize = (int)Math.Min(length, EndRecordSize + ushort.MaxValue);
        if (tailSize < EndRecordSize)
        {
            throw new ImportException("invalid_archive", "Not a zip file");
        }

        var tail = new byte[tailSize];
        archive.Position = length - tailSize;
        archive.ReadExactly(tail);

        var end = -1;
        for (var i = tailSize - EndRecordSize; i >= 0 && end < 0; i--)
        {
            if (BinaryPrimitives.ReadUInt32LittleEndian(tail.AsSpan(i)) == EndSignature)
            {
                end = i;
            }
        }

        if (end < 0)
        {
            throw new ImportException("invalid_archive", "Not a zip file");
        }

        // ZipArchive follows the zip64 record when any of these three is at its maximum, and then reads the directory
        // where that record says. This has to look in the same place, or a 1-entry directory here hides the real one.
        long directoryStart = BinaryPrimitives.ReadUInt32LittleEndian(tail.AsSpan(end + 16));
        var isZip64 = directoryStart == uint.MaxValue
            || BinaryPrimitives.ReadUInt16LittleEndian(tail.AsSpan(end + 4)) == ushort.MaxValue
            || BinaryPrimitives.ReadUInt16LittleEndian(tail.AsSpan(end + 10)) == ushort.MaxValue;
        // The locator sits just before the end record, which a long comment can put outside the tail read above.
        var locator = new byte[20];
        var locatorPosition = length - tailSize + end - locator.Length;
        if (isZip64 && locatorPosition >= 0)
        {
            archive.Position = locatorPosition;
            archive.ReadExactly(locator);
        }

        if (isZip64 && BinaryPrimitives.ReadUInt32LittleEndian(locator) == Locator64Signature)
        {
            var end64 = new byte[56];
            archive.Position = (long)Math.Min(
                BinaryPrimitives.ReadUInt64LittleEndian(locator.AsSpan(8)), (ulong)Math.Max(0, length - end64.Length));
            archive.ReadExactly(end64);
            if (BinaryPrimitives.ReadUInt32LittleEndian(end64) != End64Signature)
            {
                throw new ImportException("invalid_archive", "Damaged zip64 record");
            }

            directoryStart = (long)Math.Min(BinaryPrimitives.ReadUInt64LittleEndian(end64.AsSpan(48)), long.MaxValue);
        }

        // Each name can be 64 KB, so the entry count alone does not bound memory.
        var maxDirectoryBytes = maxEntries * 1024L;
        var header = new byte[HeaderSize];
        var position = directoryStart;
        var count = 0;
        while (position + HeaderSize <= length)
        {
            archive.Position = position;
            archive.ReadExactly(header);
            if (BinaryPrimitives.ReadUInt32LittleEndian(header) != HeaderSignature)
            {
                break;
            }

            if (++count > maxEntries)
            {
                throw LimitExceeded($"Archive has more than {maxEntries} entries");
            }

            position += HeaderSize
                + BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(28))
                + BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(30))
                + BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(32));
            if (position - directoryStart > maxDirectoryBytes)
            {
                throw LimitExceeded($"Archive's central directory is larger than {maxDirectoryBytes} bytes");
            }
        }
    }

    /// <summary>Counts what really comes out of an entry, because its declared size is only a claim.</summary>
    private sealed class CappedStream : Stream
    {
        private readonly Stream _inner;
        private readonly SafeArchive _owner;
        private readonly string _name;
        private readonly long _maxBytes;
        private long _read;

        public CappedStream(Stream inner, SafeArchive owner, string name, long maxBytes)
        {
            _inner = inner;
            _owner = owner;
            _name = name;
            _maxBytes = maxBytes;
        }

        public override bool CanRead => true;

        public override bool CanSeek => false;

        public override bool CanWrite => false;

        public override long Length => throw new NotSupportedException();

        public override long Position
        {
            get => _read;
            set => throw new NotSupportedException();
        }

        public override int Read(byte[] buffer, int offset, int count) => Read(buffer.AsSpan(offset, count));

        public override int Read(Span<byte> buffer)
        {
            var read = _inner.Read(buffer);
            _read += read;
            if (_read > _maxBytes)
            {
                throw LimitExceeded($"{Printable(_name)} is larger than the limit of {_maxBytes} bytes");
            }

            if (Interlocked.Add(ref _owner._bytesRead, read) > _owner._limits.MaxDecompressedBytes)
            {
                throw LimitExceeded($"Archive decompresses to more than {_owner._limits.MaxDecompressedBytes} bytes");
            }

            return read;
        }

        public override void Flush()
        {
        }

        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();

        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _inner.Dispose();
            }

            base.Dispose(disposing);
        }
    }
}
