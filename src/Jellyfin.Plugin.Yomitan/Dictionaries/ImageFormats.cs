using System.Buffers.Binary;
using System.Globalization;
using System.Xml;

namespace Jellyfin.Plugin.Yomitan.Dictionaries;

/// <summary>
/// Media types and pixel sizes for dictionary images. Yomitan gets the size by decoding the image in a page.
/// The server has no decoder it can rely on, so this reads the headers, and the result is what glossaries
/// carry as the image's width and height.
/// </summary>
internal static class ImageFormats
{
    /// <summary>Gets the media type for a file name, using the same table as Yomitan's media-util.js.</summary>
    public static string? MediaTypeOf(string path)
    {
        var name = path[(path.LastIndexOf('/') + 1)..];
        var dot = name.LastIndexOf('.');
        return dot < 0 ? null : name[dot..].ToLowerInvariant() switch
        {
            ".apng" => "image/apng",
            ".avif" => "image/avif",
            ".bmp" => "image/bmp",
            ".gif" => "image/gif",
            ".ico" or ".cur" => "image/x-icon",
            ".jpg" or ".jpeg" or ".jfif" or ".pjpeg" or ".pjp" => "image/jpeg",
            ".png" => "image/png",
            ".svg" => "image/svg+xml",
            ".tif" or ".tiff" => "image/tiff",
            ".webp" => "image/webp",
            _ => null,
        };
    }

    /// <summary>Reads an image's size. Null means it is not a readable image of that type.</summary>
    public static (int Width, int Height)? ReadSize(byte[] data, string mediaType)
    {
        try
        {
            var size = mediaType switch
            {
                "image/png" or "image/apng" => ReadPng(data),
                "image/gif" => ReadGif(data),
                "image/jpeg" => ReadJpeg(data),
                "image/webp" => ReadWebp(data),
                "image/bmp" => ReadBmp(data),
                "image/x-icon" => ReadIco(data),
                "image/avif" => ReadAvif(data),
                "image/svg+xml" => ReadSvg(data),
                _ => null, // TIFF: no browser that runs Yomitan's import decodes it either.
            };
            return size is { Width: > 0, Height: > 0 } ? size : null;
        }
        catch (Exception e) when (e is ArgumentOutOfRangeException or IndexOutOfRangeException or XmlException or FormatException or OverflowException)
        {
            return null;
        }
    }

