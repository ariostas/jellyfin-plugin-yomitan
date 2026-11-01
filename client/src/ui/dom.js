// Builds elements without ever parsing a string as markup. Titles, authors and descriptions come out of a zip anyone can
// write, so the pages use this and textContent, and no innerHTML.

/**
 * @param {string} tag
 * @param {Record<string, any>} [properties] Set on the element. `class` is the class name, and anything with a dash an
 *   attribute. `on` maps event types to listeners.
 * @param {...(Node|string|null|undefined|false)} children Strings become text nodes.
 * @returns {HTMLElement}
 */
export function element(tag, {on, class: className, ...properties} = {}, ...children) {
    const node = document.createElement(tag);
    if (className) {
        node.className = className;
    }

    for (const [name, value] of Object.entries(properties)) {
        if (name.includes('-')) {
            node.setAttribute(name, value);
        } else {
            node[name] = value;
        }
    }

    for (const [type, listener] of Object.entries(on ?? {})) {
        node.addEventListener(type, listener);
    }

    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}

/** @param {string} id Keeps the style to one copy. @param {string} css */
export function installStyle(id, css) {
    if (!document.getElementById(id)) {
        document.head.append(element('style', {id, textContent: css}));
    }
}

/**
 * @param {number} bytes
 * @returns {string} In the units people read sizes in.
 */
export function formatBytes(bytes) {
    const units = ['bytes', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1000 && unit < units.length - 1) {
        value /= 1000;
        unit += 1;
    }

    return `${unit === 0 ? value : value.toFixed(value < 10 ? 2 : 1)} ${units[unit]}`;
}

/**
 * @param {number} bytes A dictionary's `sizeBytes`, which counts whole 4 KB pages, so a tiny one is 0.
 * @returns {string}
 */
export function formatSize(bytes) {
    return bytes === 0 ? 'under 4 KB' : formatBytes(bytes);
}

/**
 * @param {number} count
 * @param {string} one
 * @param {string} [many]
 * @returns {string}
 */
export function formatCount(count, one, many = `${one}s`) {
    return `${count.toLocaleString()} ${count === 1 ? one : many}`;
}
