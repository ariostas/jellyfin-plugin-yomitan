// Run with `node --test scripts/lib/*.test.mjs`. The release writes manifest.json with this, so it must never lose a version.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {addVersion, checkManifest} from './manifest.mjs';

const meta = (version) => ({
    guid: '95f2db49-f966-44b9-a94f-4784792339fb',
    name: 'Yomitan',
    overview: 'Overview',
    description: 'Description',
    owner: 'ariostas',
    category: 'Subtitles',
    targetAbi: '12.0.0.0',
    version,
});

const release = (version, checksum = 'a'.repeat(32)) => ({
    meta: meta(version),
    checksum,
    sourceUrl: `https://example.com/yomitan_${version}.zip`,
    changelog: `- ${version}`,
    timestamp: '2026-11-02T00:00:00Z',
});

test('the first release makes the package, in the fields Jellyfin reads', () => {
    const manifest = addVersion([], release('0.1.0.0'));
    assert.deepEqual(manifest, [{
        guid: meta().guid,
        name: 'Yomitan',
        overview: 'Overview',
        description: 'Description',
        owner: 'ariostas',
        category: 'Subtitles',
        imageUrl: null,
        versions: [{
            version: '0.1.0.0',
            changelog: '- 0.1.0.0',
            targetAbi: '12.0.0.0',
            sourceUrl: 'https://example.com/yomitan_0.1.0.0.zip',
            checksum: 'a'.repeat(32),
            timestamp: '2026-11-02T00:00:00Z',
        }],
    }]);
});

test('a new version goes first and keeps every older one as it was', () => {
    let manifest = addVersion([], release('0.9.0.0'));
    manifest = addVersion(manifest, release('0.10.0.0'));
    manifest = addVersion(manifest, release('0.9.1.0'));
    assert.deepEqual(manifest[0].versions.map(({version}) => version), ['0.10.0.0', '0.9.1.0', '0.9.0.0']);
});

test('another plugin in the same manifest is left alone', () => {
    const other = {...addVersion([], release('3.0.0.0'))[0], guid: '5e87cc92-571a-4d8d-8d98-d2d4147f9f90', name: 'Other'};
    const manifest = addVersion([other], release('0.1.0.0'));
    assert.deepEqual(manifest[0], other);
});

test('running the same release again changes nothing, and another zip under its version is refused', () => {
    const manifest = addVersion([], release('0.1.0.0'));
    assert.equal(addVersion(manifest, release('0.1.0.0')), manifest);
    assert.throws(() => addVersion(manifest, release('0.1.0.0', 'b'.repeat(32))), /another zip/);
});

test('a manifest that is not what Jellyfin reads is refused before anything is added', () => {
    assert.throws(() => addVersion({}, release('0.1.0.0')), /not an array/);
    const manifest = addVersion([], release('0.1.0.0'));
    manifest[0].versions[0].checksum = 'A'.repeat(32);
    assert.throws(() => checkManifest(manifest), /MD5/);
    manifest[0].versions[0].checksum = 'a'.repeat(32);
    manifest[0].versions.push({...manifest[0].versions[0], version: '0.2.0.0'});
    assert.throws(() => checkManifest(manifest), /newest first/);
    assert.throws(() => addVersion([], release('0.1.0')), /four parts/);
});
