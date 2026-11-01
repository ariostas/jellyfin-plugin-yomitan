// A short message over whatever is on screen, for the few things someone has to be told. It takes no pointer events, so
// it cannot get in the way of the OSD, and it goes inside a fullscreen element if there is one.
import {element} from './dom.js';

const SHOW_MS = 7000;
const STYLE = `position: fixed; z-index: 1160; top: 10%; left: 50%; transform: translateX(-50%); box-sizing: border-box;
max-width: min(90vw, 36em); padding: 0.6em 1em; border-radius: 6px; background: rgba(0, 0, 0, 0.85); color: #fff;
font-size: 16px; line-height: 1.4; text-align: center; pointer-events: none; white-space: normal; width: max-content;`;

let shown = null;
let timer = 0;

/** @param {string} text */
export function showNotice(text) {
    shown?.remove();
    clearTimeout(timer);
    shown = element('div', {class: 'yomitan-notice', role: 'status'}, text);
    shown.style.cssText = STYLE;
    const parent = document.fullscreenElement && document.fullscreenElement.tagName !== 'VIDEO' ? document.fullscreenElement : document.body;
    parent.append(shown);
    timer = setTimeout(() => {
        shown?.remove();
        shown = null;
    }, SHOW_MS);
}
