#!/usr/bin/env node
// Drive DSH over the ACP control plane instead of puppeting its web UI.
//
// WHY THIS EXISTS
//
// The control plane was built so an agent would stop simulating clicks. It then
// got used exactly twice, because reading the DOM was the habit and the habit
// was already in hand. This file removes the excuse: one command per thing an
// agent actually wants, so the lazy path and the correct path are the same path.
//
//   node acp.mjs list                       every session, with state
//   node acp.mjs state <id>                 one session's state and what it admits
//   node acp.mjs rename <id> <title>        canonical rename, host is authority
//   node acp.mjs prompt <id> <text>         drive a session, stream its reply
//   node acp.mjs watch [id]                 follow events until interrupted
//   node acp.mjs new <cwd> [text]           create a session, optionally prompt it
//   node acp.mjs cancel <id>                stop a turn that is running right now
//   node acp.mjs steer <id> <text>          cancel, then say this instead
//
// STEERING, AND WHY IT IS A COMMAND RATHER THAN A HABIT
//
// A lane that has been told the wrong thing keeps working for minutes on the
// wrong thing, and the coordinator watches it happen because `prompt` is
// refused while a turn is live (`availableCommands.prompt: false`) and waiting
// for idle is the only path the CLI offered. `cancel` was there the whole time.
// `steer` is the pair that is actually wanted: stop, then say the new thing, in
// one command, so correcting a lane costs one line rather than a decision.
//
// THE THREE THINGS THAT COST ME AN HOUR, WRITTEN DOWN SO THEY COST NOBODY ELSE
//
//   1. Only `initialize` answers in the POST body. Everything else returns 202
//      and its response arrives on GET /acp/stream. A client that waits on the
//      POST hangs forever and looks like a broken server.
//
//   2. Subscribe with ?after=<cursor> or the stream replays the ENTIRE log from
//      the beginning. Mine did, and I read a test fixture's old chatter as if it
//      were my own answer. Replay working correctly is what made the mistake
//      look like a result.
//
//   3. cwd must be an absolute path, and a Windows path through a shell heredoc
//      loses its backslashes: D:\Letters\... arrives as D:Letters... The service
//      refuses it with a clear message rather than guessing, which is the only
//      reason it took minutes rather than hours.
//
// Auth: X-Secret-Key for anything that can set headers. Browser EventSource and
// WebSocket cannot, which is why ?token= exists as well — do not use it here.
// The token lives in the plugin's cordis.patch.yml, not in a browser.

import { readFileSync } from 'node:fs';

const BASE = process.env.ACP_BASE ?? 'http://127.0.0.1:7810';
const PATCH = process.env.ACP_PATCH
  ?? 'D:/Letters/MatTroiSeConMoc/.dsh/profiles/web/plugins/dsh-acp-control/cordis.patch.yml';

/** The token is configuration, not a secret to re-derive: read it where it lives. */
function token() {
  if (process.env.ACP_TOKEN) return process.env.ACP_TOKEN;
  const m = readFileSync(PATCH, 'utf8').match(/^\s*token:\s*"([^"]+)"/m);
  if (!m) throw new Error(`no token in ${PATCH} — set ACP_TOKEN or configure one`);
  return m[1];
}

const TOKEN = token();
const headers = { 'X-Secret-Key': TOKEN, 'content-type': 'application/json' };

/**
 * One connection, one stream, and a promise per request id.
 *
 * The stream is opened at `after=` the current head so history stays in the log
 * where it belongs. Ask for it deliberately with `watch --replay` if you want it.
 */
