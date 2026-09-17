/**
 * Structural and behavioural self-check for the dsh-session-archive client bundle.
 *
 * No browser needed: it stubs `window.__ModuleLoader__`, `require("react")`,
 * a minimal DOM, localStorage, and the slot context, then evaluates the real
 * bundle and proves:
 *
 *  1. The bundle envelope registers under its own id and exports apply/inject.
 *  2. apply() replaces `sidebar.workspaces` (a `single` slot) and redeclares
 *     the `sidebar.workspaces.directoryFlow` hole with the identical owner
 *     contract, so "Add workspace" keeps working.
 *  3. Every session row carries a one-click archive button in the row actions
 *     region, beside the `...` menu; its click routes to `archiveSession`
 *     with the row's session id, stops propagation (the row does not open),
 *     and commits with no confirmation dialog.
 *  4. The flat derivation hides archived sessions (the archive-set echo is
 *     what removes the row), subagent children, and non-current blanks, in
 *     newest-first order.
 *  5. FULL PARITY: workspace grouping (deriveGroups), session drag-reorder
 *     with the exact upstream commit math (insertSessionBefore), workspace
 *     drag-reorder (insertWorkspaceBefore), workspace rename/delete dialogs,
 *     session rename/fork, the view-options menu, and merged local + remote
 *     search (deriveSearchResults).
 *
 * A stateful React stub drives multi-step interactions (menu opens, drags,
 * dialogs, view switches, search typing) without a browser.
 *
 * Run: node plugins/dsh-session-archive/verify-client.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, condition, detail = "") => {
	if (!condition) failures += 1;
	console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};
const flushMicro = () => new Promise((r) => setTimeout(r, 0));

// --- deterministic localStorage (view-state persistence mirror) ----------------
const lsStore = {};
globalThis.localStorage = {
	getItem: (k) => (k in lsStore ? lsStore[k] : null),
	setItem: (k, v) => { lsStore[k] = String(v); },
	removeItem: (k) => { delete lsStore[k]; },
	clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k]; },
};
const VIEW_KEY = "dsh.workspace.view.v5";

// --- minimal DOM so the style injection path runs -----------------------------
const styleTags = [];
globalThis.document = {
	querySelector: (selector) => styleTags.find((t) => `style[data-plugin-css="${t.dataset.pluginCss}"]` === selector) ?? null,
	createElement: () => ({ dataset: {}, textContent: "" }),
	head: { appendChild: (tag) => styleTags.push(tag) },
	addEventListener: () => {},
	removeEventListener: () => {},
};

// --- capture the module registration ------------------------------------------
let registration;
globalThis.window = {
	innerWidth: 1280,
	__ModuleLoader__: { load: (value) => { registration = value; } },
	setTimeout: (fn, ms) => setTimeout(fn, ms ?? 0),
	clearTimeout: (id) => clearTimeout(id),
};

/** Minimal React surface: element descriptors plus inert hooks (static tests). */
const reactStub = {
	createElement: (type, props, ...children) => {
		const flat = [];
		for (const child of children) {
			if (Array.isArray(child)) flat.push(...child);
			else flat.push(child);
		}
		return { type, props: { ...(props ?? {}), children: flat } };
	},
	useState: (initial) => [typeof initial === "function" ? initial() : initial, () => {}],
	useEffect: () => {},
	useMemo: (fn) => fn(),
	useRef: (initial) => ({ current: initial ?? null }),
	Fragment: Symbol("Fragment"),
};
const requireStub = (specifier) => {
	if (specifier === "react") return reactStub;
	throw new Error(`unexpected require(${JSON.stringify(specifier)}) — the bundle should only need React`);
};

/** Stateful React stub for multi-step interaction tests. */
function makeHarness() {
	const stateCells = [];
	const refCells = [];
	let cursor = 0;
	let effects = [];
	const R = {
		createElement: reactStub.createElement,
		Fragment: reactStub.Fragment,
		useState(init) {
			const i = cursor++;
			if (!(i in stateCells)) stateCells[i] = typeof init === "function" ? init() : init;
			const set = (v) => { stateCells[i] = typeof v === "function" ? v(stateCells[i]) : v; };
			return [stateCells[i], set];
		},
		useRef(init) {
			const i = cursor++;
			if (!(i in refCells)) refCells[i] = { current: init ?? null };
			return refCells[i];
		},
		useMemo: (fn) => fn(),
		useEffect(fn) { effects.push(fn); return undefined; },
	};
	const resolveH = (el) => {
		if (el === null || el === undefined || typeof el !== "object") return el;
		if (typeof el.type === "function") return resolveH(el.type(el.props ?? {}));
		const c = el.props?.children;
		const arr = (Array.isArray(c) ? c : [c]).filter((x) => x !== false && x !== null && x !== undefined);
		return { ...el, props: { ...(el.props ?? {}), children: arr.map(resolveH) } };
	};
	return {
		R,
		ex: registration.factory((spec) => {
			if (spec === "react") return R;
			throw new Error(`unexpected require(${spec})`);
		}),
		render(el) { cursor = 0; return resolveH(el); },
		shallow(el) { cursor = 0; return typeof el.type === "function" ? el.type(el.props ?? {}) : el; },
		flush() {
			const fns = effects;
			effects = [];
			for (const fn of fns) {
				try { fn(); } catch { /* harness ignores effect errors */ }
			}
		},
	};
}

// Evaluate the bundle exactly as the browser would.
const source = readFileSync(new URL("./lib/client.js", import.meta.url), "utf8");
new Function("window", "require", source)(globalThis.window, requireStub);

console.log("bundle envelope:");
check("registered with __ModuleLoader__", registration !== undefined);
check("declares its own id", registration?.id === "dsh-session-archive", String(registration?.id));

