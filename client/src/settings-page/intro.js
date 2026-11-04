// The notice that says what the button in the player is, the first time someone plays a track it is for with the feature
// off. Its tooltip never shows on a phone or a TV, so this is the only other way to learn of it. It is in the settings
// page's script, which the loader fetches for it, because only a user who has not seen it needs it, once, and the loader
// on every page has to stay small.
import {isBack} from '../input/back.js';
import {element, installStyle} from '../ui/dom.js';

const TEXT = 'Yomitan can look up the words of these Japanese subtitles. The 文A button next to the subtitle button turns it on.';
/** Long enough to read, and to reach with a remote. It waits while it has the focus. */
const SHOW_MS = 20_000;
/** The longest a timer takes. This one keeps time itself. */
const UNTIL_CLOSED = 2 ** 31 - 1;
const CSS = `
.yomitan-intro-actions { display: flex; justify-content: center; gap: 0.75em; margin-top: 0.5em; pointer-events: auto; }
.yomitan-intro-actions button {
    min-width: 44px; min-height: 44px; padding: 0 1em; border: 1px solid rgba(255, 255, 255, 0.5); border-radius: 4px;
    background: none; color: inherit; font: inherit; cursor: pointer;
}
.yomitan-intro-actions button:focus { outline: 2px solid var(--jf-palette-primary-main, #00a4dc); outline-offset: 1px; }
`;
/** Backspace in a text field is for the text. A slider does nothing with Back. */
const TEXT_FIELD = 'input:not([type=range]), textarea, select, [contenteditable]';
/** How jellyfin-web asks whether one of its dialogs or menus is open. Back is theirs then. */
const OPEN_DIALOG = '.dialogContainer .dialog.opened';

/**
 * Shows it. Either button, or Back, sets `introSeen`, so that it never shows again, on any device. It does not take the
 * focus, and a remote reaches its buttons as it does the OSD's.
 * @param {import('../settings.js').Settings} settings
 * @param {(content: Node, ms: number) => () => void} showNotice The loader's, so that it goes in the one live region.
 * @returns {() => void} Closes it.
 */
export function showIntro(settings, showNotice) {
    installStyle('yomitan-intro-style', CSS);
    /** What had the focus before it moved in here, to give it back. */
    let returnFocus = null;
    /** A Back that closed it, so that its repeats, if it is held, do not go on to leave the player. */
    let heldBack = null;
    let close = () => {};
    let timer = 0;

    const answer = (run) => () => {
        const hadFocus = node.contains(document.activeElement);
        clearTimeout(timer);
        close();
        if (hadFocus && returnFocus?.isConnected) {
            returnFocus.focus();
        }

        run();
        settings.set('introSeen', true);
    };
    const notNow = answer(() => {});
    const turnOn = answer(() => settings.set('enabled', true));
    const button = (label, onClick) => element('button', {type: 'button', textContent: label, on: {click: onClick}});
    const node = element('div', {}, TEXT, element('div', {class: 'yomitan-intro-actions'}, button('Turn on', turnOn), button('Not now', notNow)));
    node.addEventListener('focusin', ({relatedTarget}) => {
        if (!node.contains(relatedTarget)) {
            returnFocus = relatedTarget;
        }
    });

    // Back closes it as Not now does. Not through a click: in Firefox jellyfin-web drops a click on anything but where the
    // last key went. On window, before jellyfin-web, which would otherwise leave the player.
    const onKeyDown = (event) => {
        const claim = () => {
            event.preventDefault();
            event.stopImmediatePropagation();
        };

        if (event.repeat && event.keyCode === heldBack) {
            claim();
            return;
        }

        heldBack = null;
        if (!node.isConnected) {
            window.removeEventListener('keydown', onKeyDown, {capture: true});
            return;
        }

        if (isBack(event) && !event.target.matches?.(TEXT_FIELD) && !document.querySelector(OPEN_DIALOG)) {
            claim();
            heldBack = event.keyCode;
            notNow();
        }
    };

    window.addEventListener('keydown', onKeyDown, {capture: true});
    close = showNotice(node, UNTIL_CLOSED);
    const wait = () => {
        timer = setTimeout(() => (node.contains(document.activeElement) ? wait() : close()), SHOW_MS);
    };

    wait();
    return close;
}
