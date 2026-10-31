// Takes a fresh Jellyfin through its startup wizard and adds the test library. Safe to run again.
// Usage: node provision.mjs <server url including any BaseUrl>

const server = process.argv[2];
const user = {Name: 'spike', Password: 'spike'};
const auth = 'MediaBrowser Client="yomitan-dev", Device="dev", DeviceId="yomitan-dev", Version="1"';
const expectedMovies = 6;
const expectedEpisodes = 2;
const timeoutMs = 120_000;

async function call(path, {method = 'GET', body, token} = {}) {
    const response = await fetch(server + path, {
        method,
        headers: {
            Authorization: token ? `${auth}, Token="${token}"` : auth,
            'Content-Type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`${method} ${path} returned ${response.status}: ${await response.text()}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : null;
}

async function waitFor(what, check) {
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        try {
            const result = await check();
            if (result) {
                return result;
            }
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`Timed out waiting for ${what}. Last error: ${lastError?.message ?? 'none'}`);
}

async function runWizard() {
    await call('/Startup/Configuration', {
        method: 'POST',
        body: {UICulture: 'en-US', MetadataCountryCode: 'US', PreferredMetadataLanguage: 'en'},
    });
    await call('/Startup/User');
    await call('/Startup/User', {method: 'POST', body: user});
    await call('/Startup/RemoteAccess', {
        method: 'POST',
        body: {EnableRemoteAccess: true, EnableAutomaticPortMapping: false},
    });
    await call('/Startup/Complete', {method: 'POST'});
}

async function addLibrary(token, name, collectionType, path) {
    const folders = await call('/Library/VirtualFolders', {token});
    if (folders.some((folder) => folder.Name === name)) {
        return;
    }
    await call(`/Library/VirtualFolders?name=${name}&collectionType=${collectionType}&refreshLibrary=true`, {
        method: 'POST',
        token,
        body: {
            LibraryOptions: {
                EnableInternetProviders: false,
                EnableRealtimeMonitor: false,
                PathInfos: [{Path: path}],
            },
        },
    });
}

// While it migrates, the server runs a stand-in that answers /System/Info/Public and 503s everything else.
await waitFor('the server', () => call('/Branding/Configuration'));
const info = await call('/System/Info/Public');
if (!info.StartupWizardCompleted) {
    await runWizard();
}

// The wizard's user is not always usable at once, so retry.
const {AccessToken: token, User: {Id: userId}} = await waitFor('login', () =>
    call('/Users/AuthenticateByName', {method: 'POST', body: {Username: user.Name, Pw: user.Password}}));

await addLibrary(token, 'Movies', 'movies', '/media/Movies');
await addLibrary(token, 'Shows', 'tvshows', '/media/Shows');
if (process.env.JF_EXTRA_MEDIA) {
    await addLibrary(token, 'Extra', 'movies', '/extra/Movies');
}

// The scan that adding a library starts can finish without seeing the new folder, so keep asking for one.
await waitFor('the library scan', async () => {
    const count = async (type) => (await call(
        `/Items?userId=${userId}&recursive=true&includeItemTypes=${type}`, {token})).TotalRecordCount;
    const done = await count('Movie') >= expectedMovies && await count('Episode') >= expectedEpisodes;
    if (!done) {
        await call('/Library/Refresh', {method: 'POST', token});
    }
    return done;
});

const plugins = await call('/Plugins', {token});
for (const plugin of plugins.filter((candidate) => candidate.CanUninstall)) {
    console.log(`Plugin ${plugin.Name} ${plugin.Version}: ${plugin.Status}`);
}
const yomitan = plugins.find((plugin) => plugin.Name === 'Yomitan');
if (yomitan?.Status !== 'Active') {
    throw new Error(`The Yomitan plugin is not active: ${JSON.stringify(yomitan)}`);
}
