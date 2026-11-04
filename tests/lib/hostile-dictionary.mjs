// A dictionary written by someone who means harm, and one with images. `canary` is the base URL of a server the test
// runs, so anything that reaches out can be counted.
import {makeZip} from './zip.mjs';

/** 3 by 2, as in the examples in docs/api.md. */
export const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGP8z8Dwn4GBgYEBAA8GAgGRwn0FAAAAAElFTkSuQmCC',
    'base64',
);

const script = (name) => `<img src=x onerror="window.pwned='${name}'"><script>window.pwned='${name}'</script>`;

/**
 * Each attack has an element of its own, which it certainly matches inside the dictionary's scope, so a rule that does
 * nothing here cannot look like a rule that was stopped. The control test in hostile.spec.mjs applies them all raw.
 */
const STYLE_ATTACKS = (canary) => ({
    background: `background-image: url("${canary}/css-background.png");`,
    cursor: `cursor: url("${canary}/css-cursor.png"), auto;`,
    'list-image': `display: list-item; list-style-image: url("${canary}/css-list.png");`,
    border: `border: 8px solid; border-image: url("${canary}/css-border.png") 30;`,
    mask: `mask-image: url("${canary}/css-mask.png");`,
    filter: `filter: url("${canary}/css-filter.svg#a");`,
    'image-set': `background-image: image-set("${canary}/css-image-set.png" 1x);`,
    'webkit-image-set': `background-image: -webkit-image-set(url("${canary}/css-webkit-image-set.png") 1x);`,
    escaped: `background-image: u\\72l("${canary}/css-escaped.png");`,
    custom: `--evil: url("${canary}/css-custom.png"); background-image: var(--evil);`,
    'custom-escaped': `--evil: u\\72l("${canary}/css-custom-escaped.png"); background-image: var(--evil);`,
    fallback: `background-image: var(--nothing, url("${canary}/css-fallback.png"));`,
    shorthand: `background: var(--nothing, url("${canary}/css-shorthand.png")) no-repeat;`,
    'escaped-fallback': `background-image: var(--nothing, u\\72l("${canary}/css-escaped-fallback.png"));`,
});

/**
 * Attacks that do fetch, once applied. The rest depend on the engine, so they only have to be silent. @font-face is one of
 * those: browsers ignore it in a shadow root, which is the only thing keeping it out if this file's rule ever went.
 */
export const LIVE_ATTACKS = [
    'css-background.png', 'css-image-set.png', 'css-escaped.png', 'css-custom.png', 'css-custom-escaped.png',
    'css-fallback.png', 'css-shorthand.png', 'css-escaped-fallback.png', 'css-media.png', 'css-supports.png',
    'css-import-url.css', 'css-import-string.css', 'css-before.png',
];

export function hostileStyles(canary) {
    const attacks = Object.entries(STYLE_ATTACKS(canary)).map(([name, declarations]) => `[data-sc-probe="${name}"] { ${declarations} }`);
    return `
@import url("${canary}/css-import-url.css");
@import "${canary}/css-import-string.css";
@font-face { font-family: evil; src: url("${canary}/css-font.woff2"); }
[data-sc-probe="font"] { font-family: evil; }
.gloss-content { color: rgb(1, 2, 3); }
${attacks.join('\n')}
[data-sc-probe="before"]::before { content: url("${canary}/css-before.png"); }
@media screen { [data-sc-probe="media"] { background-image: url("${canary}/css-media.png"); } .gloss-content { outline: 1px solid rgb(4, 5, 6); } }
@supports (display: grid) { [data-sc-probe="supports"] { background-image: url("${canary}/css-supports.png"); } }
[data-sc-cover] { position: fixed; inset: 0; z-index: 99999; background: rgb(255, 0, 0); }
:host { display: none !important; }
:root { background: url("${canary}/css-root.png"); }
html, body { display: none; background: url("${canary}/css-body.png"); }
} * { background: url("${canary}/css-break-out.png"); } .x {
</style><script>window.pwned = 'styles'</script><style>
`;
}

/**
 * Rules that load nothing, and reach outside the dictionary's own entries through CSS nesting: to the popup's frame,
 * and to the entries of the dictionaries beside it. They are kept apart from the rest so the control test in
 * hostile.spec.mjs can apply those raw without the popup disappearing under it.
 */
export const SCOPE_ESCAPES = `
.popup-frame:has(&) { position: fixed !important; inset: 0 !important; contain: none !important; outline: 5px solid rgb(255, 0, 0) !important; }
& ~ *, :has(~ &) { display: none !important; }
.gloss-content { .popup-frame:has(&) { visibility: hidden !important; } :is(&) ~ * { display: none !important; } }
`;

const STYLE_PROBES = (canary) => [
    ...Object.keys(STYLE_ATTACKS(canary)),
    'font', 'before', 'media', 'supports',
];

const INLINE_ATTACKS = (canary) => ({
    background: `url("${canary}/inline-background.png")`,
    backgroundColor: `url("${canary}/inline-background-color.png")`,
    cursor: `url("${canary}/inline-cursor.png"), auto`,
    clipPath: `url("${canary}/inline-clip.svg#a")`,
    listStyleType: `url("${canary}/inline-list.png")`,
    textShadow: `url("${canary}/inline-shadow.png")`,
    textEmphasis: `url("${canary}/inline-emphasis.png")`,
    color: `rgb(7, 8, 9); background: url("${canary}/inline-smuggled.png")`,
    borderColor: `url("${canary}/inline-border.png")`,
    fontSize: `calc(1px + url("${canary}/inline-size.png"))`,
});

