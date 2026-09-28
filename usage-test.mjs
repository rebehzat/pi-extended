import assert from 'node:assert/strict';
import * as fs from 'node:fs';
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