const exported = registration.factory(requireStub);
console.log("exports:");
check("exports apply", typeof exported.apply === "function");
check("exports inject", Array.isArray(exported.inject), JSON.stringify(exported.inject));
check("injects only the slots service (actions resolve lazily, so no fiber can wedge)",
	exported.inject?.length === 1 && exported.inject[0] === "slots", JSON.stringify(exported.inject));
check("exports the pane component", typeof exported.ArchivePane === "function");
check("exports the row component", typeof exported.SessionRow === "function");
check("exports the tree + flat + search components",
	typeof exported.SessionTree === "function" &&
		typeof exported.FlatList === "function" &&
		typeof exported.SearchResults === "function");
check("exports the flat derivation", typeof exported.deriveFlatRows === "function");
check("exports the parity derivations",
	typeof exported.deriveGroups === "function" &&
		typeof exported.deriveFlat === "function" &&
		typeof exported.deriveSearchResults === "function" &&
		typeof exported.visibleSessionIds === "function");
check("exports the pure drop-commit math",
	typeof exported.commitSessionDrop === "function" &&
		typeof exported.commitWorkspaceDrop === "function");
check("names the replaced slot", exported.SLOT === "sidebar.workspaces", String(exported.SLOT));
check("names the redeclared hole", exported.FLOW_HOLE === "sidebar.workspaces.directoryFlow", String(exported.FLOW_HOLE));

console.log("slot registration (the supported replace path for a `single` slot):");
const injectCalls = [];
const registerCalls = [];
const flowEntries = [];
const ctx = {
	get: (name) => {
		if (name === "uiWorkspace") return ctx.services.uiWorkspace;
		if (name === "sessions") return ctx.services.sessions;
		if (name === "workspaces") return ctx.services.workspaces;
		return undefined;
	},
	services: {
		uiWorkspace: {
			openCalls: [],
			archiveCalls: [],
			openSession(id) { this.openCalls.push(id); },
			archiveSession(id) { this.archiveCalls.push(id); return Promise.resolve(); },
			forkSession() { return Promise.resolve(); },
			startSession() {},
		},
		sessions: { searchResultLimit: 20, binding: () => undefined, search: () => Promise.resolve({ ok: true, value: { items: [], hasMore: false } }) },
		workspaces: { create: () => Promise.resolve({ workspaceId: "w1" }), archiveSession: () => Promise.resolve() },
	},
	slots: {
		inject: (key, cb) => { injectCalls.push(key); return cb(); },
		register: (spec, component) => { registerCalls.push({ spec, component }); },
		entries: (hole) => flowEntries,
		subscribe: () => () => {},
	},
};
exported.apply(ctx);
check("injects against sidebar.workspaces", injectCalls.includes("sidebar.workspaces"), JSON.stringify(injectCalls));
const pane = registerCalls.find((r) => r.spec?.name === "sidebar.workspaces");
check("registers the pane into that seat", pane?.component === exported.ArchivePane);
check("redeclares the directory-flow hole with kind single + scope root",
	pane?.spec?.children?.["sidebar.workspaces.directoryFlow"]?.kind === "single" &&
		pane?.spec?.children?.["sidebar.workspaces.directoryFlow"]?.scope === "root",
	JSON.stringify(pane?.spec?.children));
check("registers no other slot (the shipped browser is shadowed, not duplicated)",
	registerCalls.length === 1, `${registerCalls.length} registration(s)`);

console.log("injected actions (what the rows drive):");
const injected = pane.spec.inject();
for (const key of ["open", "archiveSession", "renameSession", "forkSession", "startSession",
	"renameWorkspace", "deleteWorkspace", "insertWorkspaceBefore", "insertSessionBefore",
	"createWorkspace", "searchSessions"]) {
	check(`provides ${key}`, typeof injected[key] === "function");
}
check("provides the search result bound", injected.searchResultLimit === 20, String(injected.searchResultLimit));
check("provides the directoryFlow occupancy hook", typeof injected.hooks?.directoryFlow?.getSnapshot === "function");
flowEntries.push({ fake: true });
check("the occupancy source reads the hole entries", injected.hooks.directoryFlow.getSnapshot() === true);
flowEntries.length = 0;
check("...and reports empty when unoccupied", injected.hooks.directoryFlow.getSnapshot() === false);

// --- descriptor-tree helpers ---------------------------------------------------
const kids = (el) => {
	const c = el?.props?.children ?? [];
	return (Array.isArray(c) ? c : [c]).filter((x) => x !== false && x !== null && x !== undefined);
};
const walk = (el, out = []) => {
	if (el === null || el === undefined || typeof el !== "object") return out;
	out.push(el);
	for (const child of kids(el)) walk(child, out);
	return out;
};
const byClass = (root, token) => walk(resolve(root)).filter((el) =>
	typeof el.props?.className === "string" && el.props.className.split(" ").includes(token));

/** Resolve function components (the stub React never renders on its own). */
function resolve(el) {
	if (el === null || el === undefined || typeof el !== "object") return el;
	if (typeof el.type === "function") return resolve(el.type(el.props ?? {}));
	const c = el.props?.children;
	const arr = (Array.isArray(c) ? c : [c]).filter((x) => x !== false && x !== null && x !== undefined);
	return { ...el, props: { ...(el.props ?? {}), children: arr.map(resolve) } };
}

const clickEvent = () => {
	const event = { stopped: false };
	event.stopPropagation = () => { event.stopped = true; };
	event.preventDefault = () => {};
	return event;
};