function hostileGlossary(canary) {
    return [
        script('glossary string'),
        {
            type: 'structured-content',
            content: [
                script('structured string'),
                ...STYLE_PROBES(canary).map((probe) => ({tag: 'div', data: {probe}, content: `probe ${probe}`})),
                ...Object.entries(INLINE_ATTACKS(canary)).map(([property, value]) => ({
                    tag: 'div',
                    style: {[property]: value},
                    content: `inline ${property}`,
                })),
                {
                    tag: 'div',
                    style: {backgroundColor: 'rgb(9, 8, 7)'},
                    data: {cover: 'yes', onclick: "window.pwned='dataset'", 'x"><script>': 'y'},
                    title: '"><img src=x onerror="window.pwned=\'title\'">',
                    lang: '"><script>window.pwned=1</script>',
                    content: 'styled',
                },
            ],
        },
    ];
}

/** What a link points at that no dictionary has. */
export const DEAD_LINK = '<img src=x onerror="window.pwned=\'dead link\'">';

/** Things to click, on an entry of their own, since the one above has an element trying to cover the popup. */
function hostileLinks(canary) {
    return [{
        type: 'structured-content',
        content: [
            {tag: 'a', href: `${canary}/link-followed`, content: 'an outside link'},
            {tag: 'div', content: [{tag: 'a', href: '?query=猫', content: 'a link to 猫'}]},
            // Nothing has this, and the popup says so with the link's text, which has to stay text.
            {tag: 'div', content: [{tag: 'a', href: `?query=${encodeURIComponent(DEAD_LINK)}`, content: 'a link to nothing'}]},
            {
                tag: 'img',
                path: 'evil.svg',
                width: 40,
                height: 40,
                sizeUnits: 'px',
                title: '<script>window.pwned=1</script>',
                border: `1px solid url("${canary}/image-border.png")`,
                borderRadius: `url("${canary}/image-radius.png")`,
            },
        ],
    }];
}

/** @returns {string} The dictionary's title, which is hostile too: it ends up in a CSS selector and a media URL. */
export const hostileTitle = 'Evil"] { background: url(x) } [x="';

/** @param {string} canary */
export function makeHostileDictionary(canary) {
    const entry = (name, value) => ({name, data: Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))});
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="window.parent.pwned='svg'">
        <script>window.parent.pwned = 'svg';</script><image href="${canary}/svg-image.png" width="10" height="10"/>
        <rect width="10" height="10" fill="green"/></svg>`;
    return makeZip([
        entry('index.json', {
            title: hostileTitle,
            format: 3,
            revision: script('revision'),
            sequenced: false,
            author: script('author'),
            description: script('description'),
            attribution: script('attribution'),
            url: 'https://example.invalid/',
        }),
        entry('term_bank_1.json', [
            ['罠', script('reading'), 'evil', '', 100, hostileGlossary(canary), 1, ''],
            ['字幕', 'じまく', '', '', 0, hostileLinks(canary), 2, ''],
            ['絵', 'え', '', '', 0, [{type: 'image', path: 'pic.png', width: 3, height: 2}, 'a picture'], 3, ''],
        ]),
        entry('term_meta_bank_1.json', [
            ['罠', 'freq', {value: 5, displayValue: script('frequency')}],
            ['罠', 'pitch', {reading: script('pitch'), pitches: [{position: 0}]}],
        ]),
        entry('tag_bank_1.json', [['evil', 'name', 0, script('tag notes'), 0]]),
        entry('styles.css', hostileStyles(canary) + SCOPE_ESCAPES),
        {name: 'evil.svg', data: Buffer.from(svg)},
        {name: 'pic.png', data: PNG},
    ]);
}

/** Rows the importer would refuse, for checking the client on its own. Yomitan's schema only allows http(s) and ? links. */
export const rowsPastTheSchema = [
    {type: 'structured-content', content: {tag: 'a', href: "javascript:window.pwned='link'", content: 'script link'}},
    {type: 'structured-content', content: {tag: 'a', href: "data:text/html,<script>window.pwned='data'</script>", content: 'data link'}},
    {type: 'structured-content', content: {tag: 'a', href: "vbscript:window.pwned='vb'", content: 'vbscript link'}},
    {type: 'structured-content', content: {tag: 'a', href: "blob:http://127.0.0.1/x", content: 'blob link'}},
    {type: 'structured-content', content: {tag: 'a', href: "//example.invalid/x", content: 'relative link'}},
    {type: 'structured-content', content: {tag: 'script', content: "window.pwned='script tag'"}},
    {type: 'structured-content', content: {tag: 'style', content: '* { display: none }'}},
    {type: 'structured-content', content: {tag: 'iframe', src: "javascript:window.pwned='iframe'"}},
    {type: 'structured-content', content: {tag: 'div', onclick: "window.pwned='attribute'", content: 'click me'}},
];
