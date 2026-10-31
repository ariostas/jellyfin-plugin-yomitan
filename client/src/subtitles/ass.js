// Parses ASS and SSA scripts. Jellyfin's Stream.js flattens these to timed text and loses the layer, style and effect,
// which is what tells dialogue from signs, so the plugin reads the script itself.

/** @returns {number} Seconds, from `H:MM:SS.cc`. NaN if malformed. */
function parseTime(text) {
    const match = /^(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(text.trim());
    return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : Number.NaN;
}

/**
 * @param {string} script
 * @returns {{start: number, end: number, layer: number, style: string, name: string, effect: string, text: string}[]}
 *   The Dialogue lines in file order. Comment lines are dropped: they are never drawn.
 */
export function parseAss(script) {
    const events = [];
    let section = '';
    let format = null;

    for (const rawLine of script.replace(/^﻿/, '').split(/\r?\n/)) {
        const line = rawLine.trim();
        if (line.startsWith('[')) {
            section = line.toLowerCase();
            format = null;
            continue;
        }

        if (section !== '[events]') {
            continue;
        }

        const colon = line.indexOf(':');
        if (colon < 0) {
            continue;
        }

        const kind = line.slice(0, colon).toLowerCase();
        const rest = line.slice(colon + 1).trimStart();
        if (kind === 'format') {
            format = rest.split(',').map((name) => name.trim().toLowerCase());
        } else if (kind === 'dialogue' && format) {
            events.push(parseEvent(rest, format));
        }
    }

    return events.filter(({start, end}) => Number.isFinite(start) && Number.isFinite(end));
}

function parseEvent(line, format) {
    // Text is always the last field and is the only one that can hold commas.
    const fields = {};
    let position = 0;
    format.forEach((name, index) => {
        if (index === format.length - 1) {
            fields[name] = line.slice(position);
            return;
        }

        const comma = line.indexOf(',', position);
        const end = comma < 0 ? line.length : comma;
        fields[name] = line.slice(position, end);
        position = end + 1;
    });

    return {
        start: parseTime(fields.start ?? ''),
        end: parseTime(fields.end ?? ''),
        layer: Number.parseInt(fields.layer ?? '0', 10) || 0,
        style: (fields.style ?? '').trim().replace(/^\*/, ''),
        name: (fields.name ?? fields.actor ?? '').trim(),
        effect: (fields.effect ?? '').trim(),
        text: fields.text ?? '',
    };
}
