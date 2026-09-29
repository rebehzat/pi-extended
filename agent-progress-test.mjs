import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createJiti } from 'jiti';

const jiti = createJiti(import.meta.url);
const { createAgentProgress } = jiti('./extensions/agent-progress.ts');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

function harness() {
  let sessionId = 'owner';
  const entries = { owner: [], next: [] };
  const emitted = [];
  const ctx = { mode: 'rpc', sessionManager: { getSessionId: () => sessionId,
    getEntries: () => entries[sessionId] } };
  const progress = createAgentProgress({ appendEntry(customType, data) {
    const entry = { type: 'custom', customType, data };
    entries[sessionId].push(entry);
    emitted.push(entry);
  } });
  const select = (id) => { sessionId = id; progress.sessionStart(ctx); };
  select('owner');
  return { ctx, progress, entries, emitted, select };
}

const checkWire = (entry) => {
  assert.equal(entry.type, 'custom');
  assert.equal(entry.customType, 'piano-task-progress');
  assert.deepEqual(Object.keys(entry.data).sort(),
    ['version', 'sessionId', 'taskId', 'kind', 'status', 'title', 'startedAt', 'updatedAt', 'usage',
      ...(entry.data.endedAt ? ['endedAt'] : [])].sort());
  assert.equal(entry.data.version, 1);
  assert.equal(entry.data.kind, 'spawned_agent');
  assert.match(entry.data.taskId, /^[0-9a-f-]{36}$/);
  assert.match(entry.data.title, /^Agent #\d+$/);
  for (const key of ['startedAt', 'updatedAt', ...(entry.data.endedAt ? ['endedAt'] : [])]) {
    assert.ok(Number.isFinite(Date.parse(entry.data[key])));
  }
  for (const value of Object.values(entry.data.usage)) assert.ok(Number.isFinite(value) && value >= 0);
};

test('RPC task emits allowlisted running/progress/completed snapshots, coalesces and deduplicates', async () => {
  const h = harness();
  const task = h.progress.begin(h.ctx);
  assert.equal(h.emitted[0].data.status, 'running');
  h.progress.running(task, h.ctx);
  assert.equal(h.emitted.length, 1);
  const usage = { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, totalTokens: 17,
    cost: { total: .02 }, content: 'private child output' };
  for (let i = 0; i < 20; i++) h.progress.usage(task, h.ctx, usage);
  assert.equal(h.emitted.length, 1);
  await pause(125);
  assert.equal(h.emitted.length, 2);
  assert.deepEqual({ ...h.emitted[1].data.usage, costUsd: Number(h.emitted[1].data.usage.costUsd.toFixed(8)) },
    { totalTokens: 340, inputTokens: 180, cachedInputTokens: 100, outputTokens: 60, costUsd: .4 });
  h.progress.finish(task, h.ctx, 'completed');
  h.progress.finish(task, h.ctx, 'failed');
  assert.equal(h.emitted.length, 3);
  assert.equal(h.emitted[2].data.status, 'completed');
  for (const entry of h.emitted) checkWire(entry);
  assert.doesNotMatch(JSON.stringify(h.emitted), /private child output|content|prompt|path|stderr|pid/i);
});

test('long-running tasks have bounded intermediate history but exact final usage', async () => {
  const h = harness();
  const task = h.progress.begin(h.ctx);
  for (let i = 0; i < 35; i++) {
    h.progress.usage(task, h.ctx, { input: 1, totalTokens: 1 });
    await pause(110);
  }
  assert.ok(h.emitted.length <= 33);
  h.progress.finish(task, h.ctx, 'completed');
  assert.equal(h.emitted.at(-1).data.usage.totalTokens, 35);
  assert.ok(h.emitted.length <= 34);
});

test('pending, running, cancelled, failed and interrupted lifecycle', () => {
  const h = harness();
  const first = h.progress.begin(h.ctx, 'pending');
  h.progress.running(first, h.ctx);
  h.progress.finish(first, h.ctx, 'cancelled');
  const second = h.progress.begin(h.ctx);
  h.progress.finish(second, h.ctx, 'failed');
  h.progress.begin(h.ctx);
  h.progress.shutdown(h.ctx);
  assert.deepEqual(h.emitted.map((e) => e.data.status),
    ['pending', 'running', 'cancelled', 'running', 'failed', 'running', 'interrupted']);
  assert.deepEqual(h.emitted.map((e) => e.data.title),
    ['Agent #1', 'Agent #1', 'Agent #1', 'Agent #2', 'Agent #2', 'Agent #3', 'Agent #3']);
  for (const entry of h.emitted) checkWire(entry);
});

test('session switch pins owner and cancels late progress; resume restores generic numbering', async () => {
  const h = harness();
  const old = h.progress.begin(h.ctx);
  h.progress.usage(old, h.ctx, { input: 1 });
  h.select('next');
  const task = h.progress.begin(h.ctx);
  h.progress.usage(old, h.ctx, { input: 100 });
  h.progress.finish(old, h.ctx, 'completed');
  await pause(130);
  assert.equal(h.emitted.length, 2);
  assert.equal(h.emitted[1].data.sessionId, 'next');
  h.progress.finish(task, h.ctx, 'completed');
  h.select('owner');
  assert.equal(h.progress.begin(h.ctx).title, 'Agent #2');
  assert.equal(h.entries.next.length, 2);
});

test('invalid/huge usage cannot write NaN, infinity or negative values', () => {
  const h = harness();
  const task = h.progress.begin(h.ctx);
  h.progress.usage(task, h.ctx, { input: Infinity, output: -1, cacheRead: NaN,
    cacheWrite: Number.MAX_VALUE, totalTokens: -3, cost: { total: Infinity } });
  h.progress.usage(task, h.ctx, { input: Number.MAX_VALUE, totalTokens: Number.MAX_VALUE,
    cost: { total: Number.MAX_VALUE } });
  h.progress.finish(task, h.ctx, 'completed');
  checkWire(h.emitted.at(-1));
  assert.equal(h.emitted.at(-1).data.usage.totalTokens, Number.MAX_SAFE_INTEGER);
});

test('non-RPC mode never publishes or retains tasks', () => {
  const h = harness();
  const ctx = { ...h.ctx, mode: 'tui' };
  assert.equal(h.progress.begin(ctx), undefined);
  assert.equal(h.emitted.length, 0);
});

test('spawn_agent integration publishes a private-free task from real child JSON events', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-agent-'));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const oldScript = process.argv[1];
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    process.argv[1] = oldScript;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const script = path.join(root, 'fake-child.mjs');
  fs.writeFileSync(script, `setTimeout(() => console.log(JSON.stringify({type:'message_end',message:{role:'assistant',content:[{type:'text',text:'CHILD_SECRET'}],usage:{input:2,output:3,cacheRead:4,totalTokens:9,cost:{total:.12}}}})), 150);`);
  process.argv[1] = script;
  const tools = new Map(), events = new Map(), entries = [];
  const ctx = { mode: 'rpc', cwd: root, sessionManager: {
    getSessionId: () => 'owner', getEntries: () => entries } };
  jiti('./extensions/agents.ts').default({
    registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {},
    on: (name, fn) => events.set(name, fn),
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  });
  await events.get('session_start')({}, ctx);
  const result = await tools.get('spawn_agent').execute('call-id', { name: 'PRIVATE_NAME',
    task: 'PRIVATE_PROMPT', cwd: root }, undefined, () => {}, ctx);
  assert.match(result.content[0].text, /PRIVATE_NAME/); // existing agent API remains unchanged
  await tools.get('followup_task').execute('follow-id', { agent: 'PRIVATE_NAME', task: 'SECOND_SECRET' }, undefined, () => {}, ctx);
  const wait = await tools.get('wait_agent').execute('wait-id', { agent: 'PRIVATE_NAME', timeout_s: 5 }, undefined, () => {}, ctx);
  assert.match(wait.content[0].text, /CHILD_SECRET/);
  assert.deepEqual(entries.map((e) => e.data.status), ['running', 'pending', 'completed', 'running', 'completed']);
  assert.deepEqual(entries.at(-1).data.usage, { totalTokens: 9, inputTokens: 2,
    cachedInputTokens: 4, outputTokens: 3, costUsd: .12 });
  for (const entry of entries) checkWire(entry);
  assert.doesNotMatch(JSON.stringify(entries), /PRIVATE_NAME|PRIVATE_PROMPT|SECOND_SECRET|CHILD_SECRET|fake-child|call-id|pid/i);
  await events.get('session_shutdown')({}, ctx);
});
