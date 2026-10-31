// Where the popup goes. Plain arithmetic, so the tests can run it at any size without a browser.

/** From the screen's edge, and from the word, in pixels. */
const MARGIN = 8;
const GAP = 6;
const MAX_WIDTH = 460;
/** Below this it is not worth having the popup on that side if the other side has more. */
const COMFORTABLE_HEIGHT = 180;

/**
 * @param {number} viewportWidth
 * @returns {number} How wide the popup is, which it has to know before it can measure its content.
 */
export function popupWidth(viewportWidth) {
    return Math.min(viewportWidth - 2 * MARGIN, MAX_WIDTH);
}

/**
 * @param {object} options
 * @param {{width: number, height: number}} options.viewport
 * @param {{left: number, right: number, top: number, bottom: number}} options.anchor The word.
 * @param {number} options.contentHeight How tall the entries want to be.
 * @param {number} [options.avoidBottom] Pixels at the bottom to stay out of if there is a choice, for the OSD.
 * @returns {{left: number, top: number, maxHeight: number, side: 'above'|'below'}}
 */
export function placePopup({viewport, anchor, contentHeight, avoidBottom = 0}) {
    const width = popupWidth(viewport.width);
    const middle = (anchor.left + anchor.right) / 2;
    const left = Math.min(Math.max(MARGIN, middle - width / 2), viewport.width - MARGIN - width);

    const above = anchor.top - GAP - MARGIN;
    const below = viewport.height - anchor.bottom - GAP - MARGIN;
    const belowClear = below - avoidBottom;
    // A word near the top only has room below, even if that means sharing it with the OSD.
    const useBelow = above < Math.min(contentHeight, COMFORTABLE_HEIGHT) && below > above;
    if (useBelow) {
        const maxHeight = Math.max(contentHeight <= belowClear ? belowClear : below, 0);
        return {left, top: anchor.bottom + GAP, maxHeight, side: 'below'};
    }

    const maxHeight = Math.max(above, 0);
    return {left, top: anchor.top - GAP - Math.min(contentHeight, maxHeight), maxHeight, side: 'above'};
}
