// The client's settings, in one place. The loader creates the only instance and hands it to the engine, so everything
// reads through this.
//
// The server holds them, per user. localStorage is only the last copy this browser saw of each user's settings, so
// playback never waits on the network: a value is there at once, and whatever the server says arrives as a `change`
// event. A change is kept in the cache too until the server has taken it, so it survives a reload or a dead network.

const STORAGE_PREFIX = 'yomitan.settings.';
/** A slider sends many changes. Waiting this long makes them one request. */
const WRITE_DELAY_MS = 250;
/** Between attempts at a write that failed. The last one repeats for as long as the page lives. */
const RETRY_DELAYS_MS = [2000, 5000, 15_000, 30_000, 60_000];
/** How often coming back to a tab may ask the server. Starting a video always may. */
const REFRESH_INTERVAL_MS = 30_000;
/** A request on a dead network can hang for minutes, and only one runs at a time. */
const REQUEST_TIMEOUT_MS = 15_000;
/** A timeout and too many requests say nothing about the value. */
const WORTH_REPEATING = new Set([408, 429]);

export const DEFAULT_SETTINGS = Object.freeze({
    /** Whether the plugin does anything at all. Off means playback is exactly what jellyfin-web does alone. */
    enabled: false,
    /** How long the mouse has to rest on a word before it pauses, so one passing over the line on its way does not. */
    hoverDelayMs: 200,
    /** How long the popup survives the mouse leaving it and the word, so it can cross the gap between them. */
    hoverGraceMs: 300,
    /** Whether only Up enters word mode, which leaves Left and Right to the OSD's buttons while paused. */
    upOnlyEntry: false,
    /** The size of the lines, in percent of what fits the screen. */
    fontScale: 100,
    /** Titles in the order this user wants them. Anything not listed comes after, in import order. */
    dictionaryOrder: Object.freeze([]),
    /** Titles this user has turned off. Anything not listed is on, so a new dictionary works without asking. */
    disabledDictionaries: Object.freeze([]),
});

/** The same bounds as the server's, which is what enforces them. Here they only shape the controls. */
export const SETTING_BOUNDS = Object.freeze({
    hoverDelayMs: {min: 0, max: 5000},
    hoverGraceMs: {min: 0, max: 5000},
    fontScale: {min: 50, max: 300},
});

const isValid = (name, value) => {
    const fallback = DEFAULT_SETTINGS[name];
    if (Array.isArray(fallback)) {
        return Array.isArray(value) && value.every((title) => typeof title === 'string');
    }

    return typeof value === typeof fallback;
};

const isSame = (a, b) => a === b || (Array.isArray(a) && JSON.stringify(a) === JSON.stringify(b));

function copyValid(from) {
    return Object.fromEntries(Object.keys(DEFAULT_SETTINGS).filter((name) => isValid(name, from?.[name])).map((name) => [name, from[name]]));
}

function readCache(userId) {
    try {
        const cached = JSON.parse(localStorage.getItem(STORAGE_PREFIX + userId));
        return {values: copyValid(cached?.values), pending: copyValid(cached?.pending)};
    } catch {
        return {values: {}, pending: {}};
    }
}

function writeCache(userId, values, pending) {
    try {
        localStorage.setItem(STORAGE_PREFIX + userId, JSON.stringify({values, pending}));
    } catch {
        // Private windows can refuse this. The value still holds for this page.
    }
}

/** @returns {{apiClient: object, id: string}|null} Who is signed in here now. */
function signedInUser() {
    try {
        const {ApiClient: apiClient} = window;
        const id = apiClient?.getCurrentUserId();
        return id && apiClient.accessToken() ? {apiClient, id} : null;
    } catch {
        return null;
    }
}

