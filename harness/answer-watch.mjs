// Knowing when an answer is actually finished.
//
// THE PROBLEM
//
// An agent driving a chat surface — the DSH Web GUI, or a browser reviewer tab —
// has to answer one question over and over: is the reply done? Getting it wrong
// is not a small error. Read too early and you act on half an answer, or on no
// answer at all, and everything downstream is built on it.
//
// The tempting check is the one that does not work:
//
//   const done = !stopButton;          // wrong
//
// A missing stop control is ALSO what the page looks like before generation
// starts, during the gap between submitting and the first token, and while a
// reasoning model sits silent for minutes. Absence of a running indicator is
// never evidence of completion.
//
// WHAT THIS ENFORCES INSTEAD
//
// Both edges. Latch that the indicator APPEARED, then wait for it to GO, then
// require the page to hold still before reading. Three conditions, in order:
//
//   saw it start  ->  it stopped  ->  nothing changed for `quietMs`
//
// A run that never starts returns `not-started` rather than a confident empty
// answer. A run that stops and then resumes — which happens, tool calls do this
// — re-arms rather than reporting done at the first pause.
//
// WHY POLLING AND NOT ONE LONG WAIT
//
// A page-context evaluation is capped (45s through the browser tool this was
// written for), so a single in-page `await` covering a thirty-minute answer is
// not available: the call is killed and the promise is lost. So the watcher is
// SPLIT. `arm()` records the starting state on `window`, and each later `poll()`
// returns in milliseconds with a verdict. The caller polls across separate
// evaluations at whatever cadence it likes, and no state lives in the caller.
//
// This is why the file is written as source to inject rather than a module to
// import: it has to survive on the page between calls.
//
// FAILURE MODES IT REPORTS RATHER THAN HIDES
//
//   not-started    the prompt never visibly went; do not read an answer
//   message-limit  the conversation is full; this tab is finished, start another
//   blocked        an A/B experiment is asking which response is preferred
//   error          a delivery timeout with a retry control, not a real answer
//   running        still going, keep polling; NOT a failure
//   finished       both edges seen and the page held still
//
// `running` is the important one. A watcher that cannot say "still working"
// ends up guessing, and guessing is the whole problem.

