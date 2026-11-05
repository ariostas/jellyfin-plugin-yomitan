// The client's settings, in one place. The loader creates the only instance and hands it to the engine, so everything
// reads through this.
//
// The server holds them, per user. localStorage is only the last copy this browser saw of each user's settings, so
// playback never waits on the network: a value is there at once, and whatever the server says arrives as a `change`
// event. A change is kept in the cache too until the server has taken it, so it survives a reload or a dead network.
//
// This is in the loader, on every page, so its members are private (#), which the minifier shortens.
import {apiFetch} from './api.js';

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
    /**
     * Whether only Up enters word mode, which leaves Left and Right to the OSD's buttons while paused. Null until the user
     * chooses, and then {@link entersWithUpOnly} decides by the layout.
     */
    upOnlyEntry: null,
    /** The size of the lines, in percent of what fits the screen. */
    fontScale: 100,
    /** Titles in the order this user wants them. Anything not listed comes after, in import order. */
    dictionaryOrder: Object.freeze([]),
    /** Titles this user has turned off. Anything not listed is on, so a new dictionary works without asking. */
    disabledDictionaries: Object.freeze([]),
    /** Whether this user has closed or acted on the notice that introduces the button in the player. */
    introSeen: false,
});

/**
 * The same bounds as the server's, which is what enforces them. Here they only shape the controls. Marked pure so that
 * the loader, which has no controls, leaves it out.
 */
export const SETTING_BOUNDS = /* @__PURE__ */ Object.freeze({
    hoverDelayMs: {min: 0, max: 5000},
    hoverGraceMs: {min: 0, max: 5000},
    fontScale: {min: 50, max: 300},
});

const isValid = (name, value) => {
    const fallback = DEFAULT_SETTINGS[name];
    if (Array.isArray(fallback)) {
        return Array.isArray(value) && value.every((title) => typeof title === 'string');
    }

    // A choice not made yet, which a boolean makes.
    if (fallback === null) {
        return value === null || typeof value === 'boolean';
    }

    return typeof value === typeof fallback;
};

/**
 * Whether only Up enters word mode here. Until the user chooses, it does outside jellyfin-web's TV layout, so that Left
 * and Right still go back and forward on a paused video, which learners replaying a line do all the time. In the TV
 * layout Left and Right enter too, as they are what a remote's thumb is on.
 * @param {Settings} settings
 * @returns {boolean}
 */
