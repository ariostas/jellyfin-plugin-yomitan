using System.Buffers.Binary;
using System.Text;
using Jellyfin.Plugin.Yomitan.Dictionaries;
using Xunit;

namespace Jellyfin.Plugin.Yomitan.Tests;

public class ImageTests
{
    public static byte[] Png(int width, int height)
    {
        var bytes = new byte[33];
        new byte[] { 0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13 }.CopyTo(bytes, 0);
        "IHDR"u8.CopyTo(bytes.AsSpan(12));
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(16), width);
        BinaryPrimitives.WriteInt32BigEndian(bytes.AsSpan(20), height);
        return bytes;
    }

    public static TheoryData<string, byte[], int, int> Images() => new()
    {
        { "image/png", Png(7, 9), 7, 9 },
        { "image/apng", Png(7, 9), 7, 9 },
        { "image/gif", [.. "GIF89a"u8, 7, 0, 9, 0, 0, 0, 0], 7, 9 },
        { "image/jpeg", [0xFF, 0xD8, 0xFF, 0xE0, 0, 4, 0, 0, 0xFF, 0xC0, 0, 11, 8, 0, 9, 0, 7, 1, 0, 0, 0], 7, 9 },
        { "image/webp", [.. "RIFF"u8, 0, 0, 0, 0, .. "WEBP"u8, .. "VP8 "u8, 0, 0, 0, 0, 0, 0, 0, 0x9D, 1, 0x2A, 7, 0, 9, 0], 7, 9 },
        { "image/webp", [.. "RIFF"u8, 0, 0, 0, 0, .. "WEBP"u8, .. "VP8L"u8, 0, 0, 0, 0, 0x2F, 6, 0x00, 0x02, 0x00], 7, 9 },
        { "image/webp", [.. "RIFF"u8, 0, 0, 0, 0, .. "WEBP"u8, .. "VP8X"u8, 0, 0, 0, 0, 0, 0, 0, 0, 6, 0, 0, 8, 0, 0], 7, 9 },
        { "image/bmp", [.. "BM"u8, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 40, 0, 0, 0, 7, 0, 0, 0, 0xF7, 0xFF, 0xFF, 0xFF], 7, 9 },
        { "image/x-icon", [0, 0, 1, 0, 2, 0, 16, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 256, 256 },
        { "image/avif", [0, 0, 0, 16, .. "ftyp"u8, .. "avif"u8, 0, 0, 0, 0, 0, 0, 0, 20, .. "ispe"u8, 0, 0, 0, 0, 0, 0, 0, 7, 0, 0, 0, 9], 7, 9 },
        { "image/svg+xml", Encoding.UTF8.GetBytes("""<svg xmlns="http://www.w3.org/2000/svg" width="7" height="9"/>"""), 7, 9 },
        { "image/svg+xml", Encoding.UTF8.GetBytes("""<svg xmlns="http://www.w3.org/2000/svg" width="7px" height="9pt"/>"""), 7, 12 },
    };

    [Theory]
    [MemberData(nameof(Images))]
    public void Sizes_come_from_the_headers(string mediaType, byte[] data, int width, int height)
        => Assert.Equal((width, height), ImageFormats.ReadSize(data, mediaType));

    [Theory]
    [InlineData("image/png")]
    [InlineData("image/gif")]
    [InlineData("image/jpeg")]
    [InlineData("image/webp")]
    [InlineData("image/bmp")]
    [InlineData("image/x-icon")]
    [InlineData("image/avif")]
    [InlineData("image/svg+xml")]
    [InlineData("image/tiff")]
    public void Garbage_is_not_an_image(string mediaType)
    {
        Assert.Null(ImageFormats.ReadSize([], mediaType));
        Assert.Null(ImageFormats.ReadSize(Encoding.UTF8.GetBytes("<html><script>alert(1)</script></html>"), mediaType));
    }

    [Fact]
    public void Svg_entities_are_not_expanded()
    {
        const string Svg = """<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="&x;" height="1"/>""";
        Assert.Null(ImageFormats.ReadSize(Encoding.UTF8.GetBytes(Svg), "image/svg+xml"));
    }

    [Theory]
    [InlineData("a.PNG", "image/png")]
    [InlineData("x/y.jpeg", "image/jpeg")]
    [InlineData("a.cur", "image/x-icon")]
    [InlineData("a.txt", null)]
    [InlineData("noextension", null)]
    [InlineData("dir.png/file", null)]
    public void Media_types_follow_the_file_name(string path, string? mediaType) => Assert.Equal(mediaType, ImageFormats.MediaTypeOf(path));
}
