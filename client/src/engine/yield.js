// The Translator's awaits only yield to microtasks, so without this a whole line runs as one task on the main thread,
// and a phone would drop frames on every cue. The engine works in slices instead.

/** A frame at 60 Hz, leaving time for the frame's own work. */
const SLICE_MS = 8;

let sliceStart = 0;

/** Gives the page a turn if the current slice of work has run long. */
export async function yieldIfBusy() {
    if (performance.now() - sliceStart >= SLICE_MS) {
        await new Promise((resolve) => {
            setTimeout(resolve);
        });
        sliceStart = performance.now();
    }
}