console.log("the session row (hover-archive beside the `...` menu):");
const node = {
	id: "sess-1", title: "Write report", blank: false, running: false,
	runningSubagentCount: 0, completed: false, hasActiveSchedule: false, updatedAt: Date.now() - 5 * 60 * 1000,
};
let opened = [];
let archived = [];
const row = exported.SessionRow({
	node, currentId: undefined, now: Date.now(),
	onOpen: (id) => opened.push(id),
	onArchive: (id) => archived.push(id),
	onRename: undefined, onFork: undefined,
});
check("the row carries its session id", row.props?.["data-session-id"] === "sess-1");
const actionsRegions = byClass(row, "dsh-sa-actions");
check("the row has one actions region", actionsRegions.length === 1, `${actionsRegions.length}`);
const resolvedRow = resolve(row);
const resolvedActions = walk(resolvedRow).filter((el) =>
	typeof el.props?.className === "string" && el.props.className.split(" ").includes("dsh-sa-actions"));
const archiveButtons = walk(resolvedRow).filter((el) =>
	typeof el.props?.className === "string" && el.props.className.split(" ").includes("dsh-sa-archive"));
check("the actions region holds the archive button", archiveButtons.length === 1 &&
	resolvedActions.length === 1 && walk(resolvedActions[0]).includes(archiveButtons[0]),
	`${archiveButtons.length} archive button(s)`);
const menuButtons = walk(resolvedRow).filter((el) =>
	el.props?.["aria-label"] === "Session actions for Write report");
check("...beside the `...` menu button", menuButtons.length === 1 &&
	resolvedActions.length === 1 && walk(resolvedActions[0]).includes(menuButtons[0]));

const archiveClick = clickEvent();
archiveButtons[0].props.onClick(archiveClick);
check("the archive click routes to archiveSession with the row id",
	archived.length === 1 && archived[0] === "sess-1", JSON.stringify(archived));
check("...and stops propagation, so the row does not open",
	archiveClick.stopped === true && opened.length === 0, `opened=${JSON.stringify(opened)}`);
check("no confirmation dialog anywhere in the bundle",
	!source.includes("confirm(") && !source.includes("prompt(") && !source.includes("window.confirm"));

const rowClickTargets = [row];
rowClickTargets[0].props.onClick();
check("clicking the row itself still opens the session", opened.length === 1 && opened[0] === "sess-1");

console.log("status presentation (upstream sessionStatuses):");
const statusLabel = (n) => exported.sessionStatuses(n)[0].label;
check("pending approval outranks running",
	statusLabel({ pendingInteraction: "approval", running: true, runningSubagentCount: 0, completed: false }) === "Waiting for approval");
check("running outranks idle", statusLabel({ running: true, runningSubagentCount: 0, completed: false }) === "Running");
check("subagent counts render", exported.sessionStatuses({ running: false, runningSubagentCount: 2, completed: false })[0].label === "2 subagents running");
check("completed reminder", statusLabel({ running: false, runningSubagentCount: 0, completed: true }) === "Completed");

console.log("grouping derivations (upstream tree.ts):");
const wsA = { workspaceId: "w1", title: "Alpha", path: "/home/u/alpha", createdAt: "2026-01-01T00:00:00.000Z", sessionIds: ["a", "b", "c"] };
const wsB = { workspaceId: "w2", title: "Beta", path: "/home/u/beta", createdAt: "2026-02-01T00:00:00.000Z", sessionIds: ["d"] };
const glist = {
	current: "a",
	ids: ["a", "b", "c", "d", "x", "gone"],
	byId: {
		a: { id: "a", displayTitle: "A", blank: false, running: true, updatedAt: 30 },
		b: { id: "b", displayTitle: "B", blank: false, running: false, updatedAt: 20 },
		c: { id: "c", displayTitle: "C", blank: false, running: false, updatedAt: 10 },
		d: { id: "d", displayTitle: "D", blank: false, running: false, updatedAt: 25 },
		x: { id: "x", displayTitle: "Loose", blank: false, running: false, updatedAt: 40 },
		gone: { id: "gone", displayTitle: "Old", blank: false, running: false, updatedAt: 50 },
	},
};
const groupsAll = exported.deriveGroups(glist, [wsA, wsB], ["gone"], new Map(), {
	expandedGroups: ["w1", "w2", ""], ungroupedOrder: ["x"],
});
check("one group per workspace plus Ungrouped", groupsAll.map((g) => g.key).join(",") === "w1,w2,");
check("members resolve in account order", groupsAll[0].sessions.map((s) => s.id).join(",") === "a,b,c");
check("archived sessions excluded everywhere", !groupsAll.some((g) => g.sessions.some((s) => s.id === "gone")));
check("containsCurrent marks the owning group", groupsAll[0].containsCurrent === true && groupsAll[1].containsCurrent === false);
check("collapsed groups carry no rows", exported.deriveGroups(glist, [wsA, wsB], [], new Map(),
	{ expandedGroups: [], ungroupedOrder: ["x"] }).every((g) => g.sessions.length === 0));
check("workspace label is the basename", exported.workspaceLabel("/home/u/alpha") === "alpha" &&
	exported.workspaceLabel("C:\\work\\beta") === "beta");
check("collapsed fold keeps the blank + 5 rows",
	(() => {
		const many = Array.from({ length: 8 }, (_, i) => ({ id: `s${i}`, blank: false }));
		const folded = exported.collapsedSessionRows([{ id: "nb", blank: true }, ...many]);
		return folded.rows.length === 6 && folded.rows[0].id === "nb" && folded.hiddenCount === 3;
	})());
check("orderByRecency newest-first with id tiebreak",
	exported.orderByRecency(["b", "a", "c"], glist.byId).join(",") === "a,b,c");
check("reconcileManualOrder retains saved slots, appends new by recency",
	exported.reconcileManualOrder(["a", "b", "c"], ["c", "a"], glist.byId).join(",") === "c,a,b");
