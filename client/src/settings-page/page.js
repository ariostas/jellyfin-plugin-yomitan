// A user's own settings. jellyfin-web only routes a plugin's page for admins, so this is not a page in its router: it
// covers the screen, in the body, and the Back button closes it. It keeps to jellyfin-web's colours, and it is plain
// DOM so that jellyfin-web's focus handling can walk it with a remote.
//
// It only ever talks to the settings store, apart from listing the dictionaries. Titles come from a zip anyone can
// write, and only ever go on screen as text.
import {apiFetchOk} from '../api.js';
import {orderDictionaries} from '../engine/dictionary-set.js';
import {entersWithUpOnly, SETTING_BOUNDS} from '../settings.js';
import {element, formatCount, formatSize, installStyle} from '../ui/dom.js';

const CSS = `
.yomitan-settings {
    position: fixed;
    inset: 0;
    z-index: 2000;
    overflow-y: auto;
    overscroll-behavior: contain;
    background: var(--jf-palette-background-default, #101010);
    color: var(--jf-palette-text-primary, #fff);
    font-size: 16px;
    line-height: 1.4;
    text-align: left;
}
.yomitan-settings-inner {
    box-sizing: border-box;
    max-width: 44em;
    margin: 0 auto;
    padding: max(0.75em, env(safe-area-inset-top)) max(1em, env(safe-area-inset-right)) 3em max(1em, env(safe-area-inset-left));
}
.yomitan-settings header { display: flex; align-items: center; gap: 0.5em; margin-bottom: 0.5em; }
.yomitan-settings h1 { flex: 1; margin: 0; font-size: 1.5em; font-weight: 500; }
.yomitan-settings h2 { margin: 1.5em 0 0.5em; font-size: 1.1em; font-weight: 500; }
.yomitan-settings .yomitan-help { margin: 0.25em 0 0; color: var(--jf-palette-text-secondary, rgba(255, 255, 255, 0.7)); font-size: 0.875em; }
.yomitan-settings .yomitan-status { min-height: 1.4em; margin: 0; font-size: 0.875em; color: var(--jf-palette-text-secondary, rgba(255, 255, 255, 0.7)); }
.yomitan-settings .yomitan-status[data-state=retrying], .yomitan-settings .yomitan-status[data-state=refused] { color: #ffb300; }
.yomitan-settings button {
    min-width: 44px;
    min-height: 44px;
    padding: 0 0.75em;
    border: 1px solid var(--jf-palette-divider, rgba(255, 255, 255, 0.24));
    border-radius: 4px;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
}
.yomitan-settings button:disabled { opacity: 0.35; cursor: default; }
.yomitan-settings button:focus-visible, .yomitan-settings input:focus-visible, .yomitan-settings select:focus-visible {
    outline: 2px solid var(--jf-palette-primary-main, #00a4dc);
    outline-offset: 1px;
}
.yomitan-settings label.yomitan-check { display: flex; align-items: center; gap: 0.75em; min-height: 44px; cursor: pointer; }
.yomitan-settings input[type=checkbox] { flex: none; width: 22px; height: 22px; margin: 0; accent-color: var(--jf-palette-primary-main, #00a4dc); }
.yomitan-settings .yomitan-field { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5em 0.75em; min-height: 44px; }
.yomitan-settings .yomitan-field label { flex: 1 1 12em; }
.yomitan-settings input[type=number] {
    box-sizing: border-box;
    width: 6em;
    min-height: 44px;
    padding: 0 0.5em;
    border: 1px solid var(--jf-palette-divider, rgba(255, 255, 255, 0.24));
    border-radius: 4px;
    background: none;
    color: inherit;
    font: inherit;
}
.yomitan-settings .yomitan-field-wide label { flex-basis: 100%; }
.yomitan-settings input[type=range] { flex: 1; min-width: 0; min-height: 44px; margin: 0; accent-color: var(--jf-palette-primary-main, #00a4dc); }
.yomitan-settings output { flex: none; min-width: 3.5em; text-align: right; }
.yomitan-settings .yomitan-dictionaries { margin: 0; padding: 0; list-style: none; }
.yomitan-settings .yomitan-dictionary {
    display: flex;
    align-items: center;
    gap: 0.25em;
    padding: 0.25em 0;
    border-top: 1px solid var(--jf-palette-divider, rgba(255, 255, 255, 0.12));
}
.yomitan-settings .yomitan-dictionary label { flex: 1; min-width: 0; }
.yomitan-settings .yomitan-dictionary-title { overflow-wrap: anywhere; }
.yomitan-settings .yomitan-dictionary-text { min-width: 0; }
.yomitan-settings .yomitan-dictionary button { flex: none; padding: 0; }
`;

