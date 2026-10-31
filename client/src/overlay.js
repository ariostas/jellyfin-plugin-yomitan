// Draws the current cues as plain text split into word spans, over the video. It knows nothing about playback, and
// takes no input: pointer-events stay off so clicks reach the player. Phase 4 turns them on for the words.

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
    padding: 4% 5% var(--yomitan-bottom, 8%);
    box-sizing: border-box;
    color: #fff;
    font-size: clamp(18px, 5vh, 44px);
    line-height: 1.4;
    text-align: center;
    text-shadow: 0 0 3px #000, 0 0 3px #000, 0 1px 4px #000;
}
.yomitan-overlay[hidden] { display: none; }
.yomitan-overlay.yomitan-below-secondary { --yomitan-bottom: 24%; }
.yomitan-signs { font-size: 0.75em; }
.yomitan-lines { margin-top: auto; }
.yomitan-line { white-space: pre-wrap; }
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
    /** @param {HTMLElement} container The player's container, so the overlay goes wherever the video does. */
    constructor(container) {
        installStyle();
        this.element = document.createElement('div');
        this.element.className = 'yomitan-overlay';
        this.element.lang = 'ja';
        this.element.hidden = true;
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
    }

    /** @param {boolean} present Whether a secondary subtitle is on, so this line has to sit above it. */
    setBelowSecondary(present) {
        this.element.classList.toggle('yomitan-below-secondary', present);
    }

    destroy() {
        this.element.remove();
    }
}