export function entersWithUpOnly(settings) {
    return settings.get('upOnlyEntry') ?? !document.documentElement.classList.contains('layout-tv');
}

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
    return apiFetch(apiClient, 'Yomitan/Settings', {
        method,
        headers: {'Content-Type': 'application/json'},
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
}

export class Settings extends EventTarget {
    #userId = null;
    #values = {...DEFAULT_SETTINGS};
    /** Changes the server has not taken yet. @type {Partial<typeof DEFAULT_SETTINGS>} */
    #pending = {};
    /** The newest revision seen, so that an answer overtaken by another changes nothing. */
    #revision = -1;
    #writeTimer = 0;
    #writing = false;
    #attempts = 0;
    #refreshing = null;
    #refreshedAt = 0;
    /** See {@link Settings#syncState}. */
    #syncState = 'saved';

    /** @returns {'saved'|'saving'|'retrying'|'refused'} Whether this user's changes have reached the server. */
    get syncState() {
        return this.#syncState;
    }

    /** @returns {string|null} Whose settings these are, or null if nobody is signed in, when they are the defaults. */
    get userId() {
        return this.#userId;
    }

    /**
     * @param {keyof typeof DEFAULT_SETTINGS} name
     * @returns {boolean|number|readonly string[]|null}
     */
    get(name) {
        return this.#values[name];
    }

    /**
     * Applies a value at once, and sends it to the server. With nobody signed in it holds for this page alone.
     * @param {keyof typeof DEFAULT_SETTINGS} name
     * @param {boolean|number|string[]|null} value
     * @fires Settings#change With `{name, value}`, if it is a new value.
     */
    set(name, value) {
        if (!isValid(name, value)) {
            throw new TypeError(`Bad value for setting ${name}`);
        }

        this.follow();
        if (isSame(this.#values[name], value)) {
            return;
        }

        this.#values[name] = value;
        if (this.#userId) {
            this.#pending[name] = value;
            this.#saveCache();
            this.#setSyncState('saving');
            this.#scheduleWrite(WRITE_DELAY_MS);
        }

        this.#emit('change', {name, value});
    }

    /**
     * Catches up with who is signed in. It only reads memory and localStorage, so it can run before anything that must
     * not wait, and it starts a refresh if the user changed.
     */
    follow() {
        const id = signedInUser()?.id ?? null;
        if (id === this.#userId) {
            return;
        }

        clearTimeout(this.#writeTimer);
        this.#writeTimer = 0;
        this.#attempts = 0;
        this.#revision = -1;
        this.#refreshing = null;
        this.#userId = id;
        const {values, pending} = id ? readCache(id) : {values: {}, pending: {}};
        this.#pending = pending;
        this.#setSyncState(this.#hasPending() ? 'saving' : 'saved');
        this.#replace({...DEFAULT_SETTINGS, ...values, ...pending});
        if (id) {
            this.refresh({force: true});
            this.#scheduleWrite(0);
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
        if (!user || user.id !== this.#userId) {
            return Promise.resolve();
        }

        if (!force && performance.now() - this.#refreshedAt < REFRESH_INTERVAL_MS) {
            return this.#refreshing ?? Promise.resolve();
        }

        this.#refreshedAt = performance.now();
        if (!this.#refreshing) {
            const refreshing = this.#fetch(user).finally(() => {
                if (this.#refreshing === refreshing) {
                    this.#refreshing = null;
                }
            });
            this.#refreshing = refreshing;
        }

        return this.#refreshing;
    }

    async #fetch({apiClient, id}) {
        try {
            const response = await request(apiClient, 'GET');
            if (!response.ok) {
                throw new Error(`Yomitan/Settings returned ${response.status}`);
            }

            this.#accept(id, await response.json());
        } catch (error) {
            console.debug('[yomitan] using the cached settings:', error);
        }
    }

    /** Takes what the server sent, unless it is for someone else, or older than what is here. */
    #accept(userId, {revision, settings}) {
        if (userId !== this.#userId || revision < this.#revision) {
            return;
        }

        this.#revision = revision;
        this.#replace({...DEFAULT_SETTINGS, ...copyValid(settings), ...this.#pending});
    }

    /** Moves to these values, and tells everyone what changed. */
    #replace(values) {
        const changed = Object.keys(DEFAULT_SETTINGS).filter((name) => !isSame(this.#values[name], values[name]));
        this.#values = values;
        this.#saveCache();
        for (const name of changed) {
            this.#emit('change', {name, value: values[name]});
        }
    }

    #emit(type, detail) {
        this.dispatchEvent(new CustomEvent(type, {detail}));
    }

    #hasPending() {
        return Object.keys(this.#pending).length > 0;
    }

    #saveCache() {
        if (this.#userId) {
            writeCache(this.#userId, this.#values, this.#pending);
        }
    }

    #setSyncState(state) {
        if (this.#syncState !== state) {
            this.#syncState = state;
            this.#emit('syncstate', {state});
        }
    }

    #scheduleWrite(delay) {
        clearTimeout(this.#writeTimer);
        this.#writeTimer = 0;
        if (this.#hasPending()) {
            this.#writeTimer = setTimeout(this.#write, delay);
        }
    }

    #retryWrite() {
        const delay = RETRY_DELAYS_MS[Math.min(this.#attempts, RETRY_DELAYS_MS.length - 1)];
        this.#attempts += 1;
        this.#setSyncState('retrying');
        this.#scheduleWrite(delay);
    }

    #write = async () => {
        this.#writeTimer = 0;
        // The token is whoever is signed in now, and the server stores under the token. So a write must never leave
        // for anyone but the user it belongs to. It stays in that user's cache until they are back.
        const user = signedInUser();
        if (this.#writing || !user || user.id !== this.#userId) {
            return;
        }

        const sent = {...this.#pending};
        this.#writing = true;
        try {
            const response = await request(user.apiClient, 'PUT', sent);
            if (user.id !== this.#userId) {
                // The user left during the request. If the server took it, it must not be sent again.
                if (response.ok) {
                    this.#forget(user.id, sent);
                }
            } else if (response.ok) {
                // Read first: a refresh answering during this await must still see these as waiting.
                const saved = await response.json();
                this.#attempts = 0;
                this.#takeBack(sent);
                this.#accept(user.id, saved);
                this.#setSyncState(this.#hasPending() ? 'saving' : 'saved');
            } else if (response.status >= 400 && response.status < 500 && !WORTH_REPEATING.has(response.status)) {
                await this.#refused(user, sent, response);
            } else {
                this.#retryWrite();
            }
        } catch (error) {
            console.debug('[yomitan] a setting will be sent again:', error);
            if (user.id === this.#userId) {
                this.#retryWrite();
            }
        } finally {
            this.#writing = false;
        }

        // Anything set during the request has been waiting for this.
        if (this.#writeTimer === 0 && this.#syncState !== 'retrying') {
            this.#scheduleWrite(0);
        }
    };

    /** Forgets what was sent, apart from anything changed since. */
    #takeBack(sent) {
        for (const [name, value] of Object.entries(sent)) {
            if (isSame(this.#pending[name], value)) {
                delete this.#pending[name];
            }
        }
    }

    #forget(userId, sent) {
        const {values, pending} = readCache(userId);
        for (const [name, value] of Object.entries(sent)) {
            if (isSame(pending[name], value)) {
                delete pending[name];
            }
        }

        writeCache(userId, values, pending);
    }

    /** The server said no, and saying the same thing again will not help. Its values go back on screen. */
    async #refused(user, sent, response) {
        const {error} = await response.json().catch(() => ({}));
        console.warn(`[yomitan] the server refused a setting (${response.status}):`, error?.message);
        if (response.status === 401 || response.status === 403) {
            // Not a judgement on the value. The next sign-in sends it again.
            this.#setSyncState('retrying');
            return;
        }

        this.#takeBack(sent);
        this.#revision = -1;
        await this.#fetch(user);
        this.#setSyncState('refused');
    }
}
