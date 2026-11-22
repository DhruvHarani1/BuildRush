import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schedule, detectCycle } from '../src/scheduler.js';

const node = (id: string, deps: string[] = [], weight = 1, estimateMs = 1) => ({ id, deps, weight, estimateMs });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('respects dependency order and capacity bound', async () => {
  let running = 0;
  let peak = 0;
  const order: string[] = [];
  const nodes = [node('a'), node('b'), node('c'), node('d'), node('e', ['a', 'b', 'c', 'd'])];
  const st = await schedule(nodes, async (id) => {
    running++; peak = Math.max(peak, running);
    await sleep(15);
    running--; order.push(id);
    return 'succeeded';
  }, { capacity: 2 });
  assert.equal(peak, 2);
  assert.equal(order.at(-1), 'e');
  assert.equal(st.get('e'), 'succeeded');
});

test('failure skips dependents but independent branches still run; bail cancels', async () => {
  const nodes = [node('bad'), node('child', ['bad']), node('grandchild', ['child']), node('other')];
  const st = await schedule(nodes, async (id) => (id === 'bad' ? 'failed' : 'succeeded'), { capacity: 2 });
  assert.equal(st.get('bad'), 'failed');
  assert.equal(st.get('child'), 'skipped');
  assert.equal(st.get('grandchild'), 'skipped');
  assert.equal(st.get('other'), 'succeeded');

  const st2 = await schedule([node('bad'), node('slow')], async (id, signal) => {
    if (id === 'bad') return 'failed';
    await new Promise<void>((r) => signal.addEventListener('abort', () => r(), { once: true }));
    return 'failed';
  }, { capacity: 2, bail: true });
  assert.equal(st2.get('slow'), 'cancelled');
});

test('external abort cancels pending work', async () => {
  const ac = new AbortController();
  const started: string[] = [];
  const st = await schedule([node('a'), node('b', ['a'])], async (id) => {
    started.push(id);
    ac.abort();
    return 'succeeded';
  }, { capacity: 1, signal: ac.signal });
  assert.deepEqual(started, ['a']);
  assert.equal(st.get('b'), 'cancelled');
});

test('"skipped" from exec satisfies dependents (nothing to do is not a failure)', async () => {
  const st = await schedule([node('t'), node('after', ['t'])], async (id) => (id === 't' ? 'skipped' : 'succeeded'), { capacity: 1 });
  assert.equal(st.get('after'), 'succeeded');
});

test('critical path first', async () => {
  const order: string[] = [];
  await schedule(
    [node('short', [], 1, 10), node('long', [], 1, 10), node('after-long', ['long'], 1, 1000)],
    async (id) => { order.push(id); return 'succeeded'; },
    { capacity: 1 },
  );
  assert.equal(order[0], 'long');
});

test('cycle detection', () => {
  assert.deepEqual(detectCycle([node('a', ['b']), node('b', ['a'])]), ['a', 'b', 'a']);
  assert.equal(detectCycle([node('a', ['b']), node('b')]), null);
});
