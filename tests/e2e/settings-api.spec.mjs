// The settings API against real accounts: who can read and write what, and everything the server refuses.
import {expect, test} from '@playwright/test';
import {clientFor} from '../lib/dictionaries.mjs';
import {api, createUser, credentials, defaultSettings, deleteUser, server} from '../lib/jellyfin.mjs';

let alice;
let bob;
let aliceClient;
let bobClient;

const put = (client, body, init = {}) => client.send('/Yomitan/Settings', {
    method: 'PUT',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: {'Content-Type': 'application/json'},
    ...init,
});
const read = async (client) => (await client.send('/Yomitan/Settings')).json();

test.beforeAll(async () => {
    alice = await createUser('alice');
    bob = await createUser('bob');
    aliceClient = await clientFor(alice.username, alice.password);
    bobClient = await clientFor(bob.username, bob.password);
});

test.afterAll(async () => {
    await deleteUser(alice);
    await deleteUser(bob);
});

test('a user who has saved nothing has the defaults, and the feature is off', async () => {
    const user = await createUser('fresh');
    const client = await clientFor(user.username, user.password);
    expect(await read(client)).toEqual({revision: 0, settings: defaultSettings});
    await deleteUser(user);
});

test('a save changes what it names and leaves the rest', async () => {
    const before = await read(aliceClient);
    const response = await put(aliceClient, {fontScale: 140});
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const saved = await response.json();
    expect(saved.revision).toBe(before.revision + 1);
    expect(saved.settings).toEqual({...before.settings, fontScale: 140});
    expect(await read(aliceClient)).toEqual(saved);
});

test('an empty save changes nothing, not even the revision', async () => {
    const before = await read(aliceClient);
    expect(await (await put(aliceClient, {})).json()).toEqual(before);
});

test('saves at the same moment all land, so two devices keep both changes', async () => {
    const before = await read(aliceClient);
    const values = [
        {hoverDelayMs: 111}, {hoverGraceMs: 222}, {upOnlyEntry: true}, {fontScale: 150}, {enabled: true},
        {dictionaryOrder: ['A', 'B']}, {disabledDictionaries: ['C']}, {introSeen: true},
    ];
    const responses = await Promise.all(values.map((value) => put(aliceClient, value)));
    expect(responses.map(({status}) => status)).toEqual(values.map(() => 200));
    const after = await read(aliceClient);
    expect(after.settings).toEqual(Object.assign({}, ...values));
    expect(after.revision).toBe(before.revision + values.length);
});

test.describe('one user is not another', () => {
    test('a save by one is not seen by the other', async () => {
        await put(aliceClient, {fontScale: 222});
        await put(bobClient, {fontScale: 77});
        expect((await read(aliceClient)).settings.fontScale).toBe(222);
        expect((await read(bobClient)).settings.fontScale).toBe(77);
    });

    test('no way of naming a user reaches that user', async () => {
        await put(aliceClient, {hoverDelayMs: 400});
        await put(bobClient, {hoverDelayMs: 900});

        // In the query string, in the path, in the body, and in the header, whose other fields a client writes itself.
        for (const path of [`/Yomitan/Settings?userId=${alice.id}`, `/Yomitan/Settings?UserId=${alice.id}`, `/Yomitan/Settings?user=${alice.id}`]) {
            expect((await (await bobClient.send(path)).json()).settings.hoverDelayMs, path).toBe(900);
            const response = await bobClient.send(path, {method: 'PUT', body: '{"hoverDelayMs": 1}', headers: {'Content-Type': 'application/json'}});
            expect((await response.json()).settings.hoverDelayMs, path).toBe(1);
            await put(bobClient, {hoverDelayMs: 900});
        }

        for (const method of ['GET', 'PUT']) {
            expect((await bobClient.send(`/Yomitan/Settings/${alice.id}`, {method})).status).toBe(404);
            expect((await bobClient.send(`/Users/${alice.id}/Yomitan/Settings`, {method})).status).toBe(404);
        }

        const namedInBody = await put(bobClient, {userId: alice.id, hoverDelayMs: 1});
        expect(namedInBody.status).toBe(400);
        expect((await namedInBody.json()).error.code).toBe('unknown_setting');

        const spoofed = await fetch(`${server.url}/Yomitan/Settings`, {
            headers: {Authorization: `MediaBrowser Client="x", Device="x", DeviceId="x", Version="1", UserId="${alice.id}", Token="${bobClient.token}"`},
        });
        expect((await spoofed.json()).settings.hoverDelayMs).toBe(900);

        expect((await read(aliceClient)).settings.hoverDelayMs).toBe(400);
    });

    test('an admin has no way in either', async () => {
        await put(aliceClient, {hoverDelayMs: 401});
        const admin = await clientFor(credentials.username, credentials.password);
        const own = (await read(admin)).settings.hoverDelayMs;
        expect((await (await admin.send(`/Yomitan/Settings?userId=${alice.id}`)).json()).settings.hoverDelayMs).toBe(own);
        expect(own).not.toBe(401);
    });

    test('nobody gets in without a valid token', async () => {
        for (const method of ['GET', 'PUT']) {
            expect((await fetch(`${server.url}/Yomitan/Settings`, {method})).status).toBe(401);
            const response = await fetch(`${server.url}/Yomitan/Settings`, {method, headers: {Authorization: 'MediaBrowser Token="nonsense"'}});
            expect(response.status).toBe(401);
        }
    });

    test('an API key belongs to nobody, so it has no settings', async () => {
        await api('/Auth/Keys?app=yomitan-tests', {method: 'POST'});
        const {Items: keys} = await api('/Auth/Keys');
        const {AccessToken: key} = keys.find(({AppName}) => AppName === 'yomitan-tests');
        try {
            for (const path of ['/Yomitan/Settings', `/Yomitan/Settings?userId=${alice.id}`]) {
                const response = await fetch(`${server.url}${path}`, {headers: {Authorization: `MediaBrowser Token="${key}"`}});
                expect(response.status).toBe(400);
                expect((await response.json()).error.code).toBe('no_user');
            }
        } finally {
            await api(`/Auth/Keys/${key}`, {method: 'DELETE'});
        }
    });
});