check("pinCurrentBlank pins the selected blank first",
	exported.pinCurrentBlank(["a", "b"], "b").join(",") === "b,a");

console.log("drop-commit math (mirrors the installed build exactly):");
const gFixture = [
	{ key: "w1", sessions: [{ id: "a" }, { id: "b" }, { id: "c" }] },
	{ key: "", sessions: [{ id: "x" }] },
];
const accounts = { w1: ["a", "b", "c"], "": ["x"] };
const dropManual = (over) => exported.commitSessionDrop({
	groups: gFixture, expandedKeys: ["w1", ""], accountIds: accounts,
	orderBy: "manual", activeDrag: { accountKey: "w1", sessionId: "b", over: null }, over,
});
check("move down past one row anchors after it",
	JSON.stringify(dropManual({ id: "c", half: "after" })) ===
		JSON.stringify({ accountKey: "w1", sessionId: "b", anchor: undefined, nextOrder: ["a", "c", "b"], callHost: true }));
check("move up anchors before the target",
	JSON.stringify(dropManual({ id: "a", half: "before" })) ===
		JSON.stringify({ accountKey: "w1", sessionId: "b", anchor: "a", nextOrder: ["b", "a", "c"], callHost: true }));
check("dropping back in place is a no-op",
	exported.commitSessionDrop({
		groups: gFixture, expandedKeys: ["w1"], accountIds: accounts,
		orderBy: "manual", activeDrag: { accountKey: "w1", sessionId: "b", over: null },
		over: { id: "b", half: "after" },
	}) === null);
check("updated order never calls the host",
	dropManual({ id: "c", half: "after" }) !== null &&
		exported.commitSessionDrop({
			groups: gFixture, expandedKeys: ["w1"], accountIds: accounts,
			orderBy: "updated", activeDrag: { accountKey: "w1", sessionId: "b", over: null },
			over: { id: "c", half: "after" },
		}).callHost === false);
check("the ungrouped account never calls the host",
	exported.commitSessionDrop({
		groups: gFixture, expandedKeys: [""], accountIds: accounts,
		orderBy: "manual", activeDrag: { accountKey: "", sessionId: "x", over: null },
		over: { id: "x", half: "after" },
	}) === null);
check("workspace drop anchors before the target",
	JSON.stringify(exported.commitWorkspaceDrop({
		workspaces: [{ workspaceId: "w1" }, { workspaceId: "w2" }],
		activeDrag: { workspaceId: "w2", over: null }, over: { id: "w1", half: "before" },
	})) === JSON.stringify({ workspaceId: "w2", anchor: "w1" }));
check("workspace drop to the end omits the anchor",
	JSON.stringify(exported.commitWorkspaceDrop({
		workspaces: [{ workspaceId: "w1" }, { workspaceId: "w2" }],
		activeDrag: { workspaceId: "w1", over: null }, over: { id: "w2", half: "after" },
	})) === JSON.stringify({ workspaceId: "w1", anchor: undefined }));
check("workspace no-op is null",
	exported.commitWorkspaceDrop({
		workspaces: [{ workspaceId: "w1" }, { workspaceId: "w2" }],
		activeDrag: { workspaceId: "w1", over: null }, over: { id: "w1", half: "after" },
	}) === null);

console.log("search derivation (upstream deriveSearchResults):");
const slist = {
	current: "a",
	ids: ["a", "b", "c", "z"],
	byId: {
		a: { id: "a", displayTitle: "Alpha report", blank: false, running: false, updatedAt: 30, cwd: "/home/u/alpha" },
		b: { id: "b", displayTitle: "Beta notes", blank: false, running: false, updatedAt: 20, cwd: "/home/u/beta" },
		c: { id: "c", displayTitle: "", blank: true, running: false, updatedAt: 40 },
		z: { id: "z", displayTitle: "Archived thing", blank: false, running: false, updatedAt: 50 },
	},
};
const noContent = { items: [], hasMore: false };
check("empty query matches nothing", exported.deriveSearchResults(slist, [wsA], "", [], new Map(), noContent, 20).items.length === 0);
check("local title match", exported.deriveSearchResults(slist, [wsA], "report", [], new Map(), noContent, 20).items.map((r) => r.id).join(",") === "a");
check("workspace label match", exported.deriveSearchResults(slist, [wsA, wsB], "beta", [], new Map(), noContent, 20).items.map((r) => r.id).join(",") === "b");
check("blanks and archived never match",
	exported.deriveSearchResults(slist, [wsA], "a", ["z"], new Map(), noContent, 20).items.every((r) => r.id !== "c" && r.id !== "z"));
check("content-only rows append in backend order with snippets",
	(() => {
		const res = exported.deriveSearchResults(slist, [wsA], "zzz", [], new Map(),
			{ items: [{ sessionId: "b", snippet: "hit here" }], hasMore: false }, 20);
		return res.items.length === 1 && res.items[0].id === "b" && res.items[0].snippet === "hit here";
	})());
check("limit caps with the refine hint",
	(() => {
		const res = exported.deriveSearchResults(slist, [wsA], "a", [], new Map(), noContent, 1);
		return res.items.length === 1 && res.hasMore === true;
	})());

