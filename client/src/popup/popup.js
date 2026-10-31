// The popup: an element in a shadow root, so neither jellyfin-web's CSS nor Yomitan's can reach the other. It shows what
// it is given and knows nothing about words or playback. See lookup.js for that.
import displayCss from 'yomitan-assets:css';
import {placePopup} from './placement.js';

const FRAME_CSS = `
:host {
    all: initial;
    --font-size-no-units: 15;
    --line-height-no-units: 21;
}
.popup-frame {
    display: flex;
    flex-direction: column;
    overflow: hidden;
    border-radius: 8px;
    border: 1px solid var(--light-border-color);
    box-sizing: border-box;
    box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6);
    background: var(--background-color);
    color: var(--text-color);
    font-family: "Noto Sans CJK JP", "Hiragino Sans", "Yu Gothic", Meiryo, Arial, sans-serif;
    font-size: var(--font-size);
    line-height: var(--line-height);
    /* So that nothing in an entry can escape, not even position: fixed, which would otherwise cover the page. */
    contain: layout paint style;
}
.popup-scroll {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden auto;
    overscroll-behavior: contain;
    touch-action: pan-y;
    -webkit-overflow-scrolling: touch;
}
/* The extension renders entries off screen lazily, with a guessed height, which would give the popup that height. */
.entry { content-visibility: visible; contain-intrinsic-height: none; }
.actions, .entry-current-indicator { display: none; }
`;

/** Options the extension sets on <html>, at their defaults. Its CSS reads them, so they go on the host. */
const DISPLAY_OPTIONS = {
    theme: 'dark',
    language: 'ja',
    pageType: 'popup',
    resultOutputMode: 'group',
    glossaryLayoutMode: 'default',
    compactTags: 'true',
    averageFrequency: 'false',
    frequencyDisplayMode: 'split-tags-grouped',
    termDisplayMode: 'ruby',
    enableSearchTags: 'false',
    showPronunciationText: 'true',
    showPronunciationDownstepPosition: 'true',
    showPronunciationGraph: 'true',
};

const STYLE_ID = 'yomitan-popup-style';
const HOST_CSS = `
.yomitan-popup {
    position: absolute;
    display: block;
    pointer-events: auto;
}
.yomitan-popup[hidden] { display: none; }
`;

export class Popup {
    /** @param {HTMLElement} container The layer over the player. */
    constructor(container) {
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = HOST_CSS;
            document.head.append(style);
        }

        /** The element in the page. Events from inside the shadow root look like they came from this. */
        this.host = document.createElement('div');
        this.host.className = 'yomitan-popup';
        this.host.hidden = true;
        this.host.lang = 'ja';
        Object.assign(this.host.dataset, DISPLAY_OPTIONS);

        const root = this.host.attachShadow({mode: 'open'});
        const style = document.createElement('style');
        style.textContent = `${displayCss}\n${FRAME_CSS}`;
        this._dictionaryStyle = document.createElement('style');
        this._frame = document.createElement('div');
        this._frame.className = 'popup-frame';
        this._scroll = document.createElement('div');
        this._scroll.className = 'popup-scroll';
        this._frame.append(this._scroll);
        root.append(style, this._dictionaryStyle, this._frame);
        /** @type {ShadowRoot} */
        this.root = root;

        // jellyfin-web turns the wheel into volume on the document.
        this.host.addEventListener('wheel', (event) => event.stopPropagation(), {passive: true});
        container.append(this.host);
    }

    /** @returns {boolean} */
    get isOpen() {
        return !this.host.hidden;
    }

    /**
     * @param {HTMLElement[]} entries Rendered entries, already sanitized.
     * @param {string} dictionaryStyles
     * @param {HTMLElement} anchor The word it describes.
     * @param {{bottom: number}} insets What the OSD covers.
     */
    show(entries, dictionaryStyles, anchor, insets) {
        if (this._dictionaryStyle.textContent !== dictionaryStyles) {
            this._dictionaryStyle.textContent = dictionaryStyles;
        }

        this._scroll.replaceChildren(...entries);
        this._scroll.scrollTop = 0;
        this.host.hidden = false;
        this.place(anchor, insets);
    }

    /**
     * Puts it next to the word. It measures while hidden, so nothing shows in the wrong place.
     * @param {HTMLElement} anchor
     * @param {{bottom: number}} insets
     */
    place(anchor, {bottom}) {
        const {host, _frame: frame, _scroll: scroll} = this;
        const viewport = {width: innerWidth, height: innerHeight};
        host.style.visibility = 'hidden';
        host.style.width = `${Math.min(viewport.width - 16, 460)}px`;
        host.style.left = '0';
        host.style.top = '0';
        frame.style.height = 'auto';
        const contentHeight = scroll.scrollHeight + 2;
        const placement = placePopup({viewport, anchor: anchor.getBoundingClientRect(), contentHeight, avoidBottom: bottom});
        const height = Math.min(contentHeight, placement.maxHeight);
        host.style.left = `${placement.left}px`;
        host.style.top = `${placement.top}px`;
        host.style.width = `${placement.width}px`;
        frame.style.height = `${height}px`;
        host.dataset.side = placement.side;
        host.style.visibility = '';
    }

    /** @param {number} pixels Down if positive. */
    scrollBy(pixels) {
        this._scroll.scrollTop += pixels;
    }

    hide() {
        this.host.hidden = true;
        this._scroll.replaceChildren();
    }

    destroy() {
        this.host.remove();
    }
}
