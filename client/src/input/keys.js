// The keyboard and a TV remote. While the video is paused the arrow keys can walk a cursor over the words on screen,
// which is word mode. Only this file claims keys, and only those it uses at that moment: everything else, and everything
// while the video plays, stays jellyfin-web's. What each key does is in docs/client.md.
import {hideOsd, measureOsd} from '../playback/osd.js';
import {entersWithUpOnly} from '../settings.js';
import {isBack} from './back.js';

/** jellyfin-web's own table in keyboardNavigation.js, by key code: keyboards, webOS, Tizen, Xbox and gamepads. */
const COMMANDS = {
    13: 'enter', 195: 'enter',
    37: 'left', 140: 'left', 205: 'left', 214: 'left',
    38: 'up', 138: 'up', 203: 'up', 211: 'up',
    39: 'right', 141: 'right', 206: 'right', 213: 'right',
    40: 'down', 139: 'down', 204: 'down', 212: 'down',
};

/** Input types that do not take keys of their own. The rest do, like jellyfin-web's sliders. Its list. */
const BUTTON_LIKE_INPUTS = new Set(['button', 'checkbox', 'color', 'file', 'hidden', 'image', 'radio', 'reset', 'submit']);

const SCROLL_PIXELS = 120;

/** How jellyfin-web asks whether one of its dialogs or menus is open. */
const OPEN_DIALOG = '.dialogContainer .dialog.opened';

function commandOf(event) {
    return isBack(event) ? 'back' : COMMANDS[event.keyCode];
}

/** @param {Element|null} element @returns {boolean} Whether this element has a use for the arrow keys itself. */
function takesKeys(element) {
    if (!element) {
        return false;
    }

    return element.isContentEditable || element.tagName === 'TEXTAREA' || element.tagName === 'SELECT' ||
        (element.tagName === 'INPUT' && !BUTTON_LIKE_INPUTS.has(element.type));
}

/**
 * Every word on screen that a dictionary has, top to bottom: the signs and then the dialogue, as they are drawn.
 * @param {readonly import('../subtitles/timeline.js').Cue[]} cues
 * @param {(cueId: number) => import('../segmenter.js').Word[]|undefined} wordsOf
 * @returns {{cueId: number, index: number, kind: string}[]}
 */
function wordsInOrder(cues, wordsOf) {
    const signs = cues.filter(({kind}) => kind === 'sign');
    const dialogue = cues.filter(({kind}) => kind !== 'sign');
    return [...signs, ...dialogue].flatMap(({id: cueId, kind}) => (wordsOf(cueId) ?? []).flatMap(({known}, index) => (
        known ? [{cueId, index, kind}] : []
    )));
}

export class KeyInput {
    /**
     * @param {object} options
     * @param {import('../popup/lookup.js').WordLookup} options.lookup
     * @param {import('../overlay.js').Overlay} options.overlay
     * @param {import('./pointer.js').PointerInput} options.pointer
     * @param {HTMLVideoElement} options.video
     * @param {import('../settings.js').Settings} options.settings
     * @param {() => readonly import('../subtitles/timeline.js').Cue[]} options.cues What is on screen now.
     * @param {(cueId: number) => import('../segmenter.js').Word[]|undefined} options.wordsOf
     * @param {AbortSignal} options.signal Ends the listeners.
     */
    constructor({lookup, overlay, pointer, video, settings, cues, wordsOf, signal}) {
        this._lookup = lookup;
        this._overlay = overlay;
        this._pointer = pointer;
        this._video = video;
        this._settings = settings;
        this._cues = cues;
        this._wordsOf = wordsOf;
        this._active = false;
        /** In word mode, waiting for the words of a line before the cursor can land on one. */
        this._landing = false;
        /** Which way the cursor last went, which is where it goes on if a word turns out to have nothing. */
        this._direction = 1;
        /** Words that found nothing this time round, despite `known`. */
        this._misses = new Set();
        /** Codes of keys that were claimed and are still down. A held key's repeats follow it, whatever has changed since. */
        this._down = new Set();
        this._hidingOsd = false;

        window.addEventListener('keydown', this._onKeyDown, {capture: true, signal});
        window.addEventListener('keyup', this._onKeyUp, {capture: true, signal});
        lookup.addEventListener('close', this._onLookupClosed, {signal});
        // Before there is a word open, nothing else would notice these.
        for (const type of ['play', 'seeking', 'emptied']) {
            video.addEventListener(type, this._leave, {signal});
        }

        signal.addEventListener('abort', this._leave);
    }

    /** @returns {boolean} Whether the keys are walking the words. */
    get active() {
        return this._active;
    }

    /** The lines on screen or their words changed. A cursor that was waiting for them lands. */
    linesChanged() {
        if (this._landing) {
            this._land();
        }
    }

