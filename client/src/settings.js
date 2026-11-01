// The client's settings, in one place. The loader creates the only instance and hands it to the engine, so everything
// reads through this. They live in this browser for now, and Phase 6 moves them to the server and adds the UI.

const STORAGE_KEY = 'yomitan.settings';

export const DEFAULT_SETTINGS = Object.freeze({
    /** Whether the plugin does anything at all. Off means playback is exactly what jellyfin-web does alone. */
    enabled: true,
    /** How long the mouse has to rest on a word before it pauses, so one passing over the line on its way does not. */
    hoverDelayMs: 200,
    /** How long the popup survives the mouse leaving it and the word, so it can cross the gap between them. */
    hoverGraceMs: 300,
    /** Whether only Up enters word mode, which leaves Left and Right to the OSD's buttons while paused. */
    upOnlyEntry: false,
});

function read() {
    try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY)) ?? {};
    } catch {
        return {};
    }
}

export class Settings extends EventTarget {
    constructor() {
        super();
        const stored = read();
        this._values = {...DEFAULT_SETTINGS};
        for (const [name, value] of Object.entries(DEFAULT_SETTINGS)) {
            if (typeof stored[name] === typeof value) {
                this._values[name] = stored[name];
            }
        }
    }

    /**
     * @param {keyof typeof DEFAULT_SETTINGS} name
     * @returns {boolean|number}
     */
    get(name) {
        return this._values[name];
    }

    /**
     * Stores a value, and sends a `change` event with `{name, value}` if it is a new one.
     * @param {keyof typeof DEFAULT_SETTINGS} name
     * @param {boolean|number} value
     */
    set(name, value) {
        if (typeof value !== typeof DEFAULT_SETTINGS[name]) {
            throw new TypeError(`Bad value for setting ${name}`);
        }

        if (this._values[name] === value) {
            return;
        }

        this._values[name] = value;
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(this._values));
        } catch {
            // Private windows can refuse this. The value still holds for this page.
        }

        this.dispatchEvent(new CustomEvent('change', {detail: {name, value}}));
    }
}