const STATUS = {
    saved: 'Saved',
    saving: 'Saving',
    retrying: 'Not saved yet: the server cannot be reached. It applies here, and will be sent again.',
    refused: 'The server refused that, so it went back to what it was.',
};

/** @param {() => boolean} [read] What the box shows, for a setting whose default is not a plain value. */
function checkbox(settings, name, text, help, read = () => settings.get(name)) {
    const input = element('input', {
        type: 'checkbox',
        id: `yomitan-setting-${name}`,
        checked: read(),
        on: {change: () => settings.set(name, input.checked)},
    });
    const update = () => {
        input.checked = read();
    };

    return {
        node: element('div', {}, element('label', {class: 'yomitan-check'}, input, element('span', {}, text)), help && element('p', {class: 'yomitan-help'}, help)),
        update,
    };
}

function numberField(settings, name, text) {
    const {min, max} = SETTING_BOUNDS[name];
    const input = element('input', {
        type: 'number',
        id: `yomitan-setting-${name}`,
        min,
        max,
        step: 50,
        value: settings.get(name),
        inputMode: 'numeric',
        on: {change: () => {
            const value = Math.round(Number(input.value));
            if (input.value !== '' && Number.isFinite(value)) {
                settings.set(name, Math.min(max, Math.max(min, value)));
            }

            update();
        }},
    });
    const update = () => {
        input.value = settings.get(name);
    };

    return {
        node: element('div', {class: 'yomitan-field'}, element('label', {htmlFor: input.id}, text), input),
        update,
    };
}

function fontSizeField(settings) {
    const {min, max} = SETTING_BOUNDS.fontScale;
    const output = element('output', {});
    const input = element('input', {
        type: 'range',
        id: 'yomitan-setting-fontScale',
        min,
        max,
        step: 10,
        value: settings.get('fontScale'),
        on: {
            input: () => {
                output.textContent = `${input.value}%`;
            },
            change: () => settings.set('fontScale', Number(input.value)),
        },
    });
    const update = () => {
        input.value = settings.get('fontScale');
        output.textContent = `${settings.get('fontScale')}%`;
    };

    update();
    return {
        node: element('div', {class: 'yomitan-field yomitan-field-wide'}, element('label', {htmlFor: input.id}, 'Size of the lines'), input, output),
        update,
    };
}

/** The dictionaries, in this user's order, each with a switch. The first one on is the one whose entries come first. */
class DictionaryList {
    constructor(settings) {
        this._settings = settings;
        this._dictionaries = [];
        this._note = element('p', {class: 'yomitan-help'}, 'Loading');
        this._list = element('ul', {class: 'yomitan-dictionaries'});
        this.node = element('div', {}, this._note, this._list);
    }

    async load() {
        try {
            const response = await apiFetchOk(window.ApiClient, 'Yomitan/Dictionaries');
            ({dictionaries: this._dictionaries} = await response.json());
            this.update();
        } catch (error) {
            console.warn('[yomitan] cannot list the dictionaries:', error);
            this._note.textContent = 'The dictionaries could not be listed. Your choices are safe, and this will work once the server answers.';
        }
    }

    update = () => {
        const ordered = orderDictionaries(this._dictionaries, this._settings.get('dictionaryOrder'));
        const focused = this._list.contains(document.activeElement) ? document.activeElement.getAttribute('aria-label') : null;
        this._note.textContent = ordered.length === 0 ?
            'No dictionaries are installed yet, so words cannot be looked up. An administrator can add them in the dashboard, under Yomitan.' :
            'Dictionaries higher in the list show first. New ones an administrator adds are on, at the bottom.';
        this._list.replaceChildren(...ordered.map((dictionary, index) => this._row(dictionary, index, ordered)));
        // Moving a row rebuilds the list, and a remote must stay with that row, even if its button just went off.
        const same = [...this._list.querySelectorAll('[aria-label]')].find((node) => node.getAttribute('aria-label') === focused);
        (same?.disabled ? same.closest('li').querySelector('input') : same)?.focus();
    };

    _row({title, sizeBytes, summary}, index, ordered) {
        const disabled = this._settings.get('disabledDictionaries');
        const input = element('input', {
            type: 'checkbox',
            checked: !disabled.includes(title),
            'aria-label': `Use ${title}`,
            on: {change: () => this._setEnabled(title, input.checked, ordered)},
        });
        const move = (offset, symbol, label) => element('button', {
            type: 'button',
            textContent: symbol,
            disabled: !ordered[index + offset],
            'aria-label': `Move ${title} ${label}`,
            on: {click: () => this._move(ordered, index, offset)},
        });

        const counts = summary?.counts ?? {};
        const facts = [
            counts.terms?.total ? formatCount(counts.terms.total, 'word') : null,
            counts.kanji?.total ? formatCount(counts.kanji.total, 'kanji', 'kanji') : null,
            formatSize(sizeBytes),
        ].filter(Boolean);
        return element(
            'li',
            {class: 'yomitan-dictionary'},
            element(
                'label',
                {class: 'yomitan-check'},
                input,
                element(
                    'span',
                    {class: 'yomitan-dictionary-text'},
                    element('span', {class: 'yomitan-dictionary-title'}, title),
                    element('span', {class: 'yomitan-help', style: 'display: block'}, facts.join(', ')),
                ),
            ),
            move(-1, '↑', 'up'),
            move(1, '↓', 'down'),
        );
    }