/** Surface definitions. Selectors are what the pages actually render, not contracts. */
export const SURFACES = {
  dsh: {
    busy: 'button[aria-label="Stop generating"]',
    // Measured against the live page, not guessed: the finished reply of a turn
    // is the element carrying data-turn-process-answer. Class names here are
    // hashed per build (_markdown_kcgor_5, Sixlwa_bubble) so matching on them
    // breaks at the next release; the data attribute is stable and semantic.
    answer: '[data-turn-process-answer="true"]',
    limit: null,
  },
  chatgpt: {
    busy: 'button[aria-label="Stop answering"], button[aria-label="Stop thinking"]',
    answer: '[data-message-author-role="assistant"]',
    limit: /(?:you(?:'|’)ve reached the maximum length for this conversation|chat session has reached message limits)/i,
  },
};

/**
 * The page-resident half, as source.
 *
 * Inject once per tab, then call `__answerWatch.arm()` before sending and
 * `__answerWatch.poll()` afterwards. Both return plain JSON.
 */
export const PAGE_SOURCE = String.raw`
(() => {
  const LIMIT = /(?:you(?:'|’)ve reached the maximum length for this conversation|chat session has reached message limits)/i;
  const BLOCKED = /giving feedback on a new version|which response do you prefer/i;
  const RETRYABLE = /message delivery timed out|something went wrong.{0,40}try again/i;

  const surfaces = {
    dsh: {
      busy: 'button[aria-label="Stop generating"]',
      answer: '[data-turn-process-answer="true"]',
      limit: false,
    },
    chatgpt: {
      busy: 'button[aria-label="Stop answering"], button[aria-label="Stop thinking"]',
      answer: '[data-message-author-role="assistant"]',
      limit: true,
    },
  };

  const detect = () =>
    location.hostname.endsWith('chatgpt.com') ? 'chatgpt'
      : (location.port === '3099' || /harness/i.test(document.title)) ? 'dsh'
      : null;

  const surface = () => {
    const name = detect();
    if (!name) throw new Error('answer-watch: unknown surface');
    return { name, ...surfaces[name] };
  };

  const busy = (s) => document.querySelectorAll(s.busy).length > 0;

  /**
   * The latest answer, or null when the selector matches nothing.
   *
   * Null rather than a fallback slice of the body. A fallback felt harmless and
   * was not: document.body.innerText.slice(-3000) is ALWAYS 3000 characters, so
   * the "has the text stopped changing" test compared 3000 to 3000 forever and
   * the watcher sat in settling and never reported finished. A detector that
   * cannot find the answer must say so, not substitute something stable-looking.
   */
  const answer = (s) => {
    const all = [...document.querySelectorAll(s.answer)];
    return all.length ? all[all.length - 1].innerText : null;
  };

  /**
   * Record the pre-send state. Everything after is measured against this, so a
   * pre-existing answer in the tab is never mistaken for the new one.
   */
  function arm() {
    const s = surface();
    window.__answerWatch = {
      surface: s.name,
      armedAt: Date.now(),
      baselineAnswer: answer(s),
      sawBusy: false,
      stillSince: 0,
      lastChars: -1,
    };
    const baseline = window.__answerWatch.baselineAnswer;
    return {
      armed: true,
      surface: s.name,
      baselineChars: baseline === null ? null : baseline.length,
      answerNodeFound: baseline !== null,
    };
  }

  /**
   * One cheap verdict. Returns in milliseconds; call it as often as you like.
   *
   * quietMs is the stillness required AFTER the indicator clears. Tool calls
   * make the indicator flicker, so a pause alone is not the end of a turn.
   */
  function poll({ quietMs = 4000, startGraceMs = 45000 } = {}) {
    const w = window.__answerWatch;
    if (!w) return { status: 'not-armed' };
    const s = surface();
    const body = document.body.innerText;
    const now = Date.now();
    const text = answer(s);

    if (s.limit && LIMIT.test(body)) return { status: 'message-limit', chars: text ? text.length : 0 };
    if (BLOCKED.test(body)) return { status: 'blocked', chars: text ? text.length : 0 };

    const running = busy(s);
    w.sawBusy = w.sawBusy || running;

    if (!w.sawBusy) {
      // Nothing has started. Only call that a failure once the grace has passed,
      // because the gap between clicking send and the first token is real.
      return now - w.armedAt > startGraceMs
        ? { status: 'not-started', elapsedMs: now - w.armedAt }
        : { status: 'starting', elapsedMs: now - w.armedAt };
    }

    if (running) {
      w.stillSince = 0;
      w.lastChars = text === null ? -1 : text.length;
      return { status: 'running', chars: text === null ? null : text.length, elapsedMs: now - w.armedAt };
    }

    // Not running, and the answer node cannot be found. The turn is over but
    // this watcher cannot read its result, which is a broken selector, not a
    // finished answer. Say which selector failed so it is fixable.
    if (text === null) {
      return { status: 'no-answer-node', selector: s.answer, elapsedMs: now - w.armedAt };
    }

    // Indicator gone. Require the text to stop moving too — a tool call between
    // two bursts looks exactly like an ending otherwise.
    if (text.length !== w.lastChars) {
      w.lastChars = text.length;
      w.stillSince = now;
      return { status: 'running', chars: text.length, elapsedMs: now - w.armedAt };
    }
    if (!w.stillSince) w.stillSince = now;
    if (now - w.stillSince < quietMs) {
      return { status: 'settling', chars: text.length, elapsedMs: now - w.armedAt };
    }

    if (RETRYABLE.test(body) && text.length < 400) {
      return { status: 'error', chars: text.length, elapsedMs: now - w.armedAt };
    }
    if (!text || text === w.baselineAnswer) {
      // Settled with nothing new. Keep waiting rather than returning an empty
      // answer as a success.
      w.sawBusy = false;
      w.stillSince = 0;
      return { status: 'starting', elapsedMs: now - w.armedAt };
    }
    return { status: 'finished', chars: text.length, elapsedMs: now - w.armedAt };
  }

  function read() {
    return answer(surface());
  }

  window.__answerWatch = window.__answerWatch || null;
  window.answerWatch = { arm, poll, read, surface: () => surface().name };
  return 'answer-watch ready';
})()
`;

/** Suggested cadence: cheap enough to be frequent, slow enough not to spam. */
export const POLL_INTERVAL_MS = 5000;

/**
 * A verdict that means "stop polling".
 *
 * `running`, `starting` and `settling` are all keep-going. Everything else is
 * terminal, including the failures — a caller that only stops on `finished`
 * will poll forever through a message-limit.
 */
export function isTerminal(status) {
  return !['running', 'starting', 'settling', 'not-armed'].includes(status);
}
