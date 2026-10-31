// A dictionary written by someone who means harm, and one with images. `canary` is the base URL of a server the test
// runs, so anything that reaches out can be counted.
import {makeZip} from './zip.mjs';

/** 3 by 2, as in the examples in docs/api.md. */
export const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAMAAAACCAYAAACddGYaAAAAEklEQVR4nGP8z8Dwn4GBgYEBAA8GAgGRwn0FAAAAAElFTkSuQmCC',
    'base64',
);

const script = (name) => `<img src=x onerror="window.pwned='${name}'"><script>window.pwned='${name}'</script>`;

export function hostileStyles(canary) {
    return `
@import url("${canary}/css-import-url.css");
@import "${canary}/css-import-string.css";
@font-face { font-family: evil; src: url("${canary}/css-font.woff2"); }
.gloss-content { font-family: evil; background-image: url("${canary}/css-background.png"); color: rgb(1, 2, 3); }
.definition-item {
    cursor: url("${canary}/css-cursor.png"), auto;
    list-style-image: url("${canary}/css-list.png");
    border-image: url("${canary}/css-border.png") 30;
    mask-image: url("${canary}/css-mask.png");
    filter: url("${canary}/css-filter.svg#a");
}
.gloss-content::before { content: url("${canary}/css-content.png"); }
.headword { background: image-set("${canary}/css-image-set.png" 1x); }
.headword-term { background: -webkit-image-set(url("${canary}/css-webkit-image-set.png") 1x); }
.tag { background: u\\72l("${canary}/css-escaped.png"); }
.entry { --evil: u\\72l("${canary}/css-custom-escaped.png"); background: var(--evil); }
.entry-body { --evil-plain: url("${canary}/css-custom.png"); background-image: var(--evil-plain); }
.definition-list { background: var(--nothing, url("${canary}/css-fallback.png")); }
@media screen { .gloss-content { background-image: url("${canary}/css-media.png"); outline: 1px solid rgb(4, 5, 6); } }
@supports (display: grid) { .headword-list { background-image: url("${canary}/css-supports.png"); } }
[data-sc-cover] { position: fixed; inset: 0; z-index: 99999; background: rgb(255, 0, 0); }
:host { display: none !important; }
:root { background: url("${canary}/css-root.png"); }
html, body { display: none; background: url("${canary}/css-body.png"); }
} * { background: url("${canary}/css-break-out.png"); } .x {
</style><script>window.pwned = 'styles'</script><style>
`;
}

function hostileGlossary(canary) {
    return [
        script('glossary string'),
        {
            type: 'structured-content',
            content: [
                script('structured string'),
                {
                    tag: 'div',
                    style: {
                        background: `url("${canary}/inline-background.png")`,
                        cursor: `url("${canary}/inline-cursor.png"), auto`,
                        clipPath: `url("${canary}/inline-clip.svg#a")`,
                        listStyleType: `url("${canary}/inline-list.png")`,
                        textShadow: `url("${canary}/inline-shadow.png")`,
                        color: `rgb(7, 8, 9); background: url("${canary}/inline-smuggled.png")`,
                        backgroundColor: 'rgb(9, 8, 7)',
                    },
                    data: {cover: 'yes', onclick: "window.pwned='dataset'", 'x"><script>': 'y'},
                    title: '"><img src=x onerror="window.pwned=\'title\'">',
                    lang: '"><script>window.pwned=1</script>',
                    content: 'styled',
                },
            ],
        },
    ];
}

/** Things to click, on an entry of their own, since the one above has an element trying to cover the popup. */
function hostileLinks(canary) {
    return [{
        type: 'structured-content',
        content: [
            {tag: 'a', href: `${canary}/link-followed`, content: 'an outside link'},
            {tag: 'div', content: [{tag: 'a', href: '?query=猫', content: 'a link to 猫'}]},
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
        entry('styles.css', hostileStyles(canary)),
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
