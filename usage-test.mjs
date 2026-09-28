import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import fsMutable from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { collectUsage } = jiti('./extensions/usage.ts');

const time = (minute) => `2025-01-01T00:${String(minute).padStart(2, '0')}:00.000Z`;
const usage = (n) => ({ input: n, output: n * 2, cacheRead: n * 3, cacheWrite: n * 4, cost: { total: n / 100 } });
const msg = (id, minute, message) => ({ type: 'message', id, timestamp: time(minute), message });
const assistant = (id, minute, n) => msg(id, minute, { role: 'assistant', content: [], usage: usage(n) });
const call = (id, minute, name, args) => msg(id, minute, { role: 'assistant', content: [{ type: 'toolCall', name, arguments: args }], usage: usage(0) });
const file = (p, header, entries) => {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, [header, ...entries].map(JSON.stringify).join('\n') + '\n');
};
const header = (id, parentSession) => ({ type: 'session', version: 3, id, timestamp: time(0), cwd: '/', parentSession });
const context = (id, p, entries) => ({ sessionManager: { getEntries: () => entries, getSessionId: () => id, getSessionFile: () => p } });

test('parent entries and named child windows, including tool results, branches and fork copies', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, 'original.jsonl');
  const fork = path.join(root, 'fork.jsonl');
  const parent = [call('call', 1, 'spawn_agent', { name: 'alpha' }), assistant('parent', 2, 1),
    { type: 'usage', id: 'extra', timestamp: time(2), usage: usage(2) },
    msg('result', 3, { role: 'toolResult', toolName: 'wait_agent', usage: usage(3) }),
    { type: 'compaction', id: 'compaction', timestamp: time(4), usage: usage(4) }];
  file(original, header('first'), parent);
  file(fork, header('forked', path.basename(original)), parent);
  const dir = path.join(root, 'pi-extended-agent-sessions', 'alpha');
  const child = path.join(dir, 'child.jsonl');
  const childFork = path.join(dir, 'child-fork.jsonl');
  const childEntries = [assistant('old', 0, 20), assistant('a', 2, 5),
    msg('nested', 3, { role: 'toolResult', toolName: 'other', usage: usage(6) }),
    { type: 'branch_summary', id: 'summary', timestamp: time(4), usage: usage(7) },
    assistant('other-owner', 8, 99)];
  file(child, header('child'), childEntries);
  file(childFork, header('child-fork', path.basename(child)), childEntries.slice(0, 4).concat(assistant('b', 5, 8)));
  fs.writeFileSync(path.join(root, 'pi-extended-agents.json'), JSON.stringify({ agents: { alpha: {
    accounting: [{ sessionId: 'first', startedAt: time(1), endedAt: time(6) },
      { sessionId: 'unrelated', startedAt: time(7), endedAt: time(9) }],
  } } }));
  const result = collectUsage(context('forked', fork, parent), root);
  assert.deepEqual(result.parent, { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cost: .1 });
  assert.equal(result.agents.input, 26); // 5 + 6 + 7 + 8, copied entries only once
  assert.equal(result.total.input, 36);
});

test('workflow child sessions are charged, not journal or result summaries; tool usage suppresses a represented run', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentFile = path.join(root, 'parent.jsonl');
  const runs = path.join(root, 'ultracode', 'runs');
  for (const id of ['run1', 'run2', 'run3', 'unrelated']) {
    const dir = path.join(runs, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ id, sessionId: id === 'unrelated' ? 'elsewhere' : 'parent', resumedFrom: id === 'run2' ? 'run1' : undefined }));
    fs.writeFileSync(path.join(dir, 'journal.jsonl'), JSON.stringify({ usage: usage(500) }));
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ usage: usage(500) }));
    file(path.join(dir, 'agents', '0', 'child.jsonl'), header(id), [assistant(id, 2, id === 'run1' ? 10 : 20)]);
  }
  const entries = [msg('workflow', 1, { role: 'toolResult', toolName: 'workflow', details: { runId: 'run2' }, usage: usage(2) })];
  file(parentFile, header('parent'), entries);
  const result = collectUsage(context('parent', parentFile, entries), root);
  assert.equal(result.parent.input, 2);
  assert.equal(result.workflows.input, 20); // run2's cumulative usage includes run1; unrelated excluded
  assert.ok(Math.abs(result.total.cost - .22) < 1e-9);
  // A fresh /new session can reference the old file but has no copied entries.
  const fresh = path.join(root, 'fresh.jsonl');
  file(fresh, header('fresh', parentFile), []);
  assert.equal(collectUsage(context('fresh', fresh, []), root).workflows.input, 0);
});

