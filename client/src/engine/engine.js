// Yomitan's Translator on top of the server's dictionaries. This is the only module that knows about the Translator,
// and what Phase 4's popup calls for a lookup.
import {Translator} from '../../../third_party/yomitan/ext/js/language/translator.js';
import {QueryClient} from './query-client.js';
import {RecordingDb, RemoteDb} from './remote-db.js';
import {TermStore} from './term-store.js';

export class NoDictionariesError extends Error {
    constructor() {
        super('No dictionaries are installed');
    }
}

export class Engine extends EventTarget {
    constructor() {
        super();
        this._client = new QueryClient((dictionaries) => this._onDictionariesChanged(dictionaries));
        this._terms = new TermStore(async (terms) => {
            const [result] = await this._client.send([
                {op: 'findTermsBulk', termList: terms, dictionaries: this._titles, matchType: 'exact'},
            ]);
            return result;
        });
        this._database = new RemoteDb(this._client, this._terms);
        this._recording = new RecordingDb();

        // The planner shares nothing with the real Translator, so planning cannot disturb a lookup in progress.
        this._translator = new Translator(this._database);
        this._planner = new Translator(this._recording);
        this._translator.prepare();
        this._planner.prepare();

        this._planning = Promise.resolve();
        this._titles = [];
        this._options = null;
    }

    /** @returns {number} Requests sent so far, for measuring. */
    get requests() {
        return this._client.requests;
    }

    /** @returns {number} Changes whenever cached results stop being valid. */
    get generation() {
        return this._terms.generation;
    }

    /** @returns {object[]} `getDictionaryInfo` summaries, including each dictionary's `styles`. */
    get dictionaries() {
        return this._client.dictionaries ?? [];
    }

    /** @returns {{terms: number, rows: number}} What is cached now. */
    get cacheSize() {
        return this._terms.size;
    }

    /**
     * Gets the dictionary list, which also proves the API works.
     * @param {object} apiClient jellyfin-web's ApiClient.
     * @throws {NoDictionariesError} If there are none, or the error if the server cannot be asked.
     */
    async open(apiClient) {
        this._terms.open();
        this._client.bind(apiClient);
        await this._client.send([]);
        this._useDictionaries(this._client.dictionaries);
        if (this._titles.length === 0) {
            throw new NoDictionariesError();
        }
    }

    /** Forgets everything cached, when a playback ends. */
    close() {
        this._terms.close();
        this._translator.clearDatabaseCaches();
    }

    _useDictionaries(dictionaries) {
        this._titles = dictionaries.map(({title}) => title);
        const enabledDictionaryMap = new Map(dictionaries.map(({title}, index) => [title, {
            index,
            alias: title,
            allowSecondarySearches: false,
            partsOfSpeechFilter: true,
            useDeinflections: true,
        }]));
        this._options = {
            matchType: 'exact',
            deinflect: true,
            primaryReading: '',
            mainDictionary: this._titles[0] ?? '',
            sortFrequencyDictionary: null,
            sortFrequencyDictionaryOrder: 'descending',
            removeNonJapaneseCharacters: false,
            searchResolution: 'letter',
            textReplacements: [null],
            excludeDictionaryDefinitions: null,
            language: 'ja',
            useAllFrequencyDictionaries: false,
            enabledDictionaryMap,
        };
    }

    _onDictionariesChanged(dictionaries) {
        this._useDictionaries(dictionaries);
        this._terms.clear();
        this._translator.clearDatabaseCaches();
        this.dispatchEvent(new Event('dictionarieschange'));
    }

    /**
     * Fetches, in one request, everything `scan` will need for these windows of text. The Translator's candidates come
     * from running it against a database that only records them, so this stays exact as Yomitan's rules change.
     * @param {string[]} windows
     * @returns {Promise<{complete: boolean}>} `complete` is false if the server cut an answer short.
     */
    prefetch(windows) {
        const run = async () => {
            this._recording.terms.clear();
            for (const window of new Set(windows)) {
                await this._planner.findTerms('simple', window, this._options);
            }

            const terms = [...this._recording.terms];
            return {complete: await this._terms.ensure(terms)};
        };

        const result = this._planning.then(run, run);
        this._planning = result.catch(() => {});
        return result;
    }

    /**
     * The entries for the start of `window`, with no tags or frequencies: what a segmenter needs.
     * @param {string} window
     * @returns {Promise<object[]>}
     */
    async scan(window) {
        const {dictionaryEntries} = await this._translator.findTerms('simple', window, this._options);
        return dictionaryEntries;
    }

    /**
     * A full lookup, for showing to someone. Pass `word.text` so the result matches what is highlighted.
     * @param {string} text
     * @param {object} [options]
     * @param {'group'|'merge'|'split'|'simple'} [options.mode] Yomitan's result mode.
     * @returns {Promise<{dictionaryEntries: object[], originalTextLength: number, truncated: boolean}>} `truncated` is
     *   true if the server cut an answer short, so the entries are usable but may be incomplete.
     */
    async lookup(text, {mode = 'group'} = {}) {
        const before = this._database.truncations;
        const result = await this._translator.findTerms(mode, text, this._options);
        return {...result, truncated: this._database.truncations !== before};
    }

    /**
     * @param {string} text Kanji to look up. Each character is one search.
     * @returns {Promise<object[]>}
     */
    lookupKanji(text) {
        const enabledDictionaryMap = new Map(this._titles.map((title, index) => [title, {index, alias: title}]));
        return this._translator.findKanji(text, {enabledDictionaryMap, removeNonJapaneseCharacters: false});
    }
}