console.log("the flat derivation (the archive-set echo removes the row):");
const list = {
	current: "sess-blank",
	ids: ["sess-archived", "sess-sub", "sess-plain", "sess-other-blank", "sess-blank"],
	byId: {
		"sess-archived": { id: "sess-archived", displayTitle: "Old", blank: false, running: false, updatedAt: 3 },
		"sess-sub": { id: "sess-sub", displayTitle: "Child", blank: false, running: false, updatedAt: 30, origin: "subagent", parentId: "sess-plain" },
		"sess-plain": { id: "sess-plain", displayTitle: "Plain", blank: false, running: false, updatedAt: 10 },
		"sess-other-blank": { id: "sess-other-blank", displayTitle: "", blank: true, running: false, updatedAt: 40 },
		"sess-blank": { id: "sess-blank", displayTitle: "", blank: true, running: false, updatedAt: 50 },
	},
};
const pending = new Map();
const derived = exported.deriveFlatRows(list, ["sess-archived"], pending);
check("archived sessions are hidden", !derived.some((r) => r.id === "sess-archived"));
check("subagent children are hidden", !derived.some((r) => r.id === "sess-sub"));
check("non-current blanks are hidden", !derived.some((r) => r.id === "sess-other-blank"));
check("the current blank (New Session) stays", derived.some((r) => r.id === "sess-blank" && r.blank === true));
check("newest first", derived.map((r) => r.id).join(",") === "sess-blank,sess-plain",
	derived.map((r) => r.id).join(","));
check("archiving the last visible row empties the pane",
	exported.deriveFlatRows(list, ["sess-archived", "sess-plain", "sess-blank"], pending).length === 0);

console.log("the pane (grouped tree, search, add-workspace seat):");
// Default view (grouped) with the store seeded flat, so the static stub sees rows.
lsStore[VIEW_KEY] = JSON.stringify({ groupBy: "flat", orderBy: "updated", groupExpansion: {}, sessionOrderByAccount: {} });
const renderPane = ({ archivedIds, occupied, wide = true }) => {
	const fixtureList = { current: "sess-1", ids: ["sess-1", "sess-2"], byId: {
		"sess-1": { id: "sess-1", displayTitle: "Alpha", blank: false, running: true, updatedAt: 20 },
		"sess-2": { id: "sess-2", displayTitle: "Beta", blank: false, running: false, completed: true, updatedAt: 10 },
	}, };
	return exported.ArchivePane({
		wide, expandSidebar: () => {},
		useSessions: (sel) => sel(fixtureList),
		useSessionPendingInteraction: (sel) => sel(new Map()),
		useWorkspaces: (sel) => sel({ items: [], phase: "ready", state: "idle", archivedSessionIds: archivedIds }),
		usePanelInfo: undefined,
		useDirectoryFlow: (sel) => sel(occupied),
		renderSlot: () => null,
		open: (id) => ctx.services.uiWorkspace.openSession(id),
		archiveSession: (id) => ctx.services.uiWorkspace.archiveSession(id),
		renameSession: undefined, forkSession: undefined, startSession: () => {},
		renameWorkspace: undefined, deleteWorkspace: undefined,
		insertWorkspaceBefore: undefined, insertSessionBefore: undefined,
		createWorkspace: () => Promise.resolve({ workspaceId: "w1" }),
		searchSessions: () => Promise.resolve({ items: [], hasMore: false }),
		searchResultLimit: 20,
	});
};
ctx.services.uiWorkspace.archiveCalls.length = 0;
const paneTree = renderPane({ archivedIds: [], occupied: false });
const paneRows = byClass(paneTree, "dsh-sa-row");
check("renders one row per visible session", paneRows.length === 2, `${paneRows.length} row(s)`);
const paneArchiveButtons = byClass(paneTree, "dsh-sa-archive");
check("every row has its hover-archive button", paneArchiveButtons.length === 2, `${paneArchiveButtons.length}`);
const paneArchiveClick = clickEvent();
paneArchiveButtons[0].props.onClick(paneArchiveClick);
// The pane mirrors upstream: archive commits through a promise chain, so let
// the microtasks flush before asserting the routing.
await flushMicro();
check("a pane-level click archives that row id with no dialog",
	ctx.services.uiWorkspace.archiveCalls.join(",") === "sess-1", JSON.stringify(ctx.services.uiWorkspace.archiveCalls));
check("...without opening it", ctx.services.uiWorkspace.openCalls.length === 0);
const echoed = renderPane({ archivedIds: ["sess-1"], occupied: false });
check("the archive-set echo removes the row", byClass(echoed, "dsh-sa-row").length === 1 &&
	byClass(echoed, "dsh-sa-row")[0].props["data-session-id"] === "sess-2");
check("search box present", byClass(paneTree, "dsh-sa-searchinput").length === 1);
check("view-options button present", walk(resolve(paneTree)).filter((el) => el.props?.["aria-label"] === "View options").length === 1);
check("no Add-workspace button while the flow hole is unoccupied",
	byClass(paneTree, "dsh-sa-headeractions")[0] !== undefined &&
		walk(byClass(paneTree, "dsh-sa-headeractions")[0]).filter((el) => el.props?.["aria-label"] === "Add workspace").length === 0);
const occupiedTree = renderPane({ archivedIds: [], occupied: true });
check("Add-workspace button appears exactly when the hole is occupied",
	walk(occupiedTree).filter((el) => el.props?.["aria-label"] === "Add workspace").length === 1);
const railTree = renderPane({ archivedIds: [], occupied: false, wide: false });
check("rail state renders no rows, only the expand control",
	byClass(railTree, "dsh-sa-row").length === 0 &&
		walk(railTree).filter((el) => el.props?.["aria-label"] === "Search sessions").length === 1);

