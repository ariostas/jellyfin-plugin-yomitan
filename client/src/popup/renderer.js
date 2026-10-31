// Turns the Translator's results into DOM with Yomitan's own DisplayGenerator, so entries look the way they do in the
// extension, and dictionaries' structured content, tags, frequencies and pitch accents all work.
import {DisplayGenerator} from '../../../third_party/yomitan/ext/js/display/display-generator.js';
import templates from 'yomitan-assets:templates';
import {ContentManager} from './content-manager.js';
import {sanitizeDictionaryCss, sanitizeEntry} from './sanitize.js';

export class EntryRenderer {
    /**
     * @param {object} apiClient jellyfin-web's ApiClient.
     * @param {(query: string) => void} onInternalLink Called when a link to another entry is followed.
     */
    constructor(apiClient, onInternalLink) {
        this._content = new ContentManager(apiClient, onInternalLink);
        this._generator = new DisplayGenerator(this._content, null);
        // prepare() fetches the extension's own copy of this file.
        this._generator._templates.load(new DOMParser().parseFromString(templates, 'text/html'));
        this._styles = new Map();
    }

    /**
     * @param {object[]} termEntries From `Engine.lookup`.
     * @param {object[]} kanjiEntries From `Engine.lookupKanji`.
     * @param {object[]} dictionaries `Engine.dictionaries`.
     * @returns {HTMLElement[]} The entries, safe to attach.
     */
    render(termEntries, kanjiEntries, dictionaries) {
        const nodes = [
            ...termEntries.map((entry) => this._generator.createTermEntry(entry, dictionaries)),
            ...kanjiEntries.map((entry) => this._generator.createKanjiEntry(entry, dictionaries)),
        ];
        for (const node of nodes) {
            sanitizeEntry(node);
        }

        return nodes;
    }

    /** @param {ParentNode} root Where the rendered entries are now, so their images can start loading. */
    loadImages(root) {
        this._content.start(root);
    }

    /** Lets go of everything the last `render` loaded. */
    release() {
        this._content.unloadAll();
    }

    /**
     * @param {object[]} dictionaries `Engine.dictionaries`.
     * @returns {string} The dictionaries' own CSS, made safe and scoped.
     */
    dictionaryStyles(dictionaries) {
        return dictionaries.map(({title, importDate, styles}) => {
            const key = `${title}/${importDate}`;
            if (!this._styles.has(key)) {
                this._styles.set(key, sanitizeDictionaryCss(styles, title));
            }

            return this._styles.get(key);
        }).filter(Boolean).join('\n');
    }
}