test('resumed run includes source children owned by another session, without unrelated runs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'ultracode', 'runs');
  for (const [id, owner, source, n] of [['source', 'old-session', undefined, 11],
    ['resume', 'current', 'source', 7], ['other', 'old-session', undefined, 50]]) {
    const dir = path.join(runs, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sessionId: owner, resumedFrom: source }));
    file(path.join(dir, 'agents', '0', 'child.jsonl'), header(id), [assistant(id, 2, n)]);
  }
  const entries = [msg('linked', 1, { role: 'toolResult', toolName: 'workflow', details: { runId: 'resume' } })];
  const parentFile = path.join(root, 'parent.jsonl');
  file(parentFile, header('current'), entries);
  assert.equal(collectUsage(context('current', parentFile, entries), root).workflows.input, 18);
});

test('unrelated tool result runId cannot import foreign workflow charges', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-trust-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'ultracode', 'runs', 'foreign');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sessionId: 'other' }));
  file(path.join(dir, 'agents', '0', 'child.jsonl'), header('foreign-child'), [assistant('charged', 2, 9)]);
  const entries = [msg('malicious', 1, { role: 'toolResult', toolName: 'bash', details: { runId: 'foreign' } })];
  const parentFile = path.join(root, 'parent.jsonl');
  file(parentFile, header('current'), entries);
  const ctx = context('current', parentFile, entries);
  assert.equal(collectUsage(ctx, root).workflows.input, 0);
  entries.push(msg('trusted', 3, { role: 'toolResult', toolName: 'workflow', details: { runId: 'foreign' } }));
  assert.equal(collectUsage(ctx, root).workflows.input, 9);
});

