// What jellyfin-web's on-screen display occupies. It sits at the top and bottom of the screen, where the subtitles do,
// and it has to stay usable, so the lines move out of its way while it is showing.

/** Clear space between the controls and a line, in pixels. */
const GAP = 8;

/** @returns {{top: number, bottom: number}} How many pixels the OSD's controls take at each end of the screen. */
export function measureOsd() {
    const bar = document.querySelector('.videoOsdBottom');
    if (!bar || bar.classList.contains('hide') || bar.classList.contains('videoOsdBottom-hidden')) {
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
