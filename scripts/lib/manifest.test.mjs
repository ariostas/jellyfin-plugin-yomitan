// Run with `node --test scripts/lib/*.test.mjs`. The release writes manifest.json with this, so it must never lose a version.
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {addVersion, checkManifest, keepsEveryVersion} from './manifest.mjs';

const cli = fileURLToPath(new URL('manifest.mjs', import.meta.url));

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

test('a manifest that lost or changed a version an earlier one had is refused', () => {
    const earlier = addVersion(addVersion([], release('0.1.0.0')), release('0.2.0.0'));
    assert.doesNotThrow(() => keepsEveryVersion(earlier, addVersion(earlier, release('0.3.0.0'))));

    const lost = structuredClone(earlier);
    lost[0].versions.shift();
    assert.throws(() => keepsEveryVersion(earlier, lost), /Yomitan 0.2.0.0 has been lost or changed/);

    const changed = structuredClone(earlier);
    changed[0].versions[1].checksum = 'c'.repeat(32);
    assert.throws(() => keepsEveryVersion(earlier, changed), /Yomitan 0.1.0.0 has been lost or changed/);

    assert.throws(() => keepsEveryVersion(earlier, []), /lost or changed/);
});

// Runs the command line in a repository of its own, as CI and the release run it, so that a command that does nothing
// fails here: before Node 22.18, import.meta.main was undefined.
test('the command line checks the manifest against every commit of it, and fails loudly', (t) => {
    const directory = mkdtempSync(join(tmpdir(), 'yomitan-manifest-'));
    t.after(() => rmSync(directory, {recursive: true, force: true}));
    const env = {...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1'};
    const git = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {cwd: directory, env});
    const write = (manifest) => writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest));
    const check = (...args) => spawnSync(process.execPath, [cli, 'check', 'manifest.json', ...args], {cwd: directory, env, encoding: 'utf8'});

    git('init', '--quiet');
    const first = addVersion([], release('0.1.0.0'));
    write(first);
    git('add', 'manifest.json');
    git('commit', '--quiet', '-m', 'first');
    const second = addVersion(first, release('0.2.0.0'));
    write(second);
    git('commit', '--quiet', '-am', 'second');
    assert.equal(check('--history').status, 0);

    // Dropped in a later commit, so the commit before it is what notices.
    const dropped = structuredClone(second);
    dropped[0].versions.pop();
    write(dropped);
    git('commit', '--quiet', '-am', 'dropped');
    assert.equal(check().status, 0);
    const refused = check('--history');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /Yomitan 0.1.0.0 has been lost or changed since/);

    write({});
    assert.equal(check().status, 1);
    assert.match(check().stderr, /not an array/);
    assert.equal(spawnSync(process.execPath, [cli, 'check', 'manifest.json', 'extra'], {cwd: directory, env}).status, 2);

    // A shallow clone would compare the manifest only with itself.
    git('reset', '--quiet', '--hard', 'HEAD~1');
    execFileSync('git', ['clone', '--quiet', '--depth', '1', `file://${directory}`, 'shallow'], {cwd: directory, env});
    const shallow = spawnSync(process.execPath, [cli, 'check', 'manifest.json', '--history'], {cwd: join(directory, 'shallow'), env, encoding: 'utf8'});
    assert.equal(shallow.status, 1);
    assert.match(shallow.stderr, /shallow/);
});