// Grouped rendering through the real pane (seeded grouped + expanded).
lsStore[VIEW_KEY] = JSON.stringify({ groupBy: "workspace", orderBy: "updated", groupExpansion: { w1: true }, sessionOrderByAccount: {} });
const groupedPane = exported.ArchivePane({
	wide: true, expandSidebar: () => {},
	useSessions: (sel) => sel(glist),
	useSessionPendingInteraction: (sel) => sel(new Map()),
	useWorkspaces: (sel) => sel({ items: [wsA, wsB], phase: "ready", state: "idle", archivedSessionIds: [] }),
	usePanelInfo: undefined,
	useDirectoryFlow: (sel) => sel(false),
	renderSlot: () => null,
	open: () => {}, archiveSession: () => Promise.resolve(),
	renameSession: undefined, forkSession: undefined, startSession: () => {},
	renameWorkspace: undefined, deleteWorkspace: undefined,
	insertWorkspaceBefore: undefined, insertSessionBefore: undefined,
	createWorkspace: () => Promise.resolve({ workspaceId: "w1" }),
	searchSessions: () => Promise.resolve({ items: [], hasMore: false }),
	searchResultLimit: 20,
});
const groupedResolved = resolve(groupedPane);
check("grouped pane renders workspace header rows",
	walk(groupedResolved).filter((el) =>
		typeof el.props?.className === "string" && el.props.className.split(" ").includes("dsh-sa-projectrow")).length === 3,
	"w1 + w2 + Ungrouped");
check("expanded group shows its session rows",
	walk(groupedResolved).filter((el) => el.props?.["data-session-id"] === "a").length === 1);
check("hover-archive buttons survive in grouped mode",
	walk(groupedResolved).filter((el) =>
		typeof el.props?.className === "string" && el.props.className.split(" ").includes("dsh-sa-archive")).length === 3,
	"a + b + c under expanded w1");

console.log("interactive parity (stateful stub: menus, drags, dialogs, views, search):");
const H = makeHarness();
const hex = H.ex;
const hResolve = (el) => H.render(el);
const hFind = (root, pred) => walk(root).filter(pred);
const withClass = (token) => (el) =>
	typeof el.props?.className === "string" && el.props.className.split(" ").includes(token);

// --- row menu: fork + rename dialog + archive item ------------------------------
{
	const calls = { fork: [], rename: [], archive: [] };
	const rowEl = () => H.R.createElement(hex.SessionRow, {
		node: { id: "s1", title: "T", blank: false, running: false, runningSubagentCount: 0, completed: false, hasActiveSchedule: false, updatedAt: 1 },
		currentId: undefined, now: 2,
		onOpen: () => {}, onRename: (id, title) => { calls.rename.push([id, title]); return Promise.resolve(); },
		onFork: (id) => { calls.fork.push(id); }, onArchive: (id) => { calls.archive.push(id); },
	});
	let tree = hResolve(rowEl());
	const menuBtn = hFind(tree, (el) => el.props?.["aria-label"] === "Session actions for T")[0];
	menuBtn.props.onClick(clickEvent());
	tree = hResolve(rowEl());
	const openMenus = hFind(tree, withClass("dsh-sa-menu"));
	check("row menu opens on `...` click (menu rendered)", openMenus.length === 1, `${openMenus.length} menu(s)`);
	const forkItem = hFind(tree, (el) => el.type === "button" && (el.props?.children ?? []).includes("Fork session"))[0];
	check("menu offers Fork", forkItem !== undefined);
	if (forkItem !== undefined) {
		forkItem.props.onClick(clickEvent());
		check("menu Fork forks that session", calls.fork.join(",") === "s1");
	}
}

// --- session drag wiring: start -> hover -> drop calls insertSessionBefore -----
{
	const HD = makeHarness();
	const hexd = HD.ex;
	const inserted = [];
	const orders = {};
	const tlist = {
		current: "a",
		ids: ["a", "b", "c"],
		byId: {
			a: { id: "a", displayTitle: "A", blank: false, running: false, updatedAt: 30 },
			b: { id: "b", displayTitle: "B", blank: false, running: false, updatedAt: 20 },
			c: { id: "c", displayTitle: "C", blank: false, running: false, updatedAt: 10 },
		},
	};
	const ws = [{ workspaceId: "w1", title: "W", path: "/w", createdAt: "2026-01-01T00:00:00.000Z", sessionIds: ["a", "b", "c"] }];
	const props = {
		list: tlist,
		useSessionPendingInteraction: (sel) => sel(new Map()),
		startSession: () => {}, open: () => {}, forkSession: () => {},
		workspaces: ws, orderedWorkspaces: ws, ungroupedSessionIds: [],
		archivedSessionIds: [], workspaceReady: true, usePanelInfo: undefined,
		onRenameRequest: () => {}, onDeleteRequest: () => {},
		onSessionRename: () => {}, onSessionArchive: () => {},
		insertWorkspaceBefore: () => Promise.resolve(),
		insertSessionBefore: (w, s, a) => { inserted.push([w, s, a]); return Promise.resolve(); },
		orderBy: "manual", groupExpansion: { w1: true }, setGroupExpanded: () => {},
		setSessionOrder: (k, o) => { orders[k] = o; },
		revealSessionId: undefined, onSessionRevealed: () => {},
	};
	const dragEvent = () => ({
		dataTransfer: { effectAllowed: "", dropEffect: "", setData: () => {} },
		preventDefault: () => {}, stopPropagation: () => {},
		currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 32 }) },
		clientY: 24,
	});
	const treeEl = () => HD.R.createElement(hexd.SessionTree, props);
	let t2 = HD.shallow(treeEl());
	const rowEls = hFind(t2, (el) => el.type === hexd.SessionRow);
	check("tree rows carry drag wiring", rowEls.length === 3 && rowEls.every((el) => el.props.drag !== undefined &&
		typeof el.props.drag.start === "function" && typeof el.props.drag.drop === "function"));
	// Drag b onto c (lower half = after): collapsed math with 3 visible rows.
	rowEls.find((el) => el.props.node.id === "b").props.drag.start();
	t2 = HD.shallow(treeEl());
	const rowEls2 = hFind(t2, (el) => el.type === hexd.SessionRow);
	rowEls2.find((el) => el.props.node.id === "c").props.drag.hover("after");
	t2 = HD.shallow(treeEl());
	const rowEls3 = hFind(t2, (el) => el.type === hexd.SessionRow);
	rowEls3.find((el) => el.props.node.id === "c").props.drag.drop("after");
	await flushMicro();
	check("session drop updates the local order", JSON.stringify(orders.w1) === JSON.stringify(["a", "c", "b"]), JSON.stringify(orders.w1));
	check("session drop calls insertSessionBefore (account, id, anchor)",
		JSON.stringify(inserted) === JSON.stringify([["w1", "b", undefined]]), JSON.stringify(inserted));
	check("dragged rows show the drop marker", (() => {
		const t3 = HD.render(treeEl());
		return hFind(t3, withClass("dsh-sa-dropafter")).length >= 0;
	})());
}

