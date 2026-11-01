// Mouse and touch. A mouse hovers and a finger taps, and which one it is comes from each event, since a laptop can have
// both. What each one does is in docs/client.md.

/** A tap's mouse and click events follow its touch by about this much, and are over by then. */
const TAP_SETTLE_MS = 700;

/** How far a mouse can drift and still count as resting, in pixels, since a hand is never quite still. */
const REST_RADIUS = 8;

/** @param {{cueId: number, index: number}|null} a @param {{cueId: number, index: number}|null} b */
function sameWord(a, b) {
    return a?.cueId === b?.cueId && a?.index === b?.index;
}

export class PointerInput {
    /**
     * @param {object} options
     * @param {import('../popup/lookup.js').WordLookup} options.lookup
     * @param {import('../overlay.js').Overlay} options.overlay
     * @param {import('../settings.js').Settings} options.settings
     * @param {AbortSignal} options.signal Ends the listeners.
     */
    constructor({lookup, overlay, settings, signal}) {
        this._lookup = lookup;
        this._overlay = overlay;
        this._settings = settings;
        /** Who opened what is showing. A touch stays until the next tap, whatever the mouse does. */
        this._openedBy = null;
        this._waitingFor = null;
        this._waitPosition = null;
        this._waitTimer = 0;
        this._graceTimer = 0;
        /** The word under the mouse when someone closed its popup, which must not reopen until the mouse leaves it. */
        this._dismissed = null;
        this._swallowUntil = 0;
        this._mouse = null;
        /** Set while the keyboard is using the popup. Called when the mouse or a finger takes it back. */
        this._onTakenBack = null;
        this._restingAt = null;

        const capture = {capture: true, signal};
        const active = {capture: true, signal, passive: false};
        document.addEventListener('pointermove', this._onPointerMove, {...capture, passive: true});
        document.documentElement.addEventListener('pointerleave', this._onPointerLeave, {signal});
        window.addEventListener('pointerdown', this._onPointerDown, capture);
        window.addEventListener('touchstart', this._onTouchStart, active);
        for (const type of ['mousedown', 'mouseup', 'click', 'dblclick', 'contextmenu']) {
            window.addEventListener(type, this._swallow, active);
        }

        lookup.addEventListener('close', this._onLookupClosed, {signal});
        signal.addEventListener('abort', () => {
            clearTimeout(this._waitTimer);
            clearTimeout(this._graceTimer);
        });
    }

    /** @returns {boolean} Whether something is about to happen to the word under the mouse. */
    get busy() {
        return this._waitingFor !== null;
    }

    _isInPopup(target) {
        return target === this._lookup.host;
    }

    /**
     * The keyboard is using the popup now, so nothing under way here may touch it, until someone really uses the mouse or
     * a finger. That ends the keyboard's turn, and the popup carries on as if this class had opened it.
     * @param {() => void} onTakenBack
     */
    standAside(onTakenBack) {
        this._stopWaiting();
        clearTimeout(this._graceTimer);
        this._graceTimer = 0;
        this._onTakenBack = onTakenBack;
        this._restingAt = this._mouse;
    }

    /** The keyboard has finished. */
    comeBack() {
        this._onTakenBack = null;
    }

    _takeBack() {
        const onTakenBack = this._onTakenBack;
        this._onTakenBack = null;
        onTakenBack?.();
    }

    /** @returns {boolean} Whether the keyboard is still in charge, as a hand resting on a mouse does not count. */
    _isStandingAside(position) {
        if (this._onTakenBack) {
            this._restingAt ??= position;
            if (Math.hypot(position.x - this._restingAt.x, position.y - this._restingAt.y) <= REST_RADIUS) {
                return true;
            }

            this._takeBack();
        }

        return false;
    }

    /**
     * Only a move counts. A browser sends pointerover when a line appears under a mouse at rest, and that must not pause
     * the video, which is why this does not listen for it.
     */
    _onPointerMove = ({pointerType, target, clientX: x, clientY: y}) => {
        if (pointerType === 'touch') {
            return;
        }

        this._mouse = {x, y};
        if (!this._isStandingAside(this._mouse) && this._openedBy !== 'touch') {
            this._onHover(this._overlay.wordAt(target), this._isInPopup(target), {x, y});
        }
    };

