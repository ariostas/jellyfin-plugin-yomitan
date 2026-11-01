// What jellyfin-web's on-screen display occupies. It sits at the top and bottom of the screen, where the subtitles do,
// and it has to stay usable, so the lines move out of its way while it is showing.

/** Clear space between the controls and a line, in pixels. */
const GAP = 8;

/** jellyfin-web keeps the page of a finished video, hidden, with its OSD as it left it, so a second video has two. */
const CURRENT_PAGE = '.page:not(.hide)';

/** @returns {HTMLElement|null} The OSD's bar, if it is showing. */
function shownBar() {
    const bar = document.querySelector(`${CURRENT_PAGE} .videoOsdBottom`);
    return bar && !bar.classList.contains('hide') && !bar.classList.contains('videoOsdBottom-hidden') ? bar : null;
}

/**
 * Hides the OSD, which jellyfin-web only offers through Escape. Only ever with the OSD showing, because with nothing to
 * hide, Escape means going back and leaves the player. As a second lock, the event goes no further than the document,
 * where the OSD listens: going back is decided on the window.
 */
export function hideOsd() {
    if (shownBar()) {
        const escape = {key: 'Escape', code: 'Escape', keyCode: 27, which: 27, cancelable: true};
        document.dispatchEvent(new KeyboardEvent('keydown', escape));
    }
}

/** @returns {{top: number, bottom: number}} How many pixels the OSD's controls take at each end of the screen. */
export function measureOsd() {
    const bar = shownBar();
    if (!bar) {
        return {top: 0, bottom: 0};
    }

    // The bar reaches far up the screen for its gradient, and only the controls are in the way.
    const controls = bar.querySelector('.osdControls')?.getBoundingClientRect();
    const header = document.querySelector('.videoOsd-appBar')?.getBoundingClientRect();
    return {
        top: header ? Math.ceil(header.bottom + GAP) : 0,
        bottom: controls ? Math.ceil(innerHeight - controls.top + GAP) : 0,
    };
}