    private static (int Width, int Height)? ReadPng(ReadOnlySpan<byte> data)
    {
        if (!data.StartsWith<byte>([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) || !data.Slice(12, 4).SequenceEqual("IHDR"u8))
        {
            return null;
        }

        return (BinaryPrimitives.ReadInt32BigEndian(data[16..]), BinaryPrimitives.ReadInt32BigEndian(data[20..]));
    }

    private static (int Width, int Height)? ReadGif(ReadOnlySpan<byte> data)
    {
        if (!data.StartsWith("GIF87a"u8) && !data.StartsWith("GIF89a"u8))
        {
            return null;
        }

        return (BinaryPrimitives.ReadUInt16LittleEndian(data[6..]), BinaryPrimitives.ReadUInt16LittleEndian(data[8..]));
    }

    private static (int Width, int Height)? ReadJpeg(ReadOnlySpan<byte> data)
    {
        if (data.Length < 4 || data[0] != 0xFF || data[1] != 0xD8)
        {
            return null;
        }

        var position = 2;
        while (position + 9 <= data.Length)
        {
            if (data[position] != 0xFF)
            {
                return null;
            }

            var marker = data[position + 1];
            if (marker == 0xFF)
            {
                position++;
                continue;
            }

            var isFrameHeader = marker is >= 0xC0 and <= 0xCF and not (0xC4 or 0xC8 or 0xCC);
            if (isFrameHeader)
            {
                return (BinaryPrimitives.ReadUInt16BigEndian(data[(position + 7)..]), BinaryPrimitives.ReadUInt16BigEndian(data[(position + 5)..]));
            }

            position += 2 + BinaryPrimitives.ReadUInt16BigEndian(data[(position + 2)..]);
        }

        return null;
    }

    private static (int Width, int Height)? ReadWebp(ReadOnlySpan<byte> data)
    {
        if (!data.StartsWith("RIFF"u8) || !data.Slice(8, 4).SequenceEqual("WEBP"u8))
        {
            return null;
        }

        var chunk = data.Slice(12, 4);
        if (chunk.SequenceEqual("VP8 "u8))
        {
            return (BinaryPrimitives.ReadUInt16LittleEndian(data[26..]) & 0x3FFF, BinaryPrimitives.ReadUInt16LittleEndian(data[28..]) & 0x3FFF);
        }

        if (chunk.SequenceEqual("VP8L"u8))
        {
            var bits = BinaryPrimitives.ReadUInt32LittleEndian(data[21..]);
            return ((int)(bits & 0x3FFF) + 1, (int)((bits >> 14) & 0x3FFF) + 1);
        }

        if (chunk.SequenceEqual("VP8X"u8))
        {
            return (ReadUInt24(data[24..]) + 1, ReadUInt24(data[27..]) + 1);
        }

        return null;
    }

    private static int ReadUInt24(ReadOnlySpan<byte> data) => data[0] | (data[1] << 8) | (data[2] << 16);

    private static (int Width, int Height)? ReadBmp(ReadOnlySpan<byte> data)
    {
        if (!data.StartsWith("BM"u8))
        {
            return null;
        }

        if (BinaryPrimitives.ReadInt32LittleEndian(data[14..]) == 12)
        {
            return (BinaryPrimitives.ReadUInt16LittleEndian(data[18..]), BinaryPrimitives.ReadUInt16LittleEndian(data[20..]));
        }

        return (BinaryPrimitives.ReadInt32LittleEndian(data[18..]), Math.Abs(BinaryPrimitives.ReadInt32LittleEndian(data[22..])));
    }

    private static (int Width, int Height)? ReadIco(ReadOnlySpan<byte> data)
    {
        var type = BinaryPrimitives.ReadUInt16LittleEndian(data[2..]);
        var count = BinaryPrimitives.ReadUInt16LittleEndian(data[4..]);
        if (BinaryPrimitives.ReadUInt16LittleEndian(data) != 0 || type is not (1 or 2) || count == 0)
        {
            return null;
        }

        // Browsers use the largest image.
        (int Width, int Height) largest = (0, 0);
        for (var i = 0; i < count; i++)
        {
            var width = data[6 + (i * 16)] is var w and not 0 ? w : 256;
            var height = data[7 + (i * 16)] is var h and not 0 ? h : 256;
            if (width > largest.Width)
            {
                largest = (width, height);
            }
        }

        return largest;
    }

    private static (int Width, int Height)? ReadAvif(ReadOnlySpan<byte> data)
    {
        if (!data.Slice(4, 4).SequenceEqual("ftyp"u8))
        {
            return null;
        }

        // The image spatial extents property. Walking meta/iprp/ipco properly gains nothing for a size hint.
        var offset = data.IndexOf("ispe"u8);
        return offset < 0
            ? null
            : (BinaryPrimitives.ReadInt32BigEndian(data[(offset + 8)..]), BinaryPrimitives.ReadInt32BigEndian(data[(offset + 12)..]));
    }

    private static (int Width, int Height)? ReadSvg(byte[] data)
    {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null, MaxCharactersInDocument = 0 };
        using var stream = new MemoryStream(data);
        using var reader = XmlReader.Create(stream, settings);
        if (reader.MoveToContent() != XmlNodeType.Element || !string.Equals(reader.LocalName, "svg", StringComparison.Ordinal))
        {
            return null;
        }

        var width = ParseLength(reader.GetAttribute("width"));
        var height = ParseLength(reader.GetAttribute("height"));
        var viewBox = reader.GetAttribute("viewBox")?.Split([' ', ','], StringSplitOptions.RemoveEmptyEntries);
        double? boxWidth = viewBox?.Length == 4 ? ParseLength(viewBox[2]) : null;
        double? boxHeight = viewBox?.Length == 4 ? ParseLength(viewBox[3]) : null;

        // Mirrors an <img>: missing sizes come from the viewBox's ratio, then from the 300x150 default.
        if (width is null && height is null && boxWidth > 0 && boxHeight > 0)
        {
            width = 300;
            height = 300 * boxHeight / boxWidth;
        }
        else if (width is null)
        {
            width = height * boxWidth / boxHeight ?? 300;
        }
        else if (height is null)
        {
            height = width * boxHeight / boxWidth ?? 150;
        }

        return ((int)Math.Round(width.Value), (int)Math.Round(height!.Value));
    }

    private static double? ParseLength(string? text)
    {
        if (text is null)
        {
            return null;
        }

        var trimmed = text.Trim();
        var unitStart = trimmed.Length;
        while (unitStart > 0 && char.IsAsciiLetter(trimmed[unitStart - 1]))
        {
            unitStart--;
        }

        if (trimmed.EndsWith('%')
            || !double.TryParse(trimmed.AsSpan(0, unitStart), NumberStyles.Float, CultureInfo.InvariantCulture, out var value))
        {
            return null;
        }

        return trimmed[unitStart..].ToLowerInvariant() switch
        {
            "" or "px" => value,
            "pt" => value * 4 / 3,
            "pc" => value * 16,
            "in" => value * 96,
            "cm" => value * 96 / 2.54,
            "mm" => value * 96 / 25.4,
            _ => null,
        };
    }
}