test('unlinked workflow discovery reads a bounded batch per collection', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'ultracode', 'runs');
  for (let i = 0; i < 300; i++) {
    const dir = path.join(runs, `run-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sessionId: 'current' }));
    file(path.join(dir, 'agents', '0', 'child.jsonl'), header(`child-${i}`), [assistant(`entry-${i}`, 1, 1)]);
  }
  const ctx = context('current', undefined, []);
  const first = collectUsage(ctx, root).workflows.input;
  assert.ok(first > 0 && first <= 128, `scanned ${first} runs`);
  const second = collectUsage(ctx, root).workflows.input;
  assert.ok(second > first && second <= 256, `incremental discovery scanned ${second} runs`);
  assert.equal(collectUsage(ctx, root).workflows.input, 300);
});

test('late run.json is discovered on the next collection without a runs-root mtime change', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-late-run-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const runs = path.join(root, 'ultracode', 'runs');
  const dir = path.join(runs, 'late');
  file(path.join(dir, 'agents', '0', 'child.jsonl'), header('child'), [assistant('charged', 1, 7)]);
  const ctx = context('owner', undefined, []);
  const fixedTime = new Date('2025-01-01T00:00:00.000Z');
  fs.utimesSync(runs, fixedTime, fixedTime);
  const before = fs.statSync(runs).mtimeMs;
  assert.equal(collectUsage(ctx, root).workflows.input, 0);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sessionId: 'owner' }));
  assert.equal(fs.statSync(runs).mtimeMs, before);
  assert.equal(collectUsage(ctx, root).workflows.input, 7);
  assert.equal(collectUsage(ctx, root).workflows.input, 7);
  const linked = path.join(runs, 'linked-late');
  file(path.join(linked, 'agents', '0', 'child.jsonl'), header('linked-child'), [assistant('linked-charge', 2, 7)]);
  const entries = [msg('linked-result', 1, { role: 'toolResult', toolName: 'workflow', details: { runId: 'linked-late' } })];
  const linkedCtx = context('owner', undefined, entries);
  assert.equal(collectUsage(linkedCtx, root).workflows.input, 7);
  fs.writeFileSync(path.join(linked, 'run.json'), JSON.stringify({ sessionId: 'foreign' }));
  assert.equal(collectUsage(linkedCtx, root).workflows.input, 14, 'linked run resolves directly when metadata appears');
});

test('metered agent turn does not hide other turns of the same named agent', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const parentFile = path.join(root, 'parent.jsonl');
  const child = path.join(root, 'pi-extended-agent-sessions', 'shared', 'child.jsonl');
  file(child, header('child'), [assistant('a', 2, 5), assistant('b', 5, 7)]);
  const entries = [call('called-a', 1, 'spawn_agent', { name: 'shared' }),
    msg('metered', 3, { role: 'toolResult', toolCallId: 'call-a', toolName: 'spawn_agent', details: { name: 'shared' }, usage: usage(5) }),
    call('called-b', 4, 'send_message', { agent: 'shared' })];
  file(parentFile, header('parent'), entries);
  fs.writeFileSync(path.join(root, 'pi-extended-agents.json'), JSON.stringify({ agents: { shared: {
    accounting: [{ sessionId: 'parent', toolCallId: 'call-a', startedAt: time(1), endedAt: time(3) },
      { sessionId: 'parent', toolCallId: 'call-b', startedAt: time(4), endedAt: time(6) }],
  } } }));
  const result = collectUsage(context('parent', parentFile, entries), root);
  assert.equal(result.agents.input, 7);
  assert.equal(result.total.input, 12);
});

test('restart closes and persists a crashed agent attribution window', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const stateFile = path.join(root, 'pi-extended-agents.json');
  fs.writeFileSync(stateFile, JSON.stringify({ agents: { shared: {
    name: 'shared', status: 'running', queue: [], accounting: [
      { sessionId: 'old', startedAt: time(1) },
      { sessionId: 'older', startedAt: time(0), endedAt: time(1) },
    ], usage: { turns: 0, input: 0, output: 0, cost: 0 }, turnCount: 0, cwd: root, createdAt: time(0),
  } } }));
  const tools = new Map();
  jiti('./extensions/agents.ts').default({ registerTool: (tool) => tools.set(tool.name, tool), registerCommand() {}, on() {} });
  await tools.get('list_agents').execute();
  const recovered = JSON.parse(fs.readFileSync(stateFile, 'utf8')).agents.shared;
  assert.equal(recovered.status, 'error');
  assert.ok(recovered.accounting[0].endedAt);
  assert.equal(recovered.accounting[1].endedAt, time(1));
  const parentFile = path.join(root, 'parent.jsonl');
  const entries = [call('new-call', 3, 'send_message', { agent: 'shared' })];
  file(parentFile, header('new'), entries);
  file(path.join(root, 'pi-extended-agent-sessions', 'shared', 'child.jsonl'), header('child'), [assistant('late', 4, 12)]);
  // A new parent cannot inherit the crashed owner's still-open window.
  assert.equal(collectUsage(context('new', parentFile, entries), root).agents.input, 0);
  const oldFile = path.join(root, 'old.jsonl');
  const oldEntries = [call('old-call', 1, 'spawn_agent', { name: 'shared' })];
  file(oldFile, header('old'), oldEntries);
  file(path.join(root, 'pi-extended-agent-sessions', 'shared', 'child.jsonl'), header('child'), [
    assistant('late', 4, 12), { ...assistant('future', 5, 9), timestamp: new Date(Date.now() + 60_000).toISOString() },
  ]);
  assert.equal(collectUsage(context('old', oldFile, oldEntries), root).agents.input, 12);
});

test('idle footer redraw reuses accounting, but session changes refresh it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; });
  const dir = path.join(root, 'ultracode', 'runs', 'run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sessionId: 'parent' }));
  const entries = [assistant('one', 1, 1)];
  const parentFile = path.join(root, 'parent.jsonl');
  file(parentFile, header('parent'), entries);
  let footer;
  const ctx = { ...context('parent', parentFile, entries), cwd: root, model: undefined,
    getContextUsage: () => undefined,
    ui: { setFooter: (factory) => { footer?.dispose(); footer = factory({ requestRender() {} },
      { fg: (_color, s) => s }, { onBranchChange: () => () => {}, getGitBranch: () => '', getExtensionStatuses: () => new Map() }); } },
  };
  const events = new Map();
  jiti('./extensions/ui.ts').default({ on: (name, fn) => events.set(name, fn), registerCommand() {}, getThinkingLevel: () => 'off' });
  await events.get('session_start')({}, ctx);
  try {
    assert.match(footer.render(120)[1], /\$0\.010/);
    // Updating a linked child file cannot change an idle redraw's cached accounting.
    file(path.join(dir, 'agents', '0', 'child.jsonl'), header('child'), [assistant('child-entry', 2, 5)]);
    assert.match(footer.render(120)[1], /\$0\.010/);
    entries.push(assistant('two', 2, 2));
    assert.match(footer.render(120)[1], /\$0\.080/); // new entries refresh child and parent usage
  } finally { footer.dispose(); }
});

test('legacy turns of a reused agent remain unknown; only session-owned windows are billed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-usage-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const firstFile = path.join(root, 'first.jsonl');
  const secondFile = path.join(root, 'second.jsonl');
  const first = [call('first-legacy', 1, 'spawn_agent', { name: 'shared' }),
    call('first-tracked', 5, 'send_message', { agent: 'shared' })];
  const second = [call('second-legacy', 3, 'spawn_agent', { name: 'shared' }),
    call('second-tracked', 7, 'send_message', { agent: 'shared' })];
  file(firstFile, header('first'), first);
  file(secondFile, header('second'), second);
  const child = path.join(root, 'pi-extended-agent-sessions', 'shared', 'child.jsonl');
  file(child, header('child'), [assistant('first-unknown', 2, 11), assistant('second-unknown', 4, 13),
    assistant('first-owned', 6, 5), assistant('second-owned', 8, 7)]);
  const firstCtx = context('first', firstFile, first);
  const secondCtx = context('second', secondFile, second);
  // Neither parent may infer ownership of historical turns from the shared name.
  assert.equal(collectUsage(firstCtx, root).total.input, 0);
  assert.equal(collectUsage(secondCtx, root).total.input, 0);
  fs.writeFileSync(path.join(root, 'pi-extended-agents.json'), JSON.stringify({ agents: { shared: {
    accounting: [{ sessionId: 'first', toolCallId: 'first-call', startedAt: time(5), endedAt: time(6) },
      { sessionId: 'second', toolCallId: 'second-call', startedAt: time(7), endedAt: time(8) }],
  } } }));
  assert.equal(collectUsage(firstCtx, root).agents.input, 5);
  assert.equal(collectUsage(secondCtx, root).agents.input, 7);
  assert.equal(collectUsage(firstCtx, root).total.cost, .05);
  assert.equal(collectUsage(secondCtx, root).total.cost, .07);
  first.push(msg('metered', 9, { role: 'toolResult', toolCallId: 'first-call', toolName: 'send_message',
    details: { name: 'shared' }, usage: usage(5) }));
  assert.equal(collectUsage(firstCtx, root).agents.input, 0);
  assert.equal(collectUsage(firstCtx, root).total.input, 5);
  assert.equal(collectUsage(secondCtx, root).agents.input, 7);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const totals = (n) => ({ input: n, output: n * 2, cacheRead: n * 3, cacheWrite: n * 4, cost: n / 100 });

function rpcHarness(root, loader = jiti) {
  const events = new Map();
  const emitted = [];
  const sessions = new Map();
  let current;
  loader('./extensions/ui.ts').default({
    on: (name, fn) => events.set(name, fn), registerCommand() {}, getThinkingLevel: () => 'off',
    appendEntry(customType, data) {
      const entries = sessions.get(current).entries;
      const entry = { type: 'custom', id: `snapshot-${emitted.length}`, parentId: entries.at(-1)?.id ?? null,
        timestamp: new Date().toISOString(), customType, data };
      entries.push(entry);
      emitted.push({ type: 'entry_appended', entry });
    },
  });
  const addSession = (id, entries = []) => {
    sessions.set(id, { entries, file: path.join(root, `${id}.jsonl`) });
    file(sessions.get(id).file, header(id), entries);
  };
  const ctx = {
    mode: 'rpc', cwd: root, model: undefined,
    sessionManager: {
      getSessionId: () => current,
      getSessionFile: () => sessions.get(current).file,
      getEntries: () => sessions.get(current).entries,
    },
    // RPC does not implement TUI footer/indicator calls.
    ui: { setFooter() { throw Error('no RPC footer'); }, setWorkingIndicator() { throw Error('no RPC indicator'); } },
  };
  const dispatch = async (name, event = {}) => events.get(name)(event, ctx);
  const snapshots = () => emitted.map((e) => {
    assert.equal(e.type, 'entry_appended');
    assert.equal(e.entry.type, 'custom');
    assert.equal(e.entry.customType, 'pi-extended-cost');
    assert.deepEqual(Object.keys(e.entry).sort(), ['type', 'id', 'parentId', 'timestamp', 'customType', 'data'].sort());
    assert.equal(typeof e.entry.id, 'string');
    assert.ok(Number.isFinite(Date.parse(e.entry.timestamp)));
    assert.deepEqual(Object.keys(e.entry.data).sort(),
      ['version', 'sessionId', 'parent', 'agents', 'workflows', 'total', 'activeAgents'].sort());
    assert.equal(e.entry.data.version, 1);
    assert.equal('content' in e.entry, false);
    assert.equal('content' in e.entry.data, false);
    for (const key of ['parent', 'agents', 'workflows', 'total']) {
      assert.deepEqual(Object.keys(e.entry.data[key]).sort(), ['input', 'output', 'cacheRead', 'cacheWrite', 'cost'].sort());
      for (const value of Object.values(e.entry.data[key])) assert.ok(typeof value === 'number' && Number.isFinite(value));
    }
    return e.entry.data;
  });
  return { addSession, dispatch, snapshots, emitted, sessions, select: (id) => { current = id; },
    getEntries: (id) => sessions.get(id).entries };
}

test('RPC snapshots reconcile finalized assistant usage once and rekey on session switch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-usage-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const h = rpcHarness(root);
  h.addSession('first');
  h.select('first');
  await h.dispatch('session_start');
  assert.equal(h.emitted.length, 0, 'initial event waits until session_start/new_session has returned');
  await sleep(15);
  assert.deepEqual(h.snapshots()[0], { version: 1, sessionId: 'first', parent: totals(0),
    agents: totals(0), workflows: totals(0), total: totals(0), activeAgents: 0 });
  const pending = { role: 'assistant', timestamp: Date.parse(time(1)), content: [], usage: usage(3) };
  await h.dispatch('message_end', { message: pending });
  assert.equal(h.emitted.length, 1, 'message_end coalesces instead of emitting synchronously');
  await sleep(110);
  assert.deepEqual(h.snapshots().at(-1).total, totals(3));
  assert.equal(h.emitted.length, 2);
  h.sessions.get('first').entries.push(msg('persisted', 1, pending));
  await h.dispatch('agent_settled');
  assert.equal(h.emitted.length, 2, 'persisting the pending message must not double count or emit a duplicate');
  await h.dispatch('agent_settled');
  assert.equal(h.emitted.length, 2, 'settle deduplicates the unchanged snapshot');

  await h.dispatch('message_end', { message: { role: 'assistant', timestamp: Date.parse(time(2)), usage: usage(99) } });
  h.addSession('second', [assistant('second-message', 2, 4)]);
  h.select('second');
  await h.dispatch('session_start');
  const beforeInitial = h.emitted.length;
  await sleep(15);
  assert.equal(h.emitted.length, beforeInitial + 1);
  assert.deepEqual(h.snapshots().at(-1).total, totals(4));
  assert.equal(h.snapshots().at(-1).sessionId, 'second');
  const count = h.emitted.length;
  await sleep(260);
  assert.equal(h.emitted.length, count, 'old session coalesce/reconcile timers must not publish');
  await h.dispatch('session_shutdown');
});

test('RPC same-millisecond finalized messages are reconciled with multiplicity', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-messages-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const h = rpcHarness(root);
  h.addSession('owner');
  h.select('owner');
  await h.dispatch('session_start');
  await sleep(15);
  const timestamp = Date.parse(time(1));
  for (const n of [2, 3]) await h.dispatch('message_end', { message: { role: 'assistant', timestamp, usage: usage(n) } });
  await sleep(110);
  assert.equal(h.snapshots().at(-1).parent.input, 5);
  h.sessions.get('owner').entries.push(msg('persisted', 1, { role: 'assistant', timestamp, content: [], usage: usage(2) }));
  await h.dispatch('agent_settled');
  assert.equal(h.snapshots().at(-1).parent.input, 5);
  h.sessions.get('owner').entries.push(msg('persisted-too', 1, { role: 'assistant', timestamp, content: [], usage: usage(3) }));
  await h.dispatch('agent_settled');
  assert.equal(h.snapshots().at(-1).parent.input, 5);
  await h.dispatch('session_shutdown');
});

test('RPC child results refresh unchanged parent entries, count owned active agents and settle immediately', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-usage-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const h = rpcHarness(root);
  const entries = [call('spawn', 1, 'spawn_agent', { name: 'alpha' }), assistant('parent', 2, 2)];
  h.addSession('owner', entries);
  h.select('owner');
  const registry = path.join(root, 'pi-extended-agents.json');
  const putRegistry = (status, endedAt) => fs.writeFileSync(registry, JSON.stringify({ agents: {
    alpha: { status, accounting: [{ sessionId: 'owner', startedAt: time(1), endedAt }] },
    unrelated: { status: 'running', accounting: [{ sessionId: 'elsewhere', startedAt: time(1) }] },
  } }));
  putRegistry('running');
  await h.dispatch('session_start');
  await sleep(15);
  assert.equal(h.snapshots().at(-1).activeAgents, 1);
  assert.deepEqual(h.snapshots().at(-1).total, totals(2));
  const child = path.join(root, 'pi-extended-agent-sessions', 'alpha', 'child.jsonl');
  file(child, header('child'), [assistant('child-one', 3, 5)]);
  await h.dispatch('tool_result', { toolName: 'spawn_agent' });
  assert.equal(h.snapshots().length, 1);
  await sleep(110);
  assert.deepEqual(h.snapshots().at(-1).agents, totals(5));
  assert.deepEqual(h.snapshots().at(-1).total, totals(7));
  assert.equal(h.sessions.get('owner').entries.filter((e) => e.type === 'message').length, 2);

  file(child, header('child'), [assistant('child-one', 3, 5), assistant('child-two', 4, 7)]);
  putRegistry('done', time(5));
  await h.dispatch('agent_settled');
  assert.deepEqual({ ...h.snapshots().at(-1).agents, cost: Number(h.snapshots().at(-1).agents.cost.toFixed(8)) }, totals(12));
  assert.deepEqual({ ...h.snapshots().at(-1).total, cost: Number(h.snapshots().at(-1).total.cost.toFixed(8)) }, totals(14));
  assert.equal(h.snapshots().at(-1).activeAgents, 0);
  const count = h.emitted.length;
  await h.dispatch('tool_result', { toolName: 'wait_agent' });
  await h.dispatch('session_shutdown');
  await sleep(120);
  assert.equal(h.emitted.length, count, 'shutdown cancels queued child snapshot');
});

test('RPC initial snapshot is live after session start, recoverable from entries, and canceled on replacement', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-initial-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const h = rpcHarness(root);
  h.addSession('first', [assistant('already-billed', 1, 3)]);
  h.select('first');
  await h.dispatch('session_start');
  // Delay is best effort, not a promise about response/event ordering.
  assert.equal(h.emitted.length, 0);
  await sleep(15);
  assert.deepEqual(h.snapshots()[0].total, totals(3));
  const catchup = h.getEntries('first').filter((e) => e.type === 'custom' && e.customType === 'pi-extended-cost');
  assert.equal(catchup.length, 1, 'late subscribers can recover the missed live event via get_entries');
  assert.deepEqual(catchup[0], h.emitted[0].entry);
  h.addSession('abandoned');
  h.select('abandoned');
  await h.dispatch('session_start');
  h.addSession('replacement');
  h.select('replacement');
  await h.dispatch('session_start');
  await sleep(15);
  assert.equal(h.getEntries('abandoned').length, 0, 'superseded initial timer never appends');
  assert.deepEqual(h.snapshots().at(-1).total, totals(0));
  assert.equal(h.snapshots().at(-1).sessionId, 'replacement');
  await h.dispatch('session_shutdown');
});

test('RPC running children cause no idle IO; only lifecycle events refresh charges', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-event-only-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const originalRead = fsMutable.readFileSync;
  let reads = 0;
  fsMutable.readFileSync = function (filename, ...args) {
    if (typeof filename === 'string' && filename.startsWith(root)) reads++;
    return originalRead.call(this, filename, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsMutable.readFileSync = originalRead;
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dir = path.join(root, 'ultracode', 'runs', 'active-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sessionId: 'owner', status: 'running' }));
  const child = path.join(dir, 'agents', '0', 'child.jsonl');
  file(child, header('child'), [assistant('one', 2, 2)]);
  const entries = [call('spawn', 1, 'spawn_agent', { name: 'alpha' }),
    msg('active', 1, { role: 'toolResult', toolName: 'workflow', details: { runId: 'active-run' } })];
  fs.writeFileSync(path.join(root, 'pi-extended-agents.json'), JSON.stringify({ agents: {
    alpha: { status: 'running', accounting: [{ sessionId: 'owner', startedAt: time(1) }] },
  } }));
  const h = rpcHarness(root, createJiti(import.meta.url, { moduleCache: false }));
  h.addSession('owner', entries);
  h.select('owner');
  await h.dispatch('session_start');
  assert.equal(reads, 0, 'session_start does not inspect historical workflow run status');
  await sleep(150); // initial snapshot and any bounded discovery retries finish
  assert.equal(h.snapshots().at(-1).workflows.input, 2);
  assert.equal(h.snapshots().at(-1).activeAgents, 1);
  const idleReads = reads;
  const idleCount = h.emitted.length;
  file(child, header('child'), [assistant('one', 2, 2), assistant('two', 3, 3)]);
  await sleep(2200); // beyond the former two-second child poll
  assert.equal(reads, idleReads, 'no running-child or workflow reads without an event');
  assert.equal(h.emitted.length, idleCount);
  await h.dispatch('tool_result', { toolName: 'workflow' });
  await sleep(110);
  assert.equal(h.snapshots().at(-1).workflows.input, 5);
  await h.dispatch('session_shutdown');
});

test('RPC historical discovery is event-bounded, not drained by a 25ms timer', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-history-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  const runs = path.join(root, 'ultracode', 'runs');
  for (let i = 0; i < 300; i++) {
    const dir = path.join(runs, `run-${i}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sessionId: 'owner' }));
    file(path.join(dir, 'agents', '0', 'child.jsonl'), header(`child-${i}`), [assistant(`entry-${i}`, 1, 1)]);
  }
  const originalRead = fsMutable.readFileSync;
  let metadataReads = 0;
  fsMutable.readFileSync = function (filename, ...args) {
    if (typeof filename === 'string' && filename.startsWith(runs) && filename.endsWith('run.json')) metadataReads++;
    return originalRead.call(this, filename, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => {
    fsMutable.readFileSync = originalRead;
    syncBuiltinESMExports();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const h = rpcHarness(root, createJiti(import.meta.url, { moduleCache: false }));
  h.addSession('owner');
  h.select('owner');
  await h.dispatch('session_start');
  await sleep(40);
  assert.ok(metadataReads > 0 && metadataReads <= 128, `startup opened ${metadataReads} run.json files`);
  const first = h.snapshots().at(-1).workflows.input;
  assert.ok(first > 0 && first <= 128);
  const idleReads = metadataReads;
  const idleSnapshots = h.emitted.length;
  await sleep(220);
  assert.equal(metadataReads, idleReads, 'idle time does not drain historical run.json files');
  assert.equal(h.emitted.length, idleSnapshots);
  await h.dispatch('agent_settled');
  assert.ok(metadataReads > idleReads && metadataReads <= idleReads + 128);
  assert.ok(h.snapshots().at(-1).workflows.input > first);
  await h.dispatch('session_shutdown');
});

test('RPC workflow completion and metered tool result reconcile without child double billing', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-rpc-workflow-'));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const h = rpcHarness(root);
  const entries = [msg('workflow-result', 1, { role: 'toolResult', toolName: 'workflow',
    details: { runId: 'rpc-run', background: true } })];
  const dir = path.join(root, 'ultracode', 'runs', 'rpc-run');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sessionId: 'owner', status: 'running' }));
  const child = path.join(dir, 'agents', '0', 'child.jsonl');
  file(child, header('child'), [assistant('first', 2, 2)]);
  h.addSession('owner', entries);
  h.select('owner');
  await h.dispatch('session_start');
  await sleep(15);
  assert.equal(h.snapshots().at(-1).workflows.input, 2);
  file(child, header('child'), [assistant('first', 2, 2), assistant('second', 3, 3)]);
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ sessionId: 'owner', status: 'done' }));
  await h.dispatch('tool_result', { toolName: 'workflow' });
  await sleep(110);
  assert.equal(h.snapshots().at(-1).workflows.input, 5);
  assert.equal(h.snapshots().at(-1).total.input, 5);

  const metered = msg('metered', 4, { role: 'toolResult', toolName: 'workflow',
    details: { runId: 'rpc-run' }, usage: usage(5) });
  await h.dispatch('message_end', { message: metered.message }); // before persistence: do not overlay child + tool
  entries.push(metered);
  entries.push({ type: 'compaction', id: 'compact', timestamp: time(5), usage: usage(2) });
  await h.dispatch('agent_settled');
  assert.equal(h.snapshots().at(-1).parent.input, 7);
  assert.equal(h.snapshots().at(-1).workflows.input, 0);
  assert.equal(h.snapshots().at(-1).total.input, 7);
  await sleep(230);
  assert.equal(h.snapshots().at(-1).total.input, 7, 'no delayed duplicate after settlement');
  await h.dispatch('session_shutdown');
});
