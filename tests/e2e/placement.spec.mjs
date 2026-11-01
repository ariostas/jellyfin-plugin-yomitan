// Where the popup goes is plain arithmetic, so this tries far more shapes than a browser could.
import {expect, test} from '@playwright/test';
import {placePopup, popupWidth} from '../../client/src/popup/placement.js';

function* cases() {
    for (const width of [240, 320, 360, 412, 640, 839, 1024, 1280, 1920, 3840]) {
        for (const height of [240, 320, 360, 412, 640, 839, 1024, 1080, 2160]) {
            for (let left = 0; left < width; left += Math.ceil(width / 7)) {
                for (let top = 0; top < height - 24; top += Math.ceil(height / 9)) {
                    for (const wordWidth of [12, 80, 400]) {
                        for (const contentHeight of [40, 200, 700, 4000]) {
                            for (const avoidBottom of [0, 120]) {
                                // The usual size, and the TV layout's.
                                for (const fontSize of [15, 26]) {
                                    yield {
                                        viewport: {width, height},
                                        anchor: {left, right: Math.min(left + wordWidth, width), top, bottom: top + 24},
                                        contentHeight,
                                        avoidBottom,
                                        fontSize,
                                    };
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

test('on every shape of screen it stays on it, and never covers the word', () => {
    let count = 0;
    const wrong = [];
    for (const situation of cases()) {
        const {viewport, anchor, contentHeight, fontSize} = situation;
        const {left, top, maxHeight} = placePopup(situation);
        const height = Math.min(contentHeight, maxHeight);
        const onScreen = left >= 0 && left + popupWidth(viewport.width, fontSize) <= viewport.width && top >= 0 && top + height <= viewport.height;
        const clearOfWord = top + height <= anchor.top || top >= anchor.bottom;
        count += 1;
        if (!onScreen || !clearOfWord) {
            wrong.push(situation);
        }
    }

    console.log(`${count} situations`);
    expect(wrong.slice(0, 5)).toEqual([]);
    expect(count).toBeGreaterThan(100_000);
});

test('it goes above the word if the entry fits or there is more room there', () => {
    const viewport = {width: 1280, height: 720};
    const low = {left: 600, right: 650, top: 600, bottom: 640};
    expect(placePopup({viewport, anchor: low, contentHeight: 300}).side).toBe('above');
    expect(placePopup({viewport, anchor: low, contentHeight: 3000}).side).toBe('above');
});

test('it goes below a word near the top', () => {
    const viewport = {width: 1280, height: 720};
    const high = {left: 600, right: 650, top: 40, bottom: 80};
    expect(placePopup({viewport, anchor: high, contentHeight: 300}).side).toBe('below');
});

test('below a word, it keeps out of the OSD if the entry is short enough', () => {
    const viewport = {width: 1280, height: 720};
    const high = {left: 600, right: 650, top: 40, bottom: 80};
    const clear = placePopup({viewport, anchor: high, contentHeight: 300, avoidBottom: 130});
    expect(clear.top + Math.min(300, clear.maxHeight)).toBeLessThanOrEqual(720 - 130);
    expect(placePopup({viewport, anchor: high, contentHeight: 3000, avoidBottom: 130}).maxHeight).toBeGreaterThan(500);
});

test('it follows the word sideways, and stops at the edges', () => {
    const viewport = {width: 1280, height: 720};
    const at = (left) => placePopup({viewport, anchor: {left, right: left + 40, top: 600, bottom: 640}, contentHeight: 100}).left;
    expect(at(620)).toBe(640 - popupWidth(1280) / 2);
    expect(at(0)).toBe(8);
    expect(at(1240)).toBe(1280 - 8 - popupWidth(1280));
});
