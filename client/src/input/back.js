// Back, on every device jellyfin-web knows. Backspace and BrowserBack are not Back to jellyfin-web, but a person pressing
// them over something of the plugin's means it, and the browser would act on the second. A remote's Back is 461 on webOS
// and 10009 on Tizen, and the rest are keyboards, Xbox and gamepads, from jellyfin-web's keyboardNavigation.js.
const CODES = new Set([8, 27, 166, 196, 461, 10009]);

/** The same key on devices that give it a name and no usable code. */
const NAMES = new Set(['GoBack', 'BrowserBack']);

/** @param {KeyboardEvent} event @returns {boolean} */
export function isBack({keyCode, key, code}) {
    return CODES.has(keyCode) || NAMES.has(key) || NAMES.has(code);
}
