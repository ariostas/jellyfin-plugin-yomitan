// The one place the plugin puts anything on screen. jellyfin-web's page sits over the video and takes every pointer
// event, and the video's container is its own stacking context, so nothing inside it can be hit. This layer goes in the
// body instead, over the page and the OSD (z-index 1 and up, and 1100 for its app bar), and under jellyfin-web's own
// dialogs and menus (1300 and up). It takes no input itself: only the elements that ask for it do.

const STYLE_ID = 'yomitan-layer-style';
const CSS = `
.yomitan-layer {
    position: fixed;
    inset: 0;
    z-index: 1150;
    overflow: hidden;
    pointer-events: none;
}
`;

function fullscreenParent() {
    const element = document.fullscreenElement;
    // A video in fullscreen shows nothing but itself, so there is no way to be inside it.
    return element && element !== document.documentElement && element.tagName !== 'VIDEO' ? element : document.body;
}

export class Layer {
    /** @param {AbortSignal} signal Ends the layer's listeners. */
    constructor(signal) {
        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement('style');
            style.id = STYLE_ID;
            style.textContent = CSS;
            document.head.append(style);
        }

        this.element = document.createElement('div');
        this.element.className = 'yomitan-layer';
        this._follow();
        // jellyfin-web makes the whole page fullscreen, so normally this has nothing to do.
        document.addEventListener('fullscreenchange', this._follow, {signal});
    }

    _follow = () => {
        const parent = fullscreenParent();
        if (this.element.parentElement !== parent) {
            parent.append(this.element);
        }
    };

    destroy() {
        this.element.remove();
    }
}
