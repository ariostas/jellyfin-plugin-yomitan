// Dictionaries are untrusted: any zip an admin uploads, often from a stranger. Yomitan's generators build a dictionary's
// content as text nodes and an allowlist of tags, which rules out markup, but they copy `style` values and the `href` of
// links as they are, and Yomitan relies on a content security policy for the rest. This page has none to rely on, so the
// plugin closes those gaps itself. Nothing here runs a dictionary's content, and nothing leaves until it has been through
// this file.
//
// The rule for CSS: a value may only call functions that cannot reach the network. This is a list of what is allowed,
// because the ways to load something keep growing: url(), image-set() with a plain string, src(), cross-fade(), image().

const SAFE_FUNCTIONS = new Set([
    '', 'var', 'calc', 'min', 'max', 'clamp', 'abs', 'sign', 'round', 'mod', 'rem',
    'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix', 'light-dark',
    'linear-gradient', 'radial-gradient', 'conic-gradient',
    'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
    'translate', 'translatex', 'translatey', 'translate3d', 'scale', 'scalex', 'scaley', 'rotate', 'skew', 'skewx', 'skewy',
    'matrix', 'blur', 'brightness', 'contrast', 'drop-shadow', 'grayscale', 'hue-rotate', 'invert', 'opacity', 'saturate',
    'sepia', 'counter', 'counters', 'cubic-bezier', 'steps', 'inset', 'circle', 'ellipse', 'polygon', 'rect', 'minmax',
    'repeat', 'fit-content', 'symbols',
]);

/** Markup and URLs the generators have no reason to produce, in case one of them starts to. */
const FORBIDDEN_ELEMENTS = 'script,style,link,meta,base,iframe,frame,object,embed,applet,form,input,textarea,select,audio,video,source,track,foreignObject';
const URL_ATTRIBUTES = new Set(['src', 'srcset', 'srcdoc', 'href', 'xlink:href', 'action', 'formaction', 'poster', 'background', 'ping', 'data']);

/**
 * @param {string} value A CSS value, or a whole block of declarations.
 * @param {string} [property] The property it belongs to.
 * @returns {boolean} Whether it is sure not to load anything.
 */
export function isSafeCssValue(value, property) {
    // The browser has already resolved escapes in anything it parsed. It keeps them in custom properties and in values
    // holding a var(), where u\72l( would otherwise get past this check and become url( later.
    if (value.includes('\\')) {
        return false;
    }

    for (const [, name] of value.matchAll(/([-\w]*)\(/g)) {
        const lower = name.toLowerCase();
        if (!SAFE_FUNCTIONS.has(lower) && !(lower === 'attr' && property === 'content')) {
            return false;
        }
    }

    return true;
}

/**
 * Removes every declaration that could load something. The check on the whole text at the end is for what the browser
 * will not list as a property, which is how a shorthand holding a var() looks.
 * @param {CSSStyleDeclaration} style
 */
function cleanDeclarations(style) {
    for (let index = style.length - 1; index >= 0; --index) {
        const name = style[index];
        if (!isSafeCssValue(style.getPropertyValue(name), name)) {
            style.removeProperty(name);
        }
    }

    if (!isSafeCssValue(style.cssText, 'content')) {
        style.cssText = '';
    }
}

/**
 * @param {string} href A link from a dictionary.
 * @returns {string|null} The link, if it goes to a web page and so can only do anything if someone follows it.
 */
export function safeLink(href) {
    try {
        const {protocol} = new URL(href);
        return protocol === 'http:' || protocol === 'https:' ? href : null;
    } catch {
        return null;
    }
}

function cleanElement(element) {
    for (const {name, value} of [...element.attributes]) {
        const lower = name.toLowerCase();
        if (lower.startsWith('on') || (URL_ATTRIBUTES.has(lower) && !(element.localName === 'a' && lower === 'href' && safeLink(value)))) {
            element.removeAttribute(name);
        }
    }

    if (element.hasAttribute('style')) {
        cleanDeclarations(element.style);
    }
}

/**
 * Makes one rendered entry safe to attach. Call it before the entry reaches the document: images load through the
 * content manager only after this, so `src` and `href` are empty here, and only those have a reason to be filled later.
 * @param {Element} root
 */
export function sanitizeEntry(root) {
    for (const element of root.querySelectorAll(FORBIDDEN_ELEMENTS)) {
        element.remove();
    }

    cleanElement(root);
    for (const element of root.querySelectorAll('*')) {
        cleanElement(element);
    }
}

/**
 * Keeps style rules and the groups around them, and drops every other kind of rule, since @import, @font-face and the
 * rest either load things or have no use here. `@import` never gets this far: a constructed stylesheet ignores it.
 * @param {CSSStyleSheet|CSSGroupingRule} parent
 */
function cleanRules(parent) {
    const rules = parent.cssRules;
    for (let index = rules.length - 1; index >= 0; --index) {
        const rule = rules[index];
        const isGroup = rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule;
        const isDeclarations = rule instanceof CSSStyleRule
            || (typeof CSSNestedDeclarations === 'function' && rule instanceof CSSNestedDeclarations);
        if (!isGroup && !isDeclarations) {
            parent.deleteRule(index);
            continue;
        }

        if (isDeclarations) {
            cleanDeclarations(rule.style);
        }

        if (rule.cssRules) {
            cleanRules(rule);
        }
    }
}

/**
 * Parses a dictionary's styles.css, keeps what is safe, and scopes it to that dictionary's entries. Going through the
 * browser's own parser means there is nothing to get out of step with: comments, escapes and broken rules have all been
 * dealt with, and what comes back out cannot close the scope early.
 * @param {string} css
 * @param {string} title The dictionary.
 * @returns {string} CSS for the popup's shadow root. Empty if nothing is left.
 */
export function sanitizeDictionaryCss(css, title) {
    if (!css) {
        return '';
    }

    const sheet = new CSSStyleSheet();
    try {
        sheet.replaceSync(css);
        cleanRules(sheet);
    } catch (error) {
        console.debug(`[yomitan] dropping the styles of ${title}:`, error);
        return '';
    }

    const rules = [...sheet.cssRules].map(({cssText}) => cssText).join('\n');
    return rules ? `[data-dictionary="${CSS.escape(title)}"] {\n${rules}\n}` : '';
}
