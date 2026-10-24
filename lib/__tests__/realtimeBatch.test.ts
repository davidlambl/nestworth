// lib/realtimeBatch.ts (#21): the two halves of what realtime does about a
// burst, driven with fake timers. A new module, so nothing here loads on
// 112b060: the red proofs are mutants of the production code (the pull
// request's mutant table).
import {
  createInvalidationBatcher,
  createSplitRefresher,
  REALTIME_WINDOW_MS,
} from '../realtimeBatch';

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('createInvalidationBatcher (#21)', () => {
  let calls: string[];
  const batcher = () =>
    createInvalidationBatcher((key) => {
      calls.push(JSON.stringify(key));
    });

  beforeEach(() => {
    calls = [];
  });

  it('B1: invalidates the first event of a quiet spell at once, all its keys together', () => {
    const b = batcher();
    b.add(['accounts'], ['account', 'a1']);
    expect(calls).toEqual(['["accounts"]', '["account","a1"]']);
  });

  it('B2: holds the keys of the events inside the window, once each, until it closes', () => {
    const b = batcher();
    b.add(['accounts']);
    b.add(['accounts'], ['transactions', '__all__']);
    b.add(['transactions', '__all__'], ['transaction', 't2']);
    const atOnce = [...calls];
    jest.advanceTimersByTime(REALTIME_WINDOW_MS - 1);
    const beforeClose = [...calls];
    jest.advanceTimersByTime(1);

    expect({ atOnce, beforeClose, closed: calls }).toEqual({
      atOnce: ['["accounts"]'],
      beforeClose: ['["accounts"]'],
      closed: [
        '["accounts"]',
        '["accounts"]',
        '["transactions","__all__"]',
        '["transaction","t2"]',
      ],
    });
  });

  it('B3: a burst longer than a window refreshes each key at most once per window', () => {
    const b = batcher();
    // 40 events 150 ms apart: another device's push, one row per request
    // over a phone's round trip -- six seconds of traffic.
    for (let i = 0; i < 40; i++) {
      b.add(['accounts']);
      jest.advanceTimersByTime(150);
    }
    jest.advanceTimersByTime(REALTIME_WINDOW_MS * 2);
    // The leading call, then one per window that held keys: six seconds of
    // events span six windows. (A 250 ms window refreshed it 25 times.)
    expect(calls.length).toBe(7);
  });

  it('B4: the first event after a quiet window is invalidated at once again', () => {
    const b = batcher();
    b.add(['accounts']);
    jest.advanceTimersByTime(REALTIME_WINDOW_MS);
    b.add(['recurring_rules']);
    expect(calls).toEqual(['["accounts"]', '["recurring_rules"]']);
  });

  it('B5: cancel drops the held keys and the window, and every later add', () => {
    const b = batcher();
    b.add(['accounts']);
    b.add(['transaction', 't2']);
    b.cancel();
    b.add(['recurring_rules']);
    jest.advanceTimersByTime(REALTIME_WINDOW_MS * 4);
    expect({ calls, timers: jest.getTimerCount() }).toEqual({
      calls: ['["accounts"]'],
      timers: 0,
    });
  });
});

describe('createSplitRefresher (#21)', () => {
  /** A refresh whose reads the test answers by hand. */
  function manualRefresh() {
    const reads: string[][] = [];
    const answers: (() => void)[] = [];
    const refresh = (ids: string[]) =>
      new Promise<void>((resolve) => {
        reads.push(ids);
        answers.push(resolve);
      });
    return { reads, answers, refresh };
  }

  it('R1: a burst of events names its parents in one read, once the window closes', async () => {
    const m = manualRefresh();
    const r = createSplitRefresher(m.refresh);
    r.schedule('t1');
    r.schedule('t2');
    r.schedule('t1');
    await jest.advanceTimersByTimeAsync(REALTIME_WINDOW_MS - 1);
    const before = m.reads.length;
    await jest.advanceTimersByTimeAsync(1);
    expect({ before, reads: m.reads }).toEqual({
      before: 0,
      reads: [['t1', 't2']],
    });
  });

  it('R2: a parent named while a read is out is read a window after it, never beside it', async () => {
    const m = manualRefresh();
    const r = createSplitRefresher(m.refresh);
    r.schedule('t1');
    await jest.advanceTimersByTimeAsync(REALTIME_WINDOW_MS);
    r.schedule('t1');
    r.schedule('t3');
    await jest.advanceTimersByTimeAsync(REALTIME_WINDOW_MS * 4);
    const whileOut = m.reads.length;
    m.answers[0]();
    await jest.advanceTimersByTimeAsync(REALTIME_WINDOW_MS - 1);
    const beforeWindow = m.reads.length;
    await jest.advanceTimersByTimeAsync(1);
    expect({ whileOut, beforeWindow, reads: m.reads }).toEqual({
      whileOut: 1,
      beforeWindow: 1,
      reads: [['t1'], ['t1', 't3']],
    });
  });

  it('R5: a trickle of split events costs one read per window, not one per event', async () => {
    let reads = 0;
    const r = createSplitRefresher(async () => {
      reads++;
      // A read takes about a round trip.
      await new Promise((res) => setTimeout(res, 150));
    });
    // 40 parents named 150 ms apart: another device's push, one row per
    // request.
    for (let i = 0; i < 40; i++) {
      r.schedule(`t${i}`);
      await jest.advanceTimersByTimeAsync(150);
    }
    await jest.advanceTimersByTimeAsync(REALTIME_WINDOW_MS * 4);
    // Six seconds of events, a read per window and its round trip. The
    // loop that re-read at once after each read made 39.
    expect(reads).toBe(6);
  });

  it('R3: a refresh that throws is warned, and the next one still runs', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const reads: string[][] = [];
    const r = createSplitRefresher(async (ids) => {
      reads.push(ids);
      if (reads.length === 1) throw new Error('boom');
    });
    r.schedule('t1');
    await jest.advanceTimersByTimeAsync(REALTIME_WINDOW_MS);
    r.schedule('t2');
    await jest.advanceTimersByTimeAsync(REALTIME_WINDOW_MS);
    expect({
      reads,
      warned: warn.mock.calls.map((c) => `${c[0]} ${String(c[1])}`),
    }).toEqual({
      reads: [['t1'], ['t2']],
      warned: ['[realtime] split refresh error: Error: boom'],
    });
  });

  it('R4: cancel drops what waits, and a read already out starts no other', async () => {
    const m = manualRefresh();
    const r = createSplitRefresher(m.refresh);
    r.schedule('t1');
    await jest.advanceTimersByTimeAsync(REALTIME_WINDOW_MS);
    r.schedule('t2');
    r.cancel();
    r.schedule('t3');
    m.answers[0]();
    await jest.advanceTimersByTimeAsync(REALTIME_WINDOW_MS * 4);
    expect({ reads: m.reads, timers: jest.getTimerCount() }).toEqual({
      reads: [['t1']],
      timers: 0,
    });
  });
});
