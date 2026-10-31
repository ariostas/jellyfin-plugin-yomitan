// A small zip writer. Real tools refuse to produce the hostile archives these tests need.
import {crc32, deflateRawSync} from 'node:zlib';

/**
 * Builds an archive. Each entry is {name, data, stored?, declaredSize?}. declaredSize is what the headers claim
 * the entry decompresses to, whatever is really there.
 */
export function makeZip(entries) {
    const locals = [];
    const centrals = [];
    let offset = 0;
    for (const {name, data, stored = false, declaredSize} of entries) {
        const nameBytes = Buffer.from(name, 'utf8');
        const content = Buffer.from(data);
        const body = stored ? content : deflateRawSync(content);
        const common = Buffer.alloc(26);
        common.writeUInt16LE(20, 0); // version needed
        common.writeUInt16LE(0x0800, 2); // UTF-8 names
        common.writeUInt16LE(stored ? 0 : 8, 4);
        common.writeUInt32LE(crc32(content), 10);
        common.writeUInt32LE(body.length, 14);
        common.writeUInt32LE(declaredSize ?? content.length, 18);
        common.writeUInt16LE(nameBytes.length, 22);

        const signature = Buffer.alloc(4);
        signature.writeUInt32LE(0x04034b50);
        const local = Buffer.concat([signature, common, nameBytes, body]);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014b50, 0);
        central.writeUInt16LE(20, 4);
        common.copy(central, 6);
        central.writeUInt32LE(offset, 42);
        centrals.push(central, nameBytes);
        locals.push(local);
        offset += local.length;
    }

    const directory = Buffer.concat(centrals);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...locals, directory, end]);
}

/** Builds a dictionary from an index and a map of file name to JSON value, string or bytes. */
export function makeDictionary(index, files = {}) {
    const encode = (value) => (typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value));
    return makeZip([
        {name: 'index.json', data: JSON.stringify(index)},
        ...Object.entries(files).map(([name, value]) => ({name, data: encode(value)})),
    ]);
}
