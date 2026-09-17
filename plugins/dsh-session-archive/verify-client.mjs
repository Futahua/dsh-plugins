/**
 * Structural and behavioural self-check for the dsh-session-archive client bundle.
 *
 * No browser needed: it stubs `window.__ModuleLoader__`, `require("react")`,
 * a minimal DOM, and the slot context, then evaluates the real bundle and
 * proves:
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
 *
 * Run: node plugins/dsh-session-archive/verify-client.mjs
 */
import { readFileSync } from "node:fs";

let failures = 0;
const check = (label, condition, detail = "") => {
	if (!condition) failures += 1;
	console.log(`  ${condition ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
};

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
	setTimeout: (fn) => setTimeout(fn, 0),
	clearTimeout: (id) => clearTimeout(id),
};

/** Minimal React surface: element descriptors plus stateful enough hooks. */
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
check("exports the flat derivation", typeof exported.deriveFlatRows === "function");
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
for (const key of ["open", "archiveSession", "renameSession", "forkSession", "startSession", "createWorkspace", "searchSessions"]) {
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
	typeof el.props?.["aria-label"] === "string" && el.props["aria-label"].startsWith("Session actions for"));
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

console.log("the pane (flat list, search, add-workspace seat):");
const renderPane = ({ archivedIds, occupied, wide = true }) => {
	const fixtureList = { current: "sess-1", ids: ["sess-1", "sess-2"], byId: {
		"sess-1": { id: "sess-1", displayTitle: "Alpha", blank: false, running: true, updatedAt: 20 },
		"sess-2": { id: "sess-2", displayTitle: "Beta", blank: false, running: false, completed: true, updatedAt: 10 },
	}, };
	return exported.ArchivePane({
		wide, expandSidebar: () => {},
		useSessions: (sel) => sel(fixtureList),
		useSessionPendingInteraction: (sel) => sel(new Map()),
		useWorkspaces: (sel) => sel({ archivedSessionIds: archivedIds }),
		usePanelInfo: undefined,
		useDirectoryFlow: (sel) => sel(occupied),
		renderSlot: () => null,
		open: (id) => ctx.services.uiWorkspace.openSession(id),
		archiveSession: (id) => ctx.services.uiWorkspace.archiveSession(id),
		renameSession: undefined, forkSession: undefined, startSession: () => {},
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
await new Promise((r) => setTimeout(r, 0));
check("a pane-level click archives that row id with no dialog",
	ctx.services.uiWorkspace.archiveCalls.join(",") === "sess-1", JSON.stringify(ctx.services.uiWorkspace.archiveCalls));
check("...without opening it", ctx.services.uiWorkspace.openCalls.length === 0);
const echoed = renderPane({ archivedIds: ["sess-1"], occupied: false });
check("the archive-set echo removes the row", byClass(echoed, "dsh-sa-row").length === 1 &&
	byClass(echoed, "dsh-sa-row")[0].props["data-session-id"] === "sess-2");
check("search box present", byClass(paneTree, "dsh-sa-searchinput").length === 1);
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

console.log("styles (hover swap, mirroring the shipped row behaviour):");
check("exactly one style tag", styleTags.length === 1, `${styleTags.length}`);
const cssText = String(styleTags[0]?.textContent ?? "");
check("tagged for hmr cleanup", styleTags[0]?.dataset?.plugin === "dsh-session-archive");
check("actions hidden until hover/menu focus", cssText.includes(".dsh-sa-actions{flex:none;display:none"));
check("hover reveals the actions", cssText.includes(".dsh-sa-row:hover .dsh-sa-actions"));
check("hover hides the time, as upstream does", cssText.includes(".dsh-sa-row:hover .dsh-sa-time"));
check("uses stable own classes (no hashed upstream names)", !cssText.includes("YDXeBa_") && !cssText.includes("pI_x6G"));

console.log("nothing outside this plugin is touched:");
check("no dynamic slot the bundle must not need",
	!source.includes("conversation.hero.workspace") && !source.includes("sidebar.settings"));
check("touches no filesystem", !source.includes("writeFileSync") && !source.includes("readFileSync"));

console.log("");
console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`);
process.exitCode = failures === 0 ? 0 : 1;