async function connect({ replay = false } = {}) {
  const init = await fetch(`${BASE}/acp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: 1, clientCapabilities: { _meta: { 'dsh-acp-control': { extensions: true } } } },
    }),
  });
  if (!init.ok) throw new Error(`initialize failed: HTTP ${init.status}`);
  const connection = init.headers.get('acp-connection-id');
  const info = await init.json();

  const cursor = replay ? 0 : 999999999;
  const stream = await fetch(`${BASE}/acp/stream?connection=${connection}&after=${cursor}`, {
    headers: { 'X-Secret-Key': TOKEN, accept: 'text/event-stream' },
  });

  const pending = new Map();
  const listeners = new Set();
  let next = 2;

  (async () => {
    const reader = stream.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        let msg;
        try { msg = JSON.parse(line.slice(5).trim()); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { resolve, reject } = pending.get(msg.id);
          pending.delete(msg.id);
          msg.error ? reject(Object.assign(new Error(msg.error.message), { rpc: msg.error })) : resolve(msg.result);
        }
        for (const fn of listeners) fn(msg);
      }
    }
  })().catch(() => {});

  const call = (method, params = {}) => {
    const id = next++;
    const done = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
    fetch(`${BASE}/acp`, {
      method: 'POST',
      headers: { ...headers, 'Acp-Connection-Id': connection },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    }).catch((e) => { pending.delete(id); throw e; });
    return done;
  };

  // Close the reader before exiting. process.exit() with a live SSE read in
  // flight makes libuv assert on Windows — after the output, so it looks like a
  // crash that isn't one, which is the worst kind of noise in a tool you trust.
  const close = async () => { try { await stream.body.cancel(); } catch {} };

  /**
   * Fire-and-forget, with NO id.
   *
   * `session/cancel` is a NOTIFICATION in ACP, and this plugin routes it only
   * from the notification path. Sending it with an id makes it a request, and
   * the request dispatcher answers `Method not found: session/cancel` — which
   * reads exactly like an unimplemented server and cost me a wrong diagnosis.
   * The id is the whole difference.
   */
  const notify = (method, params = {}) => fetch(`${BASE}/acp`, {
    method: 'POST',
    headers: { ...headers, 'Acp-Connection-Id': connection },
    body: JSON.stringify({ jsonrpc: '2.0', method, params }),
  });

  return { connection, info, call, notify, on: (fn) => listeners.add(fn), close };
}

/** Text out of a session/update, whatever shape this build wraps it in. */
const textOf = (u) => u?.content?.text ?? u?.text ?? (typeof u?.content === 'string' ? u.content : '');

const [cmd, ...rest] = process.argv.slice(2);

const commands = {
  async list() {
    const c = await connect();
    const { sessions = [] } = await c.call('session/list');
    for (const s of sessions) {
      const state = s._meta?.['dsh-acp-control']?.state ?? '';
      console.log(`${s.sessionId}  ${state.padEnd(12)}  ${s.title ?? ''}`);
    }
    console.log(`\n${sessions.length} sessions · backend ${c.info?._meta?.['dsh-acp-control']?.backend ?? '?'}`);
    await c.close();
    process.exit(0);
  },

  async state([id]) {
    const c = await connect();
    console.log(JSON.stringify(await c.call('_dsh/session/state', { sessionId: id }), null, 2));
    await c.close();
    process.exit(0);
  },

  async rename([id, ...title]) {
    const c = await connect();
    console.log(JSON.stringify(await c.call('_dsh/session/rename', { sessionId: id, title: title.join(' ') })));
    await c.close();
    process.exit(0);
  },

  async prompt([id, ...words]) {
    const c = await connect();
    let said = '';
    c.on((m) => { if (m.method === 'session/update') said += textOf(m.params?.update); });
    const result = await c.call('session/prompt', {
      sessionId: id, prompt: [{ type: 'text', text: words.join(' ') }],
    });
    console.log(said.trim());
    console.log(`\n[${result?.stopReason ?? 'no stopReason'}]`);
    process.exit(0);
  },

  async cancel([id]) {
    const c = await connect();
    // session/cancel is a notification in ACP: it has no reply, so awaiting one
    // hangs forever. Fire it, then read the state back as the confirmation —
    // the state machine is the authority on whether the turn actually stopped.
    await c.notify('session/cancel', { sessionId: id });
    await new Promise((r) => setTimeout(r, 1200));
    const s = await c.call('_dsh/session/state', { sessionId: id });
    console.log(`${id} -> ${s?.state ?? '?'}`);
    await c.close();
    process.exit(s?.state === 'generating' ? 1 : 0);
  },

  async steer([id, ...words]) {
    const c = await connect();
    const before = (await c.call('_dsh/session/state', { sessionId: id }))?.state;
    if (before === 'generating') {
      await c.notify('session/cancel', { sessionId: id });
      // Poll rather than sleep a guessed interval: a cancelled turn takes as
      // long as it takes, and prompting into a session that has not yet
      // released is refused rather than queued.
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const s = (await c.call('_dsh/session/state', { sessionId: id }))?.state;
        if (s !== 'generating') break;
      }
    }
    const state = (await c.call('_dsh/session/state', { sessionId: id }))?.state;
    if (state === 'generating') {
      console.log(`REFUSED: ${id} is still generating — not prompting over a live turn`);
      await c.close();
      process.exit(1);
    }
    console.log(`[${before} -> ${state}] steering`);
    let said = '';
    c.on((m) => { if (m.method === 'session/update') said += textOf(m.params?.update); });
    const r = await c.call('session/prompt', {
      sessionId: id, prompt: [{ type: 'text', text: words.join(' ') }],
    });
    console.log(said.trim());
    console.log(`
[${r?.stopReason ?? 'no stopReason'}]`);
    process.exit(0);
  },

  async watch([id]) {
    const c = await connect();
    console.log(`watching${id ? ' ' + id : ' everything'} — Ctrl+C to stop`);
    c.on((m) => {
      if (id && m.params?.sessionId && m.params.sessionId !== id) return;
      if (m.method === 'session/update') process.stdout.write(textOf(m.params?.update));
      else if (m.method) console.log(`\n· ${m.method} ${JSON.stringify(m.params ?? {}).slice(0, 160)}`);
    });
  },

  async new([cwd, ...words]) {
    const c = await connect();
    const { sessionId } = await c.call('session/new', { cwd, mcpServers: [] });
    console.log(`created ${sessionId}`);
    if (!words.length) process.exit(0);
    let said = '';
    c.on((m) => { if (m.method === 'session/update') said += textOf(m.params?.update); });
    const r = await c.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: words.join(' ') }] });
    console.log(said.trim());
    console.log(`\n[${r?.stopReason ?? 'no stopReason'}]`);
    process.exit(0);
  },
};

if (!commands[cmd]) {
  console.log('usage: acp.mjs list | state | rename | prompt | cancel | steer | watch | new');
  process.exit(2);
}
await commands[cmd](rest);
