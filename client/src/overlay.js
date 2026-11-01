// Draws the current cues as plain text split into word spans, over the video. It knows nothing about playback. Only a
// word a dictionary knows takes pointer events: everything else, including the gaps between words and a line that has
// not been split yet, stays click-through so jellyfin-web sees it as it always did.

const STYLE_ID = 'yomitan-overlay-style';
const CSS = `
.yomitan-overlay {
    position: absolute;
    inset: 0;
    z-index: 1;
    pointer-events: none;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    align-items: center;
    padding: max(4%, var(--yomitan-osd-top, 0px)) 5% max(var(--yomitan-bottom, 8%), var(--yomitan-osd-bottom, 0px));
    box-sizing: border-box;
    color: #fff;
    font-size: calc(clamp(18px, min(5vh, 6vw), 44px) * var(--yomitan-font-scale, 1));
    line-height: 1.4;
    text-align: center;
    text-shadow: 0 0 3px #000, 0 0 3px #000, 0 1px 4px #000;
}
.yomitan-overlay[hidden] { display: none; }
.yomitan-overlay.yomitan-below-secondary { --yomitan-bottom: 24%; }
.yomitan-signs { font-size: 0.75em; }
.yomitan-lines { margin-top: auto; }
.yomitan-line { white-space: pre-wrap; }
.yomitan-word:not(.yomitan-unknown) {
    pointer-events: auto;
    border-radius: 0.1em;
    touch-action: manipulation;
    -webkit-touch-callout: none;
    -webkit-tap-highlight-color: transparent;
}
.yomitan-word.yomitan-active { background: rgba(88, 150, 255, 0.55); }
.yomitan-word-mode .yomitan-word.yomitan-active,
.yomitan-word-mode .yomitan-word.yomitan-active:hover {
    background: #ffd400;
    box-shadow: 0 0 0 0.08em #ffd400, 0 0 0 0.16em #000;
    color: #000;
    text-shadow: none;
}
@media (hover: hover) {
    .yomitan-word:not(.yomitan-unknown):hover { background: rgba(255, 255, 255, 0.16); }
    .yomitan-word.yomitan-active:hover { background: rgba(88, 150, 255, 0.55); }
}
@media (hover: none) {
    .yomitan-word { user-select: none; -webkit-user-select: none; }
}
`;

function installStyle() {
    if (!document.getElementById(STYLE_ID)) {
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = CSS;
        document.head.append(style);
    }
}

function appendPlainText(parent, text) {
    text.split('\n').forEach((piece, index) => {
        if (index > 0) {
            parent.append(document.createElement('br'));
        }

        if (piece) {
            parent.append(piece);
        }
    });
}

export class Overlay {
    /** @param {HTMLElement} container The layer over the player. */
    constructor(container) {
        installStyle();
        this.element = document.createElement('div');
        this.element.className = 'yomitan-overlay';
        this.element.lang = 'ja';
        this.element.hidden = true;
        this._active = null;
        this._signs = document.createElement('div');
        this._signs.className = 'yomitan-signs';
        this._lines = document.createElement('div');
        this._lines.className = 'yomitan-lines';
        this.element.append(this._signs, this._lines);
        container.append(this.element);
    }

    /**
     * Shows these cues, replacing what was there. The text is on screen from here on. Words come later, or not at all.
     * @param {readonly import('./subtitles/timeline.js').Cue[]} cues
     * @param {(cue: import('./subtitles/timeline.js').Cue) => import('./segmenter.js').Word[]|undefined} wordsOf
     */
    show(cues, wordsOf) {
        this._lines.textContent = '';
        this._signs.textContent = '';
        for (const cue of cues) {
            const line = document.createElement('div');
            line.className = 'yomitan-line';
            line.dataset.cueId = cue.id;
            line.dataset.kind = cue.kind;
            this._renderLine(line, cue, wordsOf(cue));
            (cue.kind === 'sign' ? this._signs : this._lines).append(line);
        }

        this.element.hidden = cues.length === 0;
    }

    /** @param {number} percent The `fontScale` setting. */
    setFontScale(percent) {
        this.element.style.setProperty('--yomitan-font-scale', `${percent / 100}`);
    }

    /**
     * Splits a cue that is showing into word spans. Does nothing if the cue has gone.
     * @param {import('./subtitles/timeline.js').Cue} cue
     * @param {import('./segmenter.js').Word[]} words
     */
    setWords(cue, words) {
        const line = this.element.querySelector(`[data-cue-id="${cue.id}"]`);
        if (line) {
            this._renderLine(line, cue, words);
        }
    }

    _renderLine(line, cue, words) {
        line.textContent = '';
        if (!words) {
            appendPlainText(line, cue.text);
            return;
        }

        let position = 0;
        words.forEach(({text, start, end, known}, index) => {
            appendPlainText(line, cue.text.slice(position, start));
            const span = document.createElement('span');
            span.className = known ? 'yomitan-word' : 'yomitan-word yomitan-unknown';
            span.dataset.index = index;
            span.dataset.start = start;
            span.dataset.end = end;
            span.textContent = text;
            line.append(span);
            position = end;
        });
        appendPlainText(line, cue.text.slice(position));
        if (this._active?.cueId === cue.id) {
            this.wordElement(this._active)?.classList.add('yomitan-active');
        }
    }

    /**
     * @param {{cueId: number, index: number}} word
     * @returns {HTMLElement|null} The word's span, if it is on screen.
     */
    wordElement({cueId, index}) {
        return this.element.querySelector(`[data-cue-id="${cueId}"] [data-index="${index}"]`);
    }

    /**
     * @param {EventTarget} target Something an event happened on.
     * @returns {{cueId: number, index: number, element: HTMLElement}|null} The word there, if it is one that a
     *   dictionary knows.
     */
    wordAt(target) {
        const element = target instanceof Element ? target.closest('.yomitan-word:not(.yomitan-unknown)') : null;
        if (!element || !this.element.contains(element)) {
            return null;
        }

        return {cueId: Number(element.parentElement.dataset.cueId), index: Number(element.dataset.index), element};
    }

    /**
     * Marks one word, and it stays marked if its line is drawn again.
     * @param {{cueId: number, index: number}|null} word
     */
    setActiveWord(word) {
        this.element.querySelector('.yomitan-active')?.classList.remove('yomitan-active');
        this._active = word;
        if (word) {
            this.wordElement(word)?.classList.add('yomitan-active');
        }
    }

    /** @param {boolean} on Whether the keys are moving the mark, which then has to stand out from across a room. */
    setWordMode(on) {
        this.element.classList.toggle('yomitan-word-mode', on);
    }

    /**
     * Keeps the lines clear of the OSD.
     * @param {{top: number, bottom: number}} insets Pixels at each end of the screen.
     */
    setInsets({top, bottom}) {
        this.element.style.setProperty('--yomitan-osd-top', `${top}px`);
        this.element.style.setProperty('--yomitan-osd-bottom', `${bottom}px`);
    }

    /** @param {boolean} present Whether a secondary subtitle is on, so this line has to sit above it. */
    setBelowSecondary(present) {
        this.element.classList.toggle('yomitan-below-secondary', present);
    }

    destroy() {
        this.element.remove();
    }
}
