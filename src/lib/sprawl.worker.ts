// Settlement worker: runs SprawlSession off the main thread (suggestion #2).
// Solve/grow messages bump the epoch — anything still running from an older
// epoch aborts at its next yield. Queries never invalidate running solves.

import { SprawlSession, type SolveJob, type SolveResult, type SprawlQuery } from './sprawlSession';

type InMessage =
  | { kind: 'solve'; job: SolveJob }
  | { kind: 'grow'; prev: string; tag: string; budget: number }
  | { kind: 'query'; id: number; q: SprawlQuery };

const scope = self as unknown as {
  postMessage(data: unknown): void;
  onmessage: ((ev: MessageEvent<InMessage>) => void) | null;
};

const session = new SprawlSession();
let epoch = 0;

/** Never leave the main thread hanging: sync throws and async rejections
 *  both resolve as failures so stale overlays get replaced, not stuck. */
type Reply = SolveResult | { tag?: string; key?: string; ok: false; reason: string };
function answer(promise: Promise<Reply>, kind: string, fallback: { tag?: string; key?: string }) {
  promise.then(
    (res) => scope.postMessage({ kind, ...res }),
    () => scope.postMessage({ kind, ...fallback, ok: false, reason: 'stale' }),
  );
}

scope.onmessage = (ev: MessageEvent<InMessage>) => {
  const msg = ev.data;
  try {
    if (msg.kind === 'solve') {
      const e = ++epoch;
      const stale = () => e !== epoch;
      answer(
        session.solve(msg.job, stale).then((res) => {
          if (e !== epoch && res.ok) return { tag: msg.job.tag, ok: false, reason: 'stale' } as const;
          return res;
        }),
        'solved',
        { tag: msg.job.tag },
      );
    } else if (msg.kind === 'grow') {
      const e = ++epoch;
      const stale = () => e !== epoch;
      answer(
        session.grow(msg.prev, msg.tag, msg.budget, stale).then((res) => {
          if (e !== epoch && res.ok)
            return { key: msg.prev, tag: msg.tag, ok: false, reason: 'stale' } as const;
          return res;
        }),
        'grown',
        { key: msg.prev, tag: msg.tag },
      );
    } else if (msg.kind === 'query') {
      scope.postMessage({ kind: 'qres', id: msg.id, ...session.query(msg.q) });
    }
  } catch {
    // sync throw before the promise existed (bad input shape)
    if (msg.kind === 'solve') scope.postMessage({ kind: 'solved', tag: msg.job.tag, ok: false, reason: 'bad-input' });
    else if (msg.kind === 'grow') scope.postMessage({ kind: 'grown', key: msg.prev, tag: msg.tag, ok: false, reason: 'stale' });
  }
};