    _onKeyDown = (event) => {
        if (this._hidingOsd) {
            return;
        }

        const command = commandOf(event);
        if (!command) {
            return;
        }

        // Without this, the repeats of a Back held down for a moment would find word mode over, and go back in earnest.
        if (!this._active && event.repeat && this._down.has(event.keyCode)) {
            this._claim(event);
            return;
        }

        if (!this._isPlayerListening(event)) {
            return;
        }

        if (this._active) {
            this._claim(event);
            this._act(command);
        } else if (!event.repeat && this._isEntry(command) && this._hasWords()) {
            this._claim(event);
            this._enter();
        }
    };

    _onKeyUp = ({keyCode}) => {
        this._down.delete(keyCode);
    };

    /** @returns {boolean} Whether the keys could be for the paused player, and not for something on top of it. */
    _isPlayerListening({ctrlKey, altKey, metaKey, shiftKey}) {
        return this._video.paused && !ctrlKey && !altKey && !metaKey && !shiftKey && !takesKeys(document.activeElement) &&
            !document.querySelector(OPEN_DIALOG);
    }

    _isEntry(command) {
        return command === 'up' || (!entersWithUpOnly(this._settings) && (command === 'left' || command === 'right'));
    }

    /** @returns {boolean} Whether there is, or may be about to be, a word to put the cursor on. */
    _hasWords() {
        const cues = this._cues();
        return this._lookup.current !== null || cues.some(({id}) => !this._wordsOf(id)) ||
            wordsInOrder(cues, this._wordsOf).length > 0;
    }

    _claim(event) {
        event.preventDefault();
        event.stopImmediatePropagation();
        this._down.add(event.keyCode);
    }

    _act(command) {
        switch (command) {
            case 'left':
                this._move(-1);
                break;
            case 'right':
                this._move(1);
                break;
            case 'up':
                this._lookup.scrollBy(-SCROLL_PIXELS);
                break;
            case 'down':
                this._lookup.scrollBy(SCROLL_PIXELS);
                break;
            case 'back':
                this._stop();
                break;
            case 'enter':
                this._stop();
                this._video.play().catch((error) => {
                    console.debug('[yomitan] could not resume:', error);
                });
                break;
        }
    }

    _enter() {
        this._active = true;
        this._direction = 1;
        this._overlay.setWordMode(true);
        this._pointer.standAside(this._leave);
        // From here the person is working with a paused video, so a hover's pause is theirs too. Back has to stay paused.
        this._lookup.keepPaused();
        this._land();
    }

    /** Puts the cursor on the word in use if there is one, and otherwise on the first of the dialogue, once it is known. */
    _land() {
        const cues = this._cues();
        const open = this._lookup.current;
        this._landing = !open && cues.some(({id}) => !this._wordsOf(id));
        if (this._landing) {
            return;
        }

        const words = wordsInOrder(cues, this._wordsOf);
        const first = words.find(({kind}) => kind !== 'sign') ?? words[0];
        if (!open && !first) {
            this._leave();
            return;
        }

        this._clearOsd();
        if (!open) {
            this._lookup.open(first);
        }
    }

    /** The line moves down once the OSD has gone, and the popup with it. */
    _clearOsd() {
        this._hidingOsd = true;
        hideOsd();
        this._hidingOsd = false;
        this._overlay.setInsets(measureOsd());
        this._lookup.place();
    }

    _targets() {
        return wordsInOrder(this._cues(), this._wordsOf).filter(({cueId, index}) => !this._misses.has(`${cueId}/${index}`));
    }

    /** @param {number} direction 1 for the next word, -1 for the one before. At either end, the cursor stays. */
    _move(direction) {
        const {current} = this._lookup;
        if (!current) {
            return;
        }

        this._direction = direction;
        const targets = this._targets();
        const position = targets.findIndex(({cueId, index}) => cueId === current.cueId && index === current.index);
        const next = targets[position + direction];
        if (next) {
            this._lookup.open(next);
        }
    }

    /** A word that finds nothing is skipped as if it had never been there, and only the last one left ends this. */
    _skip(word) {
        const targets = this._targets();
        const position = targets.findIndex(({cueId, index}) => cueId === word.cueId && index === word.index);
        const next = targets[position + this._direction] ?? targets[position - this._direction];
        this._misses.add(`${word.cueId}/${word.index}`);
        if (next) {
            this._lookup.open(next);
        } else {
            this._leave();
        }
    }

    _onLookupClosed = ({detail: {reason, word}}) => {
        if (this._active && reason === 'miss') {
            this._skip(word);
        } else {
            this._leave();
        }
    };

    _stop() {
        this._leave();
        this._lookup.close();
    }

    _leave = () => {
        if (this._active) {
            this._active = false;
            this._landing = false;
            this._misses.clear();
            this._overlay.setWordMode(false);
            this._pointer.comeBack();
        }
    };
}