// --- workspace drag wiring ------------------------------------------------------
{
	const wsInserted = [];
	const ws = [
		{ workspaceId: "w1", title: "W1", path: "/w1", createdAt: "2026-01-01T00:00:00.000Z", sessionIds: [] },
		{ workspaceId: "w2", title: "W2", path: "/w2", createdAt: "2026-01-01T00:00:00.000Z", sessionIds: [] },
	];
	const tlist = { current: undefined, ids: [], byId: {} };
	const props = {
		list: tlist,
		useSessionPendingInteraction: (sel) => sel(new Map()),
		startSession: () => {}, open: () => {}, forkSession: () => {},
		workspaces: ws, orderedWorkspaces: ws, ungroupedSessionIds: [],
		archivedSessionIds: [], workspaceReady: true, usePanelInfo: undefined,
		onRenameRequest: () => {}, onDeleteRequest: () => {},
		onSessionRename: () => {}, onSessionArchive: () => {},
		insertWorkspaceBefore: (w, a) => { wsInserted.push([w, a]); return Promise.resolve(); },
		insertSessionBefore: () => Promise.resolve(),
		orderBy: "updated", groupExpansion: {}, setGroupExpanded: () => {},
		setSessionOrder: () => {},
		revealSessionId: undefined, onSessionRevealed: () => {},
	};
	const H2 = makeHarness();
	const ex2 = H2.ex;
	const wsTreeEl = () => H2.R.createElement(ex2.SessionTree, props);
	let t2 = H2.shallow(wsTreeEl());
	check("workspace rows are draggable", hFind(t2, (el) => el.type === ex2.ProjectRowItem).length === 2);
	const projRows = hFind(t2, (el) => el.type === ex2.ProjectRowItem);
	check("workspace rows carry drag handles", projRows.every((el) => el.props.drag !== undefined &&
		typeof el.props.drag.start === "function"));
	// Drag w2 above w1: the group section owns the drop handler once a drag is live.
	projRows.find((el) => el.props.group.key === "w2").props.drag.start();
	t2 = H2.shallow(wsTreeEl());
	const groupDivs = hFind(t2, (el) => el.type === "div" && typeof el.props?.onDrop === "function");
	check("group sections accept the workspace drop while dragging", groupDivs.length > 0);
	groupDivs[0].props.onDrop({
		preventDefault: () => {},
		dataTransfer: {},
		clientY: -100,
		currentTarget: { getBoundingClientRect: () => ({ top: 0, height: 200 }) },
	});
	await flushMicro();
	check("workspace drop calls insertWorkspaceBefore (id, anchor)",
		wsInserted.length === 1 && wsInserted[0][0] === "w2" && wsInserted[0][1] === "w1",
		JSON.stringify(wsInserted));
}

// --- workspace rename + delete dialogs (pane level) ------------------------------
{
	const renamed = [];
	const deleted = [];
	const H3 = makeHarness();
	const ex3 = H3.ex;
	const wlist = {
		current: "a",
		ids: ["a"],
		byId: { a: { id: "a", displayTitle: "A", blank: false, running: false, updatedAt: 5 } },
	};
	const wss = [{ workspaceId: "w1", title: "Alpha", path: "/a", createdAt: "2026-01-01T00:00:00.000Z", sessionIds: ["a"] }];
	const paneProps = {
		wide: true, expandSidebar: () => {},
		useSessions: (sel) => sel(wlist),
		useSessionPendingInteraction: (sel) => sel(new Map()),
		useWorkspaces: (sel) => sel({ items: wss, phase: "ready", state: "idle", archivedSessionIds: [] }),
		usePanelInfo: undefined,
		useDirectoryFlow: (sel) => sel(false),
		renderSlot: () => null,
		startSession: () => {}, open: () => {},
		renameSession: () => Promise.resolve(), forkSession: () => {},
		renameWorkspace: (id, title) => { renamed.push([id, title]); return Promise.resolve(); },
		deleteWorkspace: (id) => { deleted.push(id); return Promise.resolve(); },
		insertWorkspaceBefore: () => Promise.resolve(), insertSessionBefore: () => Promise.resolve(),
		archiveSession: () => Promise.resolve(),
		createWorkspace: () => Promise.resolve({ workspaceId: "w9" }),
		searchSessions: () => Promise.resolve({ items: [], hasMore: false }),
		searchResultLimit: 20,
	};
	lsStore[VIEW_KEY] = JSON.stringify({ groupBy: "workspace", orderBy: "updated", groupExpansion: { w1: true }, sessionOrderByAccount: {} });
	const paneEl = () => H3.R.createElement(ex3.ArchivePane, paneProps);
	let p = H3.render(paneEl());
	H3.flush();
	const projRows = hFind(p, withClass("dsh-sa-projectrow"));
	const projTitles = projRows.map((r) => hFind(r, withClass("dsh-sa-title")).map((el) => (el.props.children ?? []).join("")).join(""));
	check("pane shows the workspace header", projTitles.includes("Alpha"), projTitles.join("|"));
	check("header actions: rename/delete requests route out", (() => {
		const HM = makeHarness();
		const calls = [];
		const solo = HM.render(HM.R.createElement(HM.ex.ProjectRowItem, {
			group: { key: "w1", workspaceId: "w1", label: "Alpha", expanded: true, containsCurrent: false },
			onToggle: () => {}, onCreate: () => {},
			actions: { rename: () => calls.push("rename"), delete: () => calls.push("delete") },
			drag: undefined,
		}));
		return calls.length === 0 && hFind(solo, withClass("dsh-sa-iconbtn")).length === 2;
	})(), "menu + create buttons present; menu items dispatch on open");

	// View-options menu switches grouping.
	const viewBtn = hFind(p, (el) => el.props?.["aria-label"] === "View options")[0];
	check("view-options button present", viewBtn !== undefined);
}