function request(apiClient, method, body) {
    return fetch(apiClient.getUrl('Yomitan/Settings'), {
        method,
        headers: {'Content-Type': 'application/json', Authorization: `MediaBrowser Token="${apiClient.accessToken()}"`},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

export class Settings extends EventTarget {
    constructor() {
        super();
        this._userId = null;
        this._values = {...DEFAULT_SETTINGS};
        /** Changes the server has not taken yet. @type {Partial<typeof DEFAULT_SETTINGS>} */
        this._pending = {};
        /** The newest revision seen, so that an answer overtaken by another changes nothing. */
        this._revision = -1;
        this._writeTimer = 0;
        this._writing = false;
        this._attempts = 0;
        this._refreshing = null;
        this._refreshedAt = 0;
        /** See {@link Settings#syncState}. */
        this._syncState = 'saved';
    }

    /** @returns {'saved'|'saving'|'retrying'|'refused'} Whether this user's changes have reached the server. */
    get syncState() {
        return this._syncState;
    }

    /** @returns {string|null} Whose settings these are, or null if nobody is signed in, when they are the defaults. */
    get userId() {
        return this._userId;
    }

    /**
     * @param {keyof typeof DEFAULT_SETTINGS} name
     * @returns {boolean|number|readonly string[]}
     */
    get(name) {
        return this._values[name];
    }

    /**
     * Applies a value at once, and sends it to the server. With nobody signed in it holds for this page alone.
     * @param {keyof typeof DEFAULT_SETTINGS} name
     * @param {boolean|number|string[]} value
     * @fires Settings#change With `{name, value}`, if it is a new value.
     */
    set(name, value) {
        if (!isValid(name, value)) {
            throw new TypeError(`Bad value for setting ${name}`);
        }

        if (isSame(this._values[name], value)) {
            return;
        }

        this._values[name] = value;
        if (this._userId) {
            this._pending[name] = value;
            this._saveCache();
            this._setSyncState('saving');
            this._scheduleWrite(WRITE_DELAY_MS);
        }

        this.dispatchEvent(new CustomEvent('change', {detail: {name, value}}));
    }

    /**
     * Catches up with who is signed in. It only reads memory and localStorage, so it can run before anything that must
     * not wait, and it starts a refresh if the user changed.
     */
    follow() {
        const id = signedInUser()?.id ?? null;
        if (id === this._userId) {
            return;
        }

        clearTimeout(this._writeTimer);
        this._writeTimer = 0;
        this._attempts = 0;
        this._revision = -1;
        this._refreshing = null;
        this._userId = id;
        const {values, pending} = id ? readCache(id) : {values: {}, pending: {}};
        this._pending = pending;
        this._setSyncState(Object.keys(pending).length > 0 ? 'saving' : 'saved');
        this._replace({...DEFAULT_SETTINGS, ...values, ...pending});
        if (id) {
            this.refresh({force: true});
            this._scheduleWrite(0);
        }
    }

    /**
     * Asks the server, unless it was asked moments ago. Nothing waits for this: the answer arrives as `change` events.
     * @param {object} [options]
     * @param {boolean} [options.force] Ask whenever it was last asked.
     * @returns {Promise<void>} Never rejects. If the server cannot be reached, the cached values stand.
     */
    refresh({force = false} = {}) {
        const user = signedInUser();
        if (!user || user.id !== this._userId) {
            return Promise.resolve();
        }

        if (!force && performance.now() - this._refreshedAt < REFRESH_INTERVAL_MS) {
            return this._refreshing ?? Promise.resolve();
        }

        this._refreshedAt = performance.now();
        if (!this._refreshing) {
            const refreshing = this._fetch(user).finally(() => {
                if (this._refreshing === refreshing) {
                    this._refreshing = null;
                }
            });
            this._refreshing = refreshing;
        }

        return this._refreshing;
    }

    async _fetch({apiClient, id}) {
        try {
            const response = await request(apiClient, 'GET');
            if (!response.ok) {
                throw new Error(`Yomitan/Settings returned ${response.status}`);
            }

            this._accept(id, await response.json());
        } catch (error) {
            console.debug('[yomitan] using the settings this browser last saw:', error);
        }
    }

    /** Takes what the server sent, unless it is for someone else, or older than what is here. */
    _accept(userId, {revision, settings}) {
        if (userId !== this._userId || revision < this._revision) {
            return;
        }

        this._revision = revision;
        this._replace({...DEFAULT_SETTINGS, ...copyValid(settings), ...this._pending});
    }

    /** Moves to these values, and tells everyone what changed. */
    _replace(values) {
        const changed = Object.keys(DEFAULT_SETTINGS).filter((name) => !isSame(this._values[name], values[name]));
        this._values = values;
        this._saveCache();
        for (const name of changed) {
            this.dispatchEvent(new CustomEvent('change', {detail: {name, value: values[name]}}));
        }
    }

    _saveCache() {
        if (this._userId) {
            writeCache(this._userId, this._values, this._pending);
        }
    }

    _setSyncState(state) {
        if (this._syncState !== state) {
            this._syncState = state;
            this.dispatchEvent(new CustomEvent('syncstate', {detail: {state}}));
        }
    }

    _scheduleWrite(delay) {
        clearTimeout(this._writeTimer);
        this._writeTimer = 0;
        if (Object.keys(this._pending).length > 0) {
            this._writeTimer = setTimeout(this._write, delay);
        }
    }

    _retryWrite() {
        const delay = RETRY_DELAYS_MS[Math.min(this._attempts, RETRY_DELAYS_MS.length - 1)];
        this._attempts += 1;
        this._setSyncState('retrying');
        this._scheduleWrite(delay);
    }

    _write = async () => {
        this._writeTimer = 0;
        // The token is whoever is signed in now, and the server stores under the token. So a write must never leave
        // for anyone but the user it belongs to. It stays in that user's cache until they are back.
        const user = signedInUser();
        if (this._writing || !user || user.id !== this._userId) {
            return;
        }

        const sent = {...this._pending};
        this._writing = true;
        try {
            const response = await request(user.apiClient, 'PUT', sent);
            if (user.id !== this._userId) {
                // The user left during the request. If the server took it, it must not be sent again.
                if (response.ok) {
                    this._forget(user.id, sent);
                }
            } else if (response.ok) {
                this._attempts = 0;
                this._takeBack(sent);
                this._accept(user.id, await response.json());
                this._setSyncState(Object.keys(this._pending).length > 0 ? 'saving' : 'saved');
            } else if (response.status >= 400 && response.status < 500 && !WORTH_REPEATING.has(response.status)) {
                await this._refused(user, sent, response);
            } else {
                this._retryWrite();
            }
        } catch (error) {
            console.debug('[yomitan] a setting did not reach the server, and will be sent again:', error);
            if (user.id === this._userId) {
                this._retryWrite();
            }
        } finally {
            this._writing = false;
        }

        // Anything set during the request has been waiting for this.
        if (this._writeTimer === 0 && this._syncState !== 'retrying') {
            this._scheduleWrite(0);
        }
    };

    /** Forgets what was sent, apart from anything changed since. */
    _takeBack(sent) {
        for (const [name, value] of Object.entries(sent)) {
            if (isSame(this._pending[name], value)) {
                delete this._pending[name];
            }
        }
    }

    _forget(userId, sent) {
        const {values, pending} = readCache(userId);
        for (const [name, value] of Object.entries(sent)) {
            if (isSame(pending[name], value)) {
                delete pending[name];
            }
        }

        writeCache(userId, values, pending);
    }

    /** The server said no, and saying the same thing again will not help. Its values go back on screen. */
    async _refused(user, sent, response) {
        const {error} = await response.json().catch(() => ({}));
        console.warn(`[yomitan] the server refused a setting (${response.status}):`, error?.message);
        if (response.status === 401 || response.status === 403) {
            // Not a judgement on the value. The next sign-in sends it again.
            this._setSyncState('retrying');
            return;
        }

        this._takeBack(sent);
        this._revision = -1;
        await this._fetch(user);
        this._setSyncState('refused');
    }
}
