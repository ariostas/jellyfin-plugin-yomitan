// Reads and writes the plugin repository manifest, manifest.json at the root, which Jellyfin reads as a PackageInfo[]
// (MediaBrowser.Model/Updates). A server installs a version only if the MD5 of the zip it downloads matches `checksum`,
// and lists it only if its own version is at least `targetAbi`.
//
//   node manifest.mjs check <manifest>
//   node manifest.mjs add <manifest> <zip> <source url> [changelog file]
//   node manifest.mjs latest <manifest>     prints the newest version's source URL and checksum, if there is one
//
// `add` takes everything but the URL, the changelog and the time from the meta.json in the zip, and writes the manifest
// back only if every version it had is still there, unchanged. Adding a version that is already there with the same zip
// changes nothing, so a release can be run again, while the same version with another zip is refused.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {isDeepStrictEqual} from 'node:util';

const PACKAGE_FIELDS = ['guid', 'name', 'overview', 'description', 'owner', 'category'];
const VERSION_FIELDS = ['version', 'changelog', 'targetAbi', 'sourceUrl', 'checksum', 'timestamp'];
const FOUR_PARTS = /^\d+\.\d+\.\d+\.\d+$/;

/** Orders as System.Version does. */
export function compareVersions(a, b) {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let index = 0; index < 4; index++) {
        if (left[index] !== right[index]) {
            return left[index] - right[index];
        }
    }

    return 0;
}

/** Throws on anything Jellyfin would read differently from what was meant. */
export function checkManifest(manifest) {
    if (!Array.isArray(manifest)) {
        throw new Error('The manifest is not an array of packages');
    }

    for (const plugin of manifest) {
        for (const field of PACKAGE_FIELDS) {
            if (typeof plugin[field] !== 'string' || plugin[field] === '') {
                throw new Error(`A package has no ${field}`);
            }
        }

        if (!Array.isArray(plugin.versions)) {
            throw new Error(`${plugin.name} has no versions`);
        }

        for (const entry of plugin.versions) {
            for (const field of VERSION_FIELDS) {
                if (typeof entry[field] !== 'string') {
                    throw new Error(`${plugin.name} ${entry.version}: ${field} is not a string`);
                }
            }

            if (!FOUR_PARTS.test(entry.version) || !FOUR_PARTS.test(entry.targetAbi)) {
                throw new Error(`${plugin.name} ${entry.version}: version and targetAbi need four parts`);
            }

            if (!/^[0-9a-f]{32}$/.test(entry.checksum)) {
                throw new Error(`${plugin.name} ${entry.version}: the checksum is not an MD5 in lower case hex`);
            }

            if (Number.isNaN(Date.parse(entry.timestamp)) || !URL.canParse(entry.sourceUrl)) {
                throw new Error(`${plugin.name} ${entry.version}: the timestamp or the source URL does not parse`);
            }
        }

        const versions = plugin.versions.map(({version}) => version);
        const sorted = [...versions].sort((a, b) => compareVersions(b, a));
        if (new Set(versions).size !== versions.length || !isDeepStrictEqual(versions, sorted)) {
            // The server merges repositories assuming the newest comes first.
            throw new Error(`${plugin.name}: versions must be unique and newest first`);
        }
    }
}

/** Returns a new manifest with the version in `zip` added. */
export function addVersion(manifest, {meta, checksum, sourceUrl, changelog, timestamp}) {
    checkManifest(manifest);
    const index = manifest.findIndex(({guid}) => guid === meta.guid);
    const versions = manifest[index]?.versions ?? [];

    const existing = versions.find(({version}) => version === meta.version);
    if (existing) {
        if (existing.checksum !== checksum || existing.sourceUrl !== sourceUrl) {
            throw new Error(`${meta.version} is already in the manifest, with another zip`);
        }

        return manifest;
    }

    // What a package says about itself comes from its newest release, in the order of Jellyfin's own repository.
    const entry = {version: meta.version, changelog, targetAbi: meta.targetAbi, sourceUrl, checksum, timestamp};
    const plugin = {
        ...Object.fromEntries(PACKAGE_FIELDS.map((field) => [field, meta[field]])),
        imageUrl: manifest[index]?.imageUrl ?? null,
        versions: [...structuredClone(versions), entry].sort((a, b) => compareVersions(b.version, a.version)),
    };
    const next = structuredClone(manifest);
    next.splice(index === -1 ? next.length : index, index === -1 ? 0 : 1, plugin);
    checkManifest(next);

    // Nothing that was there before may go or change.
    const before = manifest.flatMap(({guid, versions}) => versions.map((version) => ({guid, version})));
    for (const {guid, version} of before) {
        const kept = next.find((candidate) => candidate.guid === guid)?.versions.find((candidate) => candidate.version === version.version);
        if (!isDeepStrictEqual(kept, version)) {
            throw new Error(`Adding ${meta.version} would have lost or changed ${version.version}`);
        }
    }

    return next;
}

export const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');

/** The meta.json inside a release zip. */
export function readMeta(zip) {
    return JSON.parse(execFileSync('unzip', ['-p', zip, 'meta.json'], {encoding: 'utf8'}));
}

export const writeManifest = (path, manifest) => writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

if (import.meta.main) {
    const [command, path, zip, sourceUrl, changelogFile] = process.argv.slice(2);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    if (command === 'check') {
        checkManifest(manifest);
        console.log(`${path} is valid: ${manifest.map(({name, versions}) => `${name} ${versions.length} versions`).join(', ') || 'empty'}`);
    } else if (command === 'latest') {
        checkManifest(manifest);
        const newest = manifest[0]?.versions[0];
        if (newest) {
            console.log(`${newest.sourceUrl} ${newest.checksum}`);
        }
    } else if (command === 'add' && sourceUrl) {
        const next = addVersion(manifest, {
            meta: readMeta(zip),
            checksum: md5(readFileSync(zip)),
            sourceUrl,
            changelog: changelogFile ? readFileSync(changelogFile, 'utf8').trim() : '',
            timestamp: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
        });
        writeManifest(path, next);
        console.log(next === manifest ? `${path} already has this zip` : `Added ${readMeta(zip).version} to ${path}`);
    } else {
        console.error('Usage: manifest.mjs check <manifest> | add <manifest> <zip> <source url> [changelog file] | latest <manifest>');
        process.exit(2);
    }
}
