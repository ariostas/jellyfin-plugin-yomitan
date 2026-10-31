// Writes a minimal PGS (.sup) stream, so the test media has a real image subtitle track. ffmpeg cannot make one.

function segment(pts, type, payload) {
    const header = Buffer.alloc(13);
    header.write('PG', 0, 'latin1');
    header.writeUInt32BE(pts, 2);
    header.writeUInt8(type, 10);
    header.writeUInt16BE(payload.length, 11);
    return Buffer.concat([header, payload]);
}

function composition(state, objects) {
    const payload = Buffer.alloc(11 + objects * 8);
    payload.writeUInt16BE(640, 0);
    payload.writeUInt16BE(360, 2);
    payload.writeUInt8(0x10, 4);
    payload.writeUInt16BE(state ? 0 : 1, 5);
    payload.writeUInt8(state, 7);
    payload.writeUInt8(objects, 10);
    if (objects) {
        payload.writeUInt16BE(100, 15);
        payload.writeUInt16BE(300, 17);
    }

    return payload;
}

function window() {
    const payload = Buffer.alloc(10);
    payload.writeUInt8(1, 0);
    payload.writeUInt16BE(100, 2);
    payload.writeUInt16BE(300, 4);
    payload.writeUInt16BE(200, 6);
    payload.writeUInt16BE(20, 8);
    return payload;
}

/** @returns {Buffer} One 200 by 20 white box, shown from `startSeconds` to `endSeconds`. */
export function makePgs(startSeconds, endSeconds) {
    const width = 200;
    const height = 20;
    // A run of 64 or more pixels in colour 1, then the end of the line.
    const line = Buffer.from([0x00, 0xC0 | (width >> 8), width & 0xFF, 0x01, 0x00, 0x00]);
    const bitmap = Buffer.concat(Array.from({length: height}, () => line));

    const object = Buffer.alloc(11);
    object.writeUInt8(0xC0, 3);
    object.writeUIntBE(bitmap.length + 4, 4, 3);
    object.writeUInt16BE(width, 7);
    object.writeUInt16BE(height, 9);

    const start = Math.round(startSeconds * 90_000);
    const end = Math.round(endSeconds * 90_000);
    return Buffer.concat([
        segment(start, 0x16, composition(0x80, 1)),
        segment(start, 0x17, window()),
        segment(start, 0x14, Buffer.from([0, 0, 0, 0, 0, 0, 0, 1, 235, 128, 128, 255])),
        segment(start, 0x15, Buffer.concat([object, bitmap])),
        segment(start, 0x80, Buffer.alloc(0)),
        segment(end, 0x16, composition(0, 0)),
        segment(end, 0x17, window()),
        segment(end, 0x80, Buffer.alloc(0)),
    ]);
}
