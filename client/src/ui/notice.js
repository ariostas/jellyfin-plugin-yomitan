// A short message over whatever is on screen, for the few things someone has to be told. Messages go in one live region
// that stays in the page, since screen readers announce what changes inside a region and often miss one that is new. It
// takes no pointer events, so it cannot get in the way of the OSD, apart from buttons a message brings. It goes inside a
// fullscreen element if there is one.
import {element} from './dom.js';

const SHOW_MS = 7000;
// Kept short, as the loader is on every page.
const REGION_STYLE = 'position:fixed;z-index:1160;top:10%;left:50%;transform:translateX(-50%);width:max-content;' +
    'max-width:min(90vw,36em);pointer-events:none';
const STYLE = 'padding:.6em 1em;border-radius:6px;background:rgba(0,0,0,.85);color:#fff;font-size:16px;line-height:1.4;' +
    'text-align:center';

let region = null;
let shown = null;
let timer = 0;

function hide() {
    clearTimeout(timer);
    shown?.remove();
    shown = null;
}

/**
 * Shows a message in place of any other, for a while.
 * @param {string|Node} content
 * @param {number} [ms]
 * @returns {() => void} Closes this message, if it is still the one showing.
 */
export function showNotice(content, ms = SHOW_MS) {
    if (!region) {
        region = element('div', {class: 'yomitan-notices', role: 'status', style: REGION_STYLE});
    }

    hide();
    const {fullscreenElement: fullscreen} = document;
    const parent = fullscreen && fullscreen.tagName !== 'VIDEO' ? fullscreen : document.body;
    if (region.parentElement !== parent) {
        parent.append(region);
    }

    const notice = element('div', {class: 'yomitan-notice', style: STYLE}, content);
    shown = notice;
    region.append(notice);
    timer = setTimeout(hide, ms);
    return () => {
        if (shown === notice) {
            hide();
        }
    };
}
