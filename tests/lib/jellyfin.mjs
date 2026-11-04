// Helpers for talking to a server started by scripts/dev.sh. They read the same JF_* variables it does.
import http from 'node:http';
import {expect} from '@playwright/test';

const port = process.env.JF_PORT ?? '18096';
const prefix = process.env.JF_BASE_URL ?? '';

export const server = {
    name: process.env.JF_NAME ?? 'jf-yomitan',
    origin: `http://127.0.0.1:${port}`,
    prefix,
    url: `http://127.0.0.1:${port}${prefix}`,
    withFileTransformation: process.env.JF_WITH_FT === '1',
};

export const credentials = {username: 'spike', password: 'spike'};

export const clientScript = 'script[data-yomitan-client]';

const authHeader = 'MediaBrowser Client="yomitan-tests", Device="tests", DeviceId="yomitan-tests", Version="1"';

let adminToken;

/** Calls the Jellyfin API as the admin and returns the parsed response, or null if it has no body. */
export async function api(path, {method = 'GET', body} = {}) {
    adminToken ??= (await login()).AccessToken;
    const response = await fetch(server.url + path, {
        method,
        headers: {Authorization: `${authHeader}, Token="${adminToken}"`, 'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

async function login() {
    const response = await fetch(`${server.url}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {Authorization: authHeader, 'Content-Type': 'application/json'},
        body: JSON.stringify({Username: credentials.username, Pw: credentials.password}),
    });
    expect(response.ok).toBe(true);
    return response.json();
}

/**
 * Sends one request and returns it exactly as the server answered. fetch() would decompress the body and
 * hide what the headers really describe.
 */
export function rawRequest(path, {method = 'GET', headers = {}} = {}) {
    return new Promise((resolve, reject) => {
        const request = http.request(`${server.url}${path}`, {method, headers}, (response) => {
            const chunks = [];
            response.on('data', (chunk) => chunks.push(chunk));
            response.on('end', () => {
                const body = Buffer.concat(chunks);
                resolve({status: response.statusCode, headers: response.headers, body, text: body.toString('utf8')});
            });
        });
        request.on('error', reject);
        request.end();
    });
}

/** Returns the id of each movie, keyed by file name without the year. */
export async function getMovies() {
    const [user] = await api('/Users');
    const {Items: items} = await api(`/Items?userId=${user.Id}&recursive=true&includeItemTypes=Movie`);
    return Object.fromEntries(items.map((item) => [item.Name.replace(/ \(\d{4}\)$/, ''), item.Id]));
}

/** Returns the id of each episode, in order. */
export async function getEpisodes() {
    const [user] = await api('/Users');
    const {Items: items} = await api(`/Items?userId=${user.Id}&recursive=true&includeItemTypes=Episode&sortBy=IndexNumber`);
    return items.map((item) => item.Id);
}

/** What a user who has saved nothing has. tests/e2e/settings-api.spec.mjs checks this against the server. */
export const defaultSettings = {
    enabled: false,
    hoverDelayMs: 200,
    hoverGraceMs: 300,
    upOnlyEntry: null,
    fontScale: 100,
    dictionaryOrder: [],
    disabledDictionaries: [],
    introSeen: false,
};

/**
 * Makes a real account, with no admin rights and the default access to every library.
 * @param {string} name
 * @returns {Promise<{id: string, username: string, password: string}>}
 */
export async function createUser(name) {
    const username = `${name}-${Date.now().toString(36)}`;
    const password = `${name}-password`;
    const {Id: id} = await api('/Users/New', {method: 'POST', body: {Name: username, Password: password}});
    return {id, username, password};
}

export function deleteUser({id}) {
    return api(`/Users/${id}`, {method: 'DELETE'});
}

/** Signs a user out from the page itself, as the app does, and waits for the login page. */
export async function signOut(page) {
    await page.evaluate(() => window.Dashboard.logout());
    await page.locator('#txtManualName, .btnManual').first().waitFor();
}

/** Fills in the login form, and waits for the home page. */
export async function fillLogin(page, {username, password}) {
    await page.locator('#txtManualName, .btnManual').first().waitFor();
    if (await page.locator('.btnManual').isVisible()) {
        await page.locator('.btnManual').click();
    }
    await page.locator('#txtManualName').fill(username);
    await page.locator('#txtManualPassword').fill(password);
    await page.locator('.manualLoginForm .button-submit').click();
    await page.waitForURL(/#\/home/);
    // Leaving home calls pause() on each of its item rows, and jellyfin-web throws if a row has not been set up yet. The
    // login page keeps a row of its own that never is, so only home's count.
    await page.waitForFunction(() => {
        const rows = [...document.querySelectorAll('#indexPage .itemsContainer')];
        return rows.length > 0 && rows.every((row) => typeof row.pause === 'function');
    });
}

/**
 * Opens jellyfin-web and logs in through the form, as the admin unless told otherwise. The feature is off by default, so
 * this first sets the user's real settings on the server: on, and everything else at its default, so that nothing a test
 * saved reaches the next one, apart from the notice that introduces the button, which is seen, as only its own tests want
 * it. Pass `settings: null` to leave them alone, as for a user who is new.
 * @param {import('@playwright/test').Page} page
 * @param {object} [options]
 * @param {{username: string, password: string}} [options.user]
 * @param {object|null} [options.settings] Saved on top of the defaults.
 */
export async function logIn(page, {user = credentials, settings = {enabled: true}} = {}) {
    if (settings) {
        await saveSettings(user, {...defaultSettings, introSeen: true, ...settings});
    }

    await page.goto('web/');
    await fillLogin(page, user);
}

const settingsTokens = new Map();

/** Signs a user in once. A second login on one device id would end the first one's token. */
async function settingsToken({username, password}) {
    if (!settingsTokens.has(username)) {
        const response = await fetch(`${server.url}/Users/AuthenticateByName`, {
            method: 'POST',
            headers: {Authorization: `MediaBrowser Client="yomitan-tests", Device="tests", DeviceId="yomitan-settings-${username}", Version="1"`, 'Content-Type': 'application/json'},
            body: JSON.stringify({Username: username, Pw: password}),
        });
        expect(response.ok).toBe(true);
        settingsTokens.set(username, (await response.json()).AccessToken);
    }

    return settingsTokens.get(username);
}

/** Saves a user's settings through the API, under their own token, as a client does. */
export async function saveSettings(user, settings) {
    const saved = await fetch(`${server.url}/Yomitan/Settings`, {
        method: 'PUT',
        headers: {Authorization: `${authHeader}, Token="${await settingsToken(user)}"`, 'Content-Type': 'application/json'},
        body: JSON.stringify(settings),
    });
    expect(saved.status).toBe(200);
}

/** Reads a user's settings through the API, under their own token. */
export async function readSettings(user) {
    const response = await fetch(`${server.url}/Yomitan/Settings`, {headers: {Authorization: `${authHeader}, Token="${await settingsToken(user)}"`}});
    expect(response.status).toBe(200);
    return (await response.json()).settings;
}

/**
 * Starts a movie in the page's own client through the Sessions API, the way "play on" does. Going through
 * the UI would tie every test to the layout, and playbackManager is not reachable from the page.
 */
export async function play(page, itemId, {minimumTime = 3, subtitleStreamIndex} = {}) {
    // jellyfin-web keeps the cues of a track that is still downloading when another is chosen, so its native track then
    // holds both, with the plugin off too. A person cannot choose that fast, so the choice below waits for the first
    // track to land. Only jellyfin-web's own downloads have two numbers after Subtitles/.
    const downloads = new Set();
    const onRequest = (request) => /\/Subtitles\/\d+\/\d+\/Stream\.js/.test(request.url()) && downloads.add(request);
    const onDone = (request) => downloads.delete(request);
    page.on('request', onRequest);
    page.on('requestfinished', onDone);
    page.on('requestfailed', onDone);
    try {
        return await playWith(page, itemId, {minimumTime, subtitleStreamIndex, downloads});
    } finally {
        page.off('request', onRequest);
        page.off('requestfinished', onDone);
        page.off('requestfailed', onDone);
    }
}

async function playWith(page, itemId, {minimumTime, subtitleStreamIndex, downloads}) {
    const deviceId = await page.evaluate(() => window.ApiClient.deviceId());
    let session;
    await expect.poll(async () => {
        [session] = await api(`/Sessions?deviceId=${encodeURIComponent(deviceId)}`);
        return session?.Id;
    }).toBeTruthy();

    await api(`/Sessions/${session.Id}/Playing?playCommand=PlayNow&itemIds=${itemId}`, {method: 'POST'});
    await page.waitForFunction((time) => {
        const video = document.querySelector('video.htmlvideoplayer');
        return video && video.currentTime > time && !video.paused;
    }, subtitleStreamIndex === undefined ? minimumTime : 0, {timeout: 45_000});

    // jellyfin-web ignores a subtitle index in the play command, so choose the track the way a remote control does.
    if (subtitleStreamIndex !== undefined) {
        // Its cues go in just after the download, so the quiet has to last a moment.
        await expect.poll(async () => {
            const quiet = downloads.size === 0;
            await page.waitForTimeout(300);
            return quiet && downloads.size === 0;
        }).toBe(true);
        await api(`/Sessions/${session.Id}/Command`, {
            method: 'POST',
            body: {Name: 'SetSubtitleStreamIndex', Arguments: {Index: `${subtitleStreamIndex}`}},
        });
        await page.waitForFunction((time) => {
            const video = document.querySelector('video.htmlvideoplayer');
            return video && video.currentTime > time && !video.paused;
        }, minimumTime, {timeout: 45_000});
    }

    return session.Id;
}