test.describe('the server refuses', () => {
    const tooMany = Array.from({length: 257}, (_, index) => `Title ${index}`);
    const refused = [
        [{enabled: 'true'}, 'invalid_setting'],
        [{enabled: 1}, 'invalid_setting'],
        [{enabled: null}, 'invalid_setting'],
        [{upOnlyEntry: 'yes'}, 'invalid_setting'],
        [{introSeen: null}, 'invalid_setting'],
        [{hoverDelayMs: -1}, 'invalid_setting'],
        [{hoverDelayMs: 5001}, 'invalid_setting'],
        [{hoverDelayMs: 1.5}, 'invalid_setting'],
        [{hoverDelayMs: '200'}, 'invalid_setting'],
        [{hoverGraceMs: 5001}, 'invalid_setting'],
        [{hoverGraceMs: -1}, 'invalid_setting'],
        [{fontScale: 49}, 'invalid_setting'],
        [{fontScale: 301}, 'invalid_setting'],
        [{fontScale: null}, 'invalid_setting'],
        [{dictionaryOrder: 'JMdict'}, 'invalid_setting'],
        [{dictionaryOrder: [1]}, 'invalid_setting'],
        [{dictionaryOrder: ['']}, 'invalid_setting'],
        [{dictionaryOrder: ['A', 'A']}, 'invalid_setting'],
        [{dictionaryOrder: tooMany}, 'invalid_setting'],
        [{dictionaryOrder: ['x'.repeat(4097)]}, 'invalid_setting'],
        [{disabledDictionaries: [null]}, 'invalid_setting'],
        [{disabledDictionaries: tooMany}, 'invalid_setting'],
        [{nope: 1}, 'unknown_setting'],
        [{Enabled: true}, 'unknown_setting'],
        [{'__proto__x': 1}, 'unknown_setting'],
        [{enabled: true, extra: 1}, 'unknown_setting'],
        [{fontScale: 100, hoverDelayMs: 9999}, 'invalid_setting'],
        [[], 'invalid_request'],
        ['"text"', 'invalid_request'],
        ['12', 'invalid_request'],
        ['null', 'invalid_request'],
        ['{"enabled": true, "enabled": false}', 'invalid_request'],
        ['{"dictionaryOrder": ["\\ud800"]}', 'invalid_setting'],
        ['{not json', 'invalid_json'],
        ['', 'invalid_json'],
    ];

    for (const [body, code] of refused) {
        const label = typeof body === 'string' ? body : JSON.stringify(body);
        test(`${label.slice(0, 60)} with ${code}, and saves nothing`, async () => {
            const before = await read(aliceClient);
            const response = await put(aliceClient, body);
            expect(response.status).toBe(400);
            const {error} = await response.json();
            expect(error.code).toBe(code);
            expect(typeof error.message).toBe('string');
            expect(await read(aliceClient)).toEqual(before);
        });
    }

    test('a body past the limit', async () => {
        const response = await put(aliceClient, `{"dictionaryOrder": ["${'x'.repeat(1 << 20)}"]}`);
        expect(response.status).toBe(413);
        expect((await response.json()).error.code).toBe('limit_exceeded');
    });
});

test('what passes at the edges', async () => {
    const edges = {hoverDelayMs: 0, hoverGraceMs: 5000, fontScale: 300};
    expect((await (await put(aliceClient, edges)).json()).settings).toMatchObject(edges);
    expect((await (await put(aliceClient, {fontScale: 50, hoverDelayMs: 5000, hoverGraceMs: 0})).json()).settings.fontScale).toBe(50);
    const titles = Array.from({length: 256}, (_, index) => `Title ${index}`);
    const saved = await (await put(aliceClient, {dictionaryOrder: titles, disabledDictionaries: ['x'.repeat(4096), '<img src=x onerror=alert(1)>']})).json();
    expect(saved.settings.dictionaryOrder).toEqual(titles);
    expect(saved.settings.disabledDictionaries[1]).toBe('<img src=x onerror=alert(1)>');
});
