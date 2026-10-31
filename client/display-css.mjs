// Makes Yomitan's display stylesheets work in a shadow root, without touching them. Three things change, by rule:
// `:root` becomes `:host`, the settings page's rules in material.css go, and URLs go, since they point into an extension.
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {transform} from 'esbuild';

const notice = `/* Yomitan's display styles. Copyright (C) 2023-2026 Yomitan Authors, Copyright (C) 2016-2022 Yomichan Authors.
GNU General Public License version 3 or later. See https://github.com/yomidevs/yomitan. */
`;

/** The only images the popup shows. Everything else with a URL is for buttons it does not have. */
const INLINED_IMAGES = ['/images/external-link.svg', '/images/material-right-arrow.svg'];

/** Splits a stylesheet into its top-level rules, which is all the parsing this needs. */
function splitRules(css) {
    const rules = [];
    let depth = 0;
    let start = 0;
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    for (let index = 0; index < text.length; ++index) {
        if (text[index] === '{') {
            depth += 1;
        } else if (text[index] === '}') {
            depth -= 1;
            if (depth === 0) {
                rules.push(text.slice(start, index + 1).trim());
                start = index + 1;
            }
        }
    }

    return rules;
}

/** `:root[a]:not([b]) x` becomes `:host([a]:not([b])) x`. */
function rootToHost(css) {
    return css.replace(/:root((?:\[[^\]]*\]|:not\([^)]*\))*)/g, (_, conditions) => (conditions ? `:host(${conditions})` : ':host'));
}

async function inlineImages(rule, root) {
    let result = rule;
    for (const path of INLINED_IMAGES) {
        if (result.includes(path)) {
            const svg = await readFile(join(root, path), 'utf8');
            const data = `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, ' ').trim())}`;
            result = result.replaceAll(new RegExp(`url\\(['"]?${path}['"]?\\)`, 'g'), `url("${data}")`);
        }
    }

    return result;
}

/**
 * @param {string} root The extension's directory.
 * @returns {Promise<string>} One minified stylesheet.
 */
export async function displayCss(root) {
    const read = (name) => readFile(join(root, 'css', name), 'utf8').then(splitRules);
    const material = (await read('material.css')).filter((rule) => /^(:root|\.icon)/.test(rule));
    const rules = [
        ...material,
        ...await read('display.css'),
        ...await read('display-pronunciation.css'),
        ...await read('structured-content.css'),
    ];

    const kept = [];
    for (const rule of rules) {
        const inlined = await inlineImages(rule, root);
        if (!/^@font-face/.test(inlined) && !/url\((?!"data:)/.test(inlined)) {
            kept.push(rootToHost(inlined));
        }
    }

    const {code} = await transform(kept.join('\n'), {loader: 'css', minify: true, legalComments: 'none'});
    return notice + code;
}
