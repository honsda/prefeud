// Settlement worker: runs SprawlSession off the main thread (suggestion #2).
// Solve/grow messages bump the epoch — anything still running from an older
// epoch aborts at its next yield. Queries never invalidate running solves.

import { SprawlSession, type SolveJob, type SprawlQuery } from './sprawlSession';

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

scope.onmessage = (ev: MessageEvent<InMessage>) => {
  const msg = ev.data;
  if (msg.kind === 'solve') {
    const e = ++epoch;
    const stale = () => e !== epoch;
    session.solve(msg.job, stale).then((res) => {
      if (e !== epoch && res.ok) {
        scope.postMessage({ kind: 'solved', tag: msg.job.tag, ok: false, reason: 'stale' });
        return;
      }
      scope.postMessage({ kind: 'solved', ...res });
    });
  } else if (msg.kind === 'grow') {
    const e = ++epoch;
    const stale = () => e !== epoch;
    session.grow(msg.prev, msg.tag, msg.budget, stale).then((res) => {
      if (e !== epoch && res.ok) {
        scope.postMessage({ kind: 'grown', key: msg.prev, tag: msg.tag, ok: false, reason: 'stale' });
        return;
      }
      scope.postMessage({ kind: 'grown', ...res });
    });
  } else if (msg.kind === 'query') {
    scope.postMessage({ kind: 'qres', id: msg.id, ...session.query(msg.q) });
  }
};
