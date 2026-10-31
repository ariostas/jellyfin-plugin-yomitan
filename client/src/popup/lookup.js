// Looking up a word: the popup, the highlight and the pause, as one thing with one way in and one way out. Input code
// says which word and when, so a pointer here and a remote in Phase 5 behave the same.
import {isCodePointKanji} from '../../../third_party/yomitan/ext/js/language/ja/japanese.js';
import {PlaybackHold} from '../playback/hold.js';
import {Popup} from './popup.js';
import {EntryRenderer} from './renderer.js';

/** Yomitan's default. */
const MAX_TERM_ENTRIES = 32;

export class WordLookup extends EventTarget {
    /**
     * @param {object} options
     * @param {import('../engine/engine.js').Engine} options.engine
     * @param {import('../overlay.js').Overlay} options.overlay
     * @param {HTMLElement} options.container The layer over the player.
     * @param {HTMLVideoElement} options.video
     * @param {object} options.apiClient jellyfin-web's ApiClient.
     * @param {(cueId: number) => import('../segmenter.js').Word[]|undefined} options.wordsOf
     * @param {() => {top: number, bottom: number}} options.osd What the OSD covers now.
     * @param {AbortSignal} options.signal Ends the listeners.
     */
    constructor({engine, overlay, container, video, apiClient, wordsOf, osd, signal}) {
        super();
        this._engine = engine;
        this._overlay = overlay;
        this._container = container;
        this._apiClient = apiClient;
        this._wordsOf = wordsOf;
        this._osd = osd;
        this._video = video;
        this._hold = new PlaybackHold(video, signal, () => this.close('play'));
        /** @type {{cueId: number, index: number}|null} The word open or opening. */
        this._current = null;
        this._ticket = 0;
        /** Both are made for the first word, since a session that is only watched never needs them. */
        this._popup = null;
        this._renderer = null;

        const close = () => this.close('seek');
        video.addEventListener('seeking', close, {signal});
        video.addEventListener('emptied', close, {signal});
        const place = () => this._place();
        window.addEventListener('resize', place, {signal});
        document.addEventListener('fullscreenchange', place, {signal});
    }

    /** @returns {{cueId: number, index: number}|null} The word open, or being looked up. */
    get current() {
        return this._current;
    }

    /** @returns {boolean} Whether the popup is showing. */
    get isOpen() {
        return this._popup?.isOpen ?? false;
    }

    /** @returns {boolean} Whether the video is paused because of a lookup. */
    get holding() {
        return this._hold.held;
    }

    /** @returns {HTMLElement|null} The popup's element in the page. */
    get host() {
        return this._popup?.host ?? null;
    }

    /**
     * Pauses and shows a word, or moves the popup to it. A word `known` says no dictionary has does nothing, and a miss
     * after all resumes at once. It pauses before it looks anything up, because a line can end during the request.
     * @param {{cueId: number, index: number}} word
     * @returns {Promise<boolean>} Whether this word ended up showing.
     */
    async open({cueId, index}) {
        const word = this._wordsOf(cueId)?.[index];
        if (!word?.known) {
            return false;
        }

        if (this._current?.cueId === cueId && this._current.index === index) {
            return true;
        }

        this._hold.hold();
        this._current = {cueId, index};
        this._overlay.setActiveWord(this._current);
        return this._show(word.text);
    }

    /**
     * Closes the popup and undoes the pause if it was ours.
     * @param {string} [reason] Sent with the `close` event. `play` means the video is already playing, by someone's choice.
     */
    close(reason = 'closed') {
        const word = this._current;
        if (!word) {
            return;
        }

        this._ticket += 1;
        this._current = null;
        this._overlay.setActiveWord(null);
        this._popup?.hide();
        this._renderer?.release();
        if (reason !== 'stopped') {
            this._hold.release();
        }

        this.dispatchEvent(new CustomEvent('close', {detail: {reason, word}}));
    }

    /** @param {number} pixels Down if positive. */
    scrollBy(pixels) {
        this._popup?.scrollBy(pixels);
    }

    async _show(text) {
        const ticket = this._ticket + 1;
        this._ticket = ticket;
        try {
            const {entries, kanji} = await this._search(text);
            if (ticket !== this._ticket) {
                return false;
            }

            if (entries.length === 0 && kanji.length === 0) {
                this.close('miss');
                return false;
            }

            this._render(entries, kanji);
            return true;
        } catch (error) {
            if (ticket === this._ticket) {
                console.warn('[yomitan] the lookup failed:', error);
                this.close('error');
            }

            return false;
        }
    }

    async _search(text) {
        const characters = [...text].filter((character) => isCodePointKanji(character.codePointAt(0)));
        const haveKanji = characters.length > 0 && this._engine.dictionaries.some(({counts}) => counts?.kanji?.total > 0);
        const [{dictionaryEntries}, kanji] = await Promise.all([
            this._engine.lookup(text),
            haveKanji ? this._engine.lookupKanji(characters.join('')) : [],
        ]);
        return {entries: dictionaryEntries.slice(0, MAX_TERM_ENTRIES), kanji};
    }

    _render(entries, kanji) {
        this._popup ??= new Popup(this._container);
        this._renderer ??= new EntryRenderer(this._apiClient, (query) => this._showLinked(query));
        const dictionaries = this._engine.dictionaries;
        this._renderer.release();
        const nodes = this._renderer.render(entries, kanji, dictionaries);
        const anchor = this._overlay.wordElement(this._current);
        if (!anchor) {
            this.close('gone');
            return;
        }

        this._popup.show(nodes, this._renderer.dictionaryStyles(dictionaries), anchor, this._osd());
        this._renderer.loadImages(this._popup.root);
    }

    /** A link inside an entry to another one, which keeps the highlight on the word that led there. */
    _showLinked(query) {
        return this._show(query);
    }

    _place() {
        const anchor = this._current && this._overlay.wordElement(this._current);
        if (anchor && this.isOpen) {
            this._popup.place(anchor, this._osd());
        }
    }

    /**
     * Ends everything, along with the session.
     * @param {{playing: boolean}} options Whether the video lives on. Otherwise there is nothing to resume.
     */
    destroy({playing}) {
        this.close(playing ? 'ended' : 'stopped');
        this._hold.forget();
        this._popup?.destroy();
    }
}
