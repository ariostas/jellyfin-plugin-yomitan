// Answers "what is on screen at this time" without scanning. Overlapping cues split the time axis into intervals,
// and each interval knows its cues, so a lookup is a binary search.

/**
 * @typedef {object} Cue
 * @property {number} id Index in the track's cue list.
 * @property {number} start Seconds.
 * @property {number} end Seconds, exclusive.
 * @property {string} text Clean text. Lines are separated by `\n`.
 * @property {'dialogue'|'sign'} kind
 */

const NOTHING = Object.freeze({key: '', cues: Object.freeze([]), start: 0, end: Number.POSITIVE_INFINITY});

export class CueTimeline {
    /** @param {Cue[]} cues Sorted by start. */
    constructor(cues) {
        this.cues = cues;
        this._intervals = buildIntervals(cues);
    }

    /**
     * @param {number} time Seconds.
     * @returns {{key: string, cues: readonly Cue[], start: number, end: number}} What shows at `time`. `key` changes
     *   exactly when the set of cues does.
     */
    at(time) {
        const intervals = this._intervals;
        let low = 0;
        let high = intervals.length - 1;
        while (low <= high) {
            const middle = (low + high) >> 1;
            const interval = intervals[middle];
            if (time < interval.start) {
                high = middle - 1;
            } else if (time >= interval.end) {
                low = middle + 1;
            } else {
                return interval;
            }
        }

        return NOTHING;
    }

    /**
     * @param {number} time Seconds.
     * @param {number} count
     * @returns {Cue[]} The next cues to start after `time`.
     */
    upcoming(time, count) {
        const first = this.cues.findIndex(({start}) => start > time);
        return first < 0 ? [] : this.cues.slice(first, first + count);
    }
}

function groupBy(items, keyOf) {
    const groups = new Map();
    for (const item of items) {
        const key = keyOf(item);
        const group = groups.get(key);
        if (group) {
            group.push(item);
        } else {
            groups.set(key, [item]);
        }
    }

    return groups;
}

function buildIntervals(cues) {
    const times = [...new Set(cues.flatMap(({start, end}) => [start, end]))].sort((a, b) => a - b);
    const starting = groupBy(cues, ({start}) => start);
    const ending = groupBy(cues, ({end}) => end);
    const active = new Map();
    const intervals = [];

    times.forEach((start, index) => {
        for (const cue of ending.get(start) ?? []) {
            active.delete(cue.id);
        }

        for (const cue of starting.get(start) ?? []) {
            active.set(cue.id, cue);
        }

        if (active.size && index + 1 < times.length) {
            const shown = [...active.values()];
            intervals.push({key: shown.map(({id}) => id).join(','), cues: shown, start, end: times[index + 1]});
        }
    });

    return intervals;
}