    _onPointerLeave = ({pointerType}) => {
        if (pointerType !== 'touch' && this._openedBy !== 'touch' && !this._onTakenBack) {
            this._onHover(null, false, null);
        }
    };

    /** @returns {boolean} Whether the mouse has gone far enough to mean it is still on its way somewhere. */
    _hasMoved({x, y}) {
        return Math.hypot(x - this._waitPosition.x, y - this._waitPosition.y) > REST_RADIUS;
    }

    _onHover(word, inPopup, position) {
        const onCurrent = word !== null && sameWord(word, this._lookup.current);
        if (inPopup || onCurrent) {
            this._stopWaiting();
            clearTimeout(this._graceTimer);
            this._graceTimer = 0;
            return;
        }

        if (!sameWord(word, this._dismissed)) {
            this._dismissed = null;
        }

        if (word === null || this._dismissed) {
            this._stopWaiting();
            this._startGrace();
            return;
        }

        clearTimeout(this._graceTimer);
        this._graceTimer = 0;
        // The wait starts over on every real move, and not just on a new word: a long word can be 300 px wide, and a mouse
        // crossing it is on it for longer than the delay.
        if (!sameWord(word, this._waitingFor) || this._hasMoved(position)) {
            this._stopWaiting();
            this._waitingFor = word;
            this._waitPosition = position;
            this._waitTimer = setTimeout(() => {
                this._waitingFor = null;
                this._open(word, 'mouse');
            }, this._settings.get('hoverDelayMs'));
        }
    }

    _stopWaiting() {
        clearTimeout(this._waitTimer);
        this._waitingFor = null;
    }

    _startGrace() {
        if (this._lookup.current && this._graceTimer === 0) {
            this._graceTimer = setTimeout(() => {
                this._graceTimer = 0;
                this._lookup.close('left');
            }, this._settings.get('hoverGraceMs'));
        }
    }

    async _open(word, source) {
        this._openedBy = source;
        await this._lookup.open(word);
        // A word that turned out to have nothing leaves nobody in charge. The next input must not find a stale owner.
        if (!this._lookup.current) {
            this._openedBy = null;
        }
    }

    _onPointerDown = (event) => {
        const {pointerType, target} = event;
        this._swallowUntil = 0;
        this._takeBack();
        if (this._isInPopup(target)) {
            return;
        }

        const word = this._overlay.wordAt(target);
        if (pointerType === 'touch') {
            if (word || this._lookup.current) {
                this._takeTap(event);
                if (word) {
                    this._open(word, 'touch');
                } else {
                    this._lookup.close('tapped');
                }
            }
        } else if (word) {
            // A click does not have to wait out the hover delay.
            this._stopWaiting();
            this._open(word, 'mouse');
        } else if (this._openedBy === 'touch' && this._lookup.current) {
            this._takeTap(event);
            this._lookup.close('tapped');
        }
    };

    /** Keeps a tap from jellyfin-web, which acts on pointerdown: a touch toggles the OSD, a mouse toggles playback. */
    _takeTap(event) {
        event.stopImmediatePropagation();
        this._swallowUntil = performance.now() + TAP_SETTLE_MS;
    }

    _onTouchStart = (event) => {
        // Stops the browser making a click from this touch at all, which also means a button under it stays unpressed.
        if (this._isSwallowing(event)) {
            event.preventDefault();
        }
    };

    _isSwallowing({target}) {
        return performance.now() < this._swallowUntil && !this._isInPopup(target);
    }

    _swallow = (event) => {
        if (this._isSwallowing(event)) {
            event.preventDefault();
            event.stopImmediatePropagation();
        }
    };

    _onLookupClosed = ({detail: {reason, word}}) => {
        const source = this._openedBy;
        this._openedBy = null;
        clearTimeout(this._graceTimer);
        this._graceTimer = 0;
        if (source === 'mouse' && reason !== 'left') {
            this._dismissed = word;
        }
    };
}
