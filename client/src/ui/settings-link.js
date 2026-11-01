// The way to a user's settings. jellyfin-web only routes a plugin's page for admins, so everyone else needs another door:
// this adds one to Settings, the page behind the user's picture, which every signed-in user has in every layout.
import {element} from './dom.js';

const PAGE = '#myPreferencesMenuPage:not(.hide)';
const AFTER = '.lnkSubtitlePreferences';
const LINK_CLASS = 'yomitan-settings-link';

/**
 * An admin can open this page for another user, with `userId` in the URL. Settings here are always the signed-in
 * user's own, so a link there would change the wrong person's.
 * @returns {boolean}
 */
function isOwnPage() {
    const query = new URLSearchParams(location.hash.split('?')[1] ?? '');
    const userId = query.get('userId');
    return !userId || userId === window.ApiClient?.getCurrentUserId();
}

/**
 * Adds the link if the page is showing. Anything not found means no link, and nothing else.
 * @param {() => void} open
 */
export function addSettingsLink(open) {
    const anchor = document.querySelector(`${PAGE} ${AFTER}`);
    if (!anchor?.parentElement || document.querySelector(`${PAGE} .${LINK_CLASS}`) || !isOwnPage()) {
        return;
    }

    const link = element(
        'a',
        {href: '#', class: `emby-button listItem-border ${LINK_CLASS}`, on: {click: (event) => {
            event.preventDefault();
            open();
        }}},
        element(
            'div',
            {class: 'listItem'},
            element('span', {class: 'material-icons listItemIcon listItemIcon-transparent translate', 'aria-hidden': 'true'}),
            element('div', {class: 'listItemBody'}, element('div', {class: 'listItemBodyText'}, 'Yomitan')),
        ),
    );
    link.style.cssText = 'display: block; margin: 0; padding: 0;';
    anchor.after(link);
}
