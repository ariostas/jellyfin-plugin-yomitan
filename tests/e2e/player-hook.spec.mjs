// How the client finds playbackManager, against a stand-in for jellyfin-web's Events. player-toggle.spec.mjs checks the
// same in the real page.
import {expect, test} from '@playwright/test';
import {findPlaybackManager} from '../../client/src/player-hook.js';

const playbackManager = {getCurrentPlayer() {}, getSubtitleStreamIndex() {}, subtitleTracks() {}};

function fakeEvents() {
    const calls = [];
    return {
        calls,
        trigger(target, name) {
            calls.push(name);
            return name;
        },
    };
}

test.beforeEach(() => {
    globalThis.window = globalThis;
});

test.afterEach(() => {
    delete globalThis.Events;
    delete globalThis.window;
});

test('it finds playbackManager once, and puts Events.trigger back as it was', () => {
    const events = fakeEvents();
    const original = events.trigger;
    globalThis.Events = events;
    const found = [];
    findPlaybackManager((manager) => found.push(manager));

    expect(Events.trigger({}, 'other')).toBe('other');
    expect(found).toEqual([]);
    expect(Events.trigger(playbackManager, 'playbackstart')).toBe('playbackstart');
    expect(Events.trigger(playbackManager, 'timeupdate')).toBe('timeupdate');
    expect(found).toEqual([playbackManager]);
    expect(Events.trigger).toBe(original);
    expect(events.calls).toEqual(['other', 'playbackstart', 'timeupdate']);
});

test('with another wrapper on top of it, it still finds playbackManager once, and keeps passing every call on', () => {
    const events = fakeEvents();
    globalThis.Events = events;
    const found = [];
    findPlaybackManager((manager) => found.push(manager));
    const ours = Events.trigger;
    const theirs = function (...args) {
        return ours.apply(this, args);
    };
    Events.trigger = theirs;

    for (const name of ['playbackstart', 'timeupdate', 'pause', 'playbackstop']) {
        expect(Events.trigger(playbackManager, name)).toBe(name);
    }

    expect(found).toEqual([playbackManager]);
    expect(Events.trigger).toBe(theirs);
    expect(events.calls).toEqual(['playbackstart', 'timeupdate', 'pause', 'playbackstop']);
});