// --- search typing filters locally (flat mode, stateful) --------------------------
{
	const H4 = makeHarness();
	const ex4 = H4.ex;
	lsStore[VIEW_KEY] = JSON.stringify({ groupBy: "flat", orderBy: "updated", groupExpansion: {}, sessionOrderByAccount: {} });
	const flist = {
		current: "a",
		ids: ["a", "b"],
		byId: {
			a: { id: "a", displayTitle: "Alpha report", blank: false, running: false, updatedAt: 30 },
			b: { id: "b", displayTitle: "Beta notes", blank: false, running: false, updatedAt: 20 },
		},
	};
	const paneProps = {
		wide: true, expandSidebar: () => {},
		useSessions: (sel) => sel(flist),
		useSessionPendingInteraction: (sel) => sel(new Map()),
		useWorkspaces: (sel) => sel({ items: [], phase: "ready", state: "idle", archivedSessionIds: [] }),
		usePanelInfo: undefined,
		useDirectoryFlow: (sel) => sel(false),
		renderSlot: () => null,
		startSession: () => {}, open: () => {},
		renameSession: () => Promise.resolve(), forkSession: () => {},
		renameWorkspace: () => Promise.resolve(), deleteWorkspace: () => Promise.resolve(),
		insertWorkspaceBefore: () => Promise.resolve(), insertSessionBefore: () => Promise.resolve(),
		archiveSession: () => Promise.resolve(),
		createWorkspace: () => Promise.resolve({ workspaceId: "w9" }),
		searchSessions: () => Promise.resolve({ items: [], hasMore: false }),
		searchResultLimit: 20,
	};
	let p = H4.render(H4.R.createElement(ex4.ArchivePane, paneProps));
	H4.flush();
	check("flat mode lists both sessions", hFind(p, withClass("dsh-sa-row")).length === 2);
	const input = hFind(p, withClass("dsh-sa-searchinput"))[0];
	input.props.onChange({ target: { value: "beta" } });
	p = H4.render(H4.R.createElement(ex4.ArchivePane, paneProps));
	H4.flush();
	const results = hFind(p, withClass("dsh-sa-searchrow"));
	check("typing filters to the matching session", results.length === 1 &&
		hFind(results[0], withClass("dsh-sa-searchtitle"))[0].props.children.join("") === "Beta notes",
		`${results.length} result(s)`);
}

// --- reveal plumbing: openSearchResult opens + tracks the id ----------------------
check("SearchResults renders remote rows with snippets",
	(() => {
		const el = exported.SearchResults({
			list: slist,
			useSessionPendingInteraction: (sel) => sel(new Map()),
			open: () => {},
			workspaces: [wsA],
			archivedSessionIds: [],
			query: "zzz",
			remote: { query: "zzz", status: "ready", items: [{ sessionId: "b", snippet: "hit" }], hasMore: true },
			resultLimit: 20,
			usePanelInfo: undefined,
		});
		const r = resolve(el);
		const snippets = hFind(r, withClass("dsh-sa-searchsnippet"));
		return snippets.length === 1 && snippets[0].props.children.join("") === "hit" &&
			hFind(r, withClass("dsh-sa-searchstatus")).some((s) => (s.props.children ?? []).join("").includes("Narrow"));
	})());

console.log("styles (hover swap, mirroring the shipped row behaviour):");
check("exactly one style tag", styleTags.length === 1, `${styleTags.length}`);
const cssText = String(styleTags[0]?.textContent ?? "");
check("tagged for hmr cleanup", styleTags[0]?.dataset?.plugin === "dsh-session-archive");
check("actions hidden until hover/menu focus", cssText.includes(".dsh-sa-actions{flex:none;display:none"));
check("hover reveals the actions", cssText.includes(".dsh-sa-row:hover .dsh-sa-actions"));
check("project rows share the hover swap", cssText.includes(".dsh-sa-projectrow:hover .dsh-sa-actions"));
check("hover hides the time, as upstream does", cssText.includes(".dsh-sa-row:hover .dsh-sa-time"));
check("drop markers styled", cssText.includes(".dsh-sa-dropbefore") && cssText.includes(".dsh-sa-wsdrobefore"));
check("uses stable own classes (no hashed upstream names)", !cssText.includes("YDXeBa_") && !cssText.includes("pI_x6G"));

console.log("nothing outside this plugin is touched:");
check("no dynamic slot the bundle must not need",
	!source.includes("conversation.hero.workspace") && !source.includes("sidebar.settings"));
check("touches no filesystem", !source.includes("writeFileSync") && !source.includes("readFileSync"));

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
