// Reads and writes the plugin repository manifest, manifest.json at the root, which Jellyfin reads as a PackageInfo[]
// (MediaBrowser.Model/Updates). A server installs a version only if the MD5 of the zip it downloads matches `checksum`,
// and lists it only if its own version is at least `targetAbi`.
//
//   node manifest.mjs check <manifest> [--history]
//   node manifest.mjs add <manifest> <zip> <source url> [changelog file]
//   node manifest.mjs latest <manifest>     prints the newest version's source URL and checksum, if there is one
//
// `add` takes everything but the URL, the changelog and the time from the meta.json in the zip. Adding a version that
// is already there with the same zip changes nothing, so a release can be run again, while the same version with
// another zip is refused. `check --history` also refuses a manifest that has lost or changed any version that the file
// had in a commit before, along the first parents of HEAD, which is what main has offered. It needs the whole history.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {relative} from 'node:path';
import {fileURLToPath} from 'node:url';
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
    return next;
}

/** Throws unless every version in `earlier` is still in `manifest`, unchanged: a server may have installed it. */
export function keepsEveryVersion(earlier, manifest) {
    for (const {guid, name, versions} of earlier) {
        for (const version of versions) {
            const kept = manifest.find((plugin) => plugin.guid === guid)?.versions.find((candidate) => candidate.version === version.version);
            if (!isDeepStrictEqual(kept, version)) {
                throw new Error(`${name} ${version.version} has been lost or changed`);
            }
        }
    }
}

/** Every manifest.json at `path` committed along the first parents of HEAD, newest first. */
export function committedManifests(path) {
    const git = (...args) => execFileSync('git', args, {encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
    // A shallow clone has only the last commit, which would make the check compare the manifest with itself.
    if (git('rev-parse', '--is-shallow-repository').trim() !== 'false') {
        throw new Error('The history check needs the whole history, and this clone is shallow');
    }

    return git('log', '--first-parent', '--format=%H', '--', path).split('\n').filter(Boolean)
        .map((commit) => ({commit, manifest: JSON.parse(git('show', `${commit}:./${relative('.', path)}`))}));
}

export const md5 = (buffer) => createHash('md5').update(buffer).digest('hex');

/** The meta.json inside a release zip. */
export function readMeta(zip) {
    return JSON.parse(execFileSync('unzip', ['-p', zip, 'meta.json'], {encoding: 'utf8'}));
}

export const writeManifest = (path, manifest) => writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);

// Not import.meta.main, which is undefined before Node 22.18, so the commands would do nothing and exit 0.
const isMain = (() => {
    try {
        return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
    } catch {
        return false;
    }
})();

if (isMain) {
    const [command, path, zip, sourceUrl, changelogFile] = process.argv.slice(2);
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const history = zip === '--history';
    if (command === 'check' && (history || zip === undefined)) {
        checkManifest(manifest);
        const earlier = history ? committedManifests(path) : [];
        for (const {commit, manifest: before} of earlier) {
            try {
                keepsEveryVersion(before, manifest);
            } catch (error) {
                throw new Error(`${error.message} since ${commit.slice(0, 12)}`, {cause: error});
            }
        }

        const kept = history ? `, and keeps every version of ${earlier.length} commits` : '';
        console.log(`${path} is valid${kept}: ${manifest.map(({name, versions}) => `${name} ${versions.length} versions`).join(', ') || 'empty'}`);
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
        console.error('Usage: manifest.mjs check <manifest> [--history] | add <manifest> <zip> <source url> [changelog file] | latest <manifest>');
        process.exit(2);
    }
}