    /** Only titles installed now go back, so a deleted dictionary leaves the saved settings with the next change. */
    _setEnabled(title, enabled, ordered) {
        const others = this._settings.get('disabledDictionaries').filter((other) => other !== title && ordered.some((d) => d.title === other));
        this._settings.set('disabledDictionaries', enabled ? others : [...others, title]);
    }

    _move(ordered, index, offset) {
        const titles = ordered.map(({title}) => title);
        [titles[index], titles[index + offset]] = [titles[index + offset], titles[index]];
        this._settings.set('dictionaryOrder', titles);
    }
}

/**
 * Opens the page. Opening it twice does nothing.
 * @param {import('../settings.js').Settings} settings
 */
export function openSettingsPage(settings) {
    if (document.querySelector('.yomitan-settings')) {
        return;
    }

    installStyle('yomitan-settings-style', CSS);
    settings.follow();
    settings.refresh({force: true});

    const status = element('p', {class: 'yomitan-status', role: 'status'});
    const showStatus = () => {
        status.dataset.state = settings.syncState;
        status.textContent = STATUS[settings.syncState];
    };

    const dictionaries = new DictionaryList(settings);
    const controls = {
        enabled: checkbox(settings, 'enabled', 'Use Yomitan on Japanese subtitles', 'Replaces the line with plain text you can look words up in. Styled subtitles lose their styling while this is on. The button next to the subtitle button in the player does the same.'),
        fontScale: fontSizeField(settings),
        upOnlyEntry: checkbox(
            settings,
            'upOnlyEntry',
            'Only Up starts walking the words',
            'With a keyboard or a remote, while paused. It leaves Left and Right to the player, to go back and forward. On unless you change it, apart from the TV layout.',
            () => entersWithUpOnly(settings),
        ),
        hoverDelayMs: numberField(settings, 'hoverDelayMs', 'How long the mouse rests on a word before it opens, in milliseconds'),
        hoverGraceMs: numberField(settings, 'hoverGraceMs', 'How long the popup stays after the mouse leaves it, in milliseconds'),
    };

    const onChange = ({detail: {name}}) => {
        controls[name]?.update();
        if (name === 'dictionaryOrder' || name === 'disabledDictionaries') {
            dictionaries.update();
        }
    };

    const closeButton = element('button', {type: 'button', textContent: 'Close', class: 'yomitan-settings-close'});
    const page = element(
        'div',
        {class: 'yomitan-settings focuscontainer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Yomitan settings'},
        element(
            'div',
            {class: 'yomitan-settings-inner'},
            element('header', {}, element('h1', {}, 'Yomitan'), closeButton),
            status,
            controls.enabled.node,
            element('h2', {}, 'Dictionaries'),
            dictionaries.node,
            element('h2', {}, 'Subtitles'),
            controls.fontScale.node,
            element('h2', {}, 'Keyboard and remote'),
            controls.upOnlyEntry.node,
            element('h2', {}, 'Mouse'),
            controls.hoverDelayMs.node,
            controls.hoverGraceMs.node,
        ),
    );

    const opener = document.activeElement;
    const close = () => {
        settings.removeEventListener('change', onChange);
        settings.removeEventListener('syncstate', showStatus);
        window.removeEventListener('popstate', close);
        page.remove();
        opener?.focus?.();
    };

    // A remote's OK arrives as Enter, which a browser does not take for a checkbox.
    page.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && event.target.type === 'checkbox') {
            event.preventDefault();
            event.target.click();
        } else if (event.key === 'Escape') {
            // jellyfin-web also takes this as Back on some layouts, and that would leave the page behind this one too.
            event.stopPropagation();
            history.back();
        }
    });

    // One step in the history, so the Back button of a phone or a remote closes this and stays on the page behind it.
    history.pushState(history.state, '');
    window.addEventListener('popstate', close);
    closeButton.addEventListener('click', () => history.back());
    settings.addEventListener('change', onChange);
    settings.addEventListener('syncstate', showStatus);
    showStatus();
    document.body.append(page);
    controls.enabled.node.querySelector('input').focus();
    dictionaries.load();
}
