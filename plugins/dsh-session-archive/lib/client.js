/**
 * Sidebar session pane with a one-click hover-archive button — a faithful
 * port of the shipped pane with one added control.
 *
 * This bundle REPLACES the shipped session pane: it registers into
 * `sidebar.workspaces` (a `single` slot declared by
 * `@deepseek-ai/dsh-client-ui-sidebar`), which shadows the shipped
 * `WorkspaceBrowser` from `@deepseek-ai/dsh-client-ui-workspace`. There is no
 * slot for per-session-row actions, so a row-level button is only reachable
 * by owning the whole region.
 *
 * Port basis: upstream `deepseek-ai/deepseek-harness`, branch `master`,
 * `packages/client/ui-workspace/src/client/` — `rows/Rows.tsx`
 * (ProjectRowItem, SearchResultItem, SessionNodeItem), `rows/WorkspaceBrowser.tsx`
 * (SessionTree, FlatList, SearchResults, WorkspaceBrowser, ViewOptionsMenu),
 * `tree.ts` (all derivations), `stores.ts` (view state shape + defaults),
 * `locales.ts` (the English dictionary, copied verbatim). The port target is
 * this repo's plain-`React.createElement` style (no TS/JSX, no build step),
 * verified against the installed harness build
 * (`@deepseek-ai/dsh-client-ui-workspace@0.1.5-rc.2`, whose drag-commit
 * bodies are mirrored exactly).
 *
 * THE DIFF vs upstream, in full:
 *   1. `SessionNodeItem`'s hover actions cell holds a one-click archive
 *      button BESIDE the `...` menu. It calls `onArchive(node.id)` directly —
 *      no confirmation dialog, because archiving hides the row through the
 *      registry-global archive set and never touches the session log
 *      (upstream `Rows.tsx`: "commits without a dialog"). The row disappears
 *      when the archive-set echo lands. The button stops propagation so the
 *      row's own open click never fires.
 *   2. Everything else is behavior-preserving by construction (same
 *      derivation functions, same commit math, same dialog flows).
 *
 * Deliberate non-ports (documented, not overlooked):
 *   - Hover cards (`HoverCard` + copy affordance) need the UI-primitives
 *     package; rows keep `title` tooltips instead. Status dots, the schedule
 *     marker, and all icons are dependency-free inline SVG/CSS.
 *   - No locale namespace is joined; the upstream English dictionary is
 *     inlined (no `t` dependency, literal English only).
 *   - View state (groupBy/orderBy/expansions/manual orders) persists to
 *     `localStorage` under the upstream key rather than through the
 *     store engine; per-update timestamp promotion is simplified to
 *     recency/manual reconciliation (upstream `tree.ts` semantics).
 *   - The "Add workspace" trigger opens the directory flow directly instead
 *     of via the upstream popover menu; adoption (`createWorkspace` then
 *     start) and the error surface match.
 *
 * The `sidebar.workspaces.directoryFlow` hole is redeclared with the
 * identical owner contract (`{ kind: "single", scope: "root" }`), so the
 * shipped directory pickers (browse + native, both injected by hole name)
 * keep working. The hole is only rendered while occupied.
 *
 * Bundle format: `window.__ModuleLoader__.load({id, factory})` exporting
 * `apply` and `inject`. Plain `React.createElement` — no TS/JSX, matching
 * the sibling bundles in this repo.
 */
window.__ModuleLoader__.load({
	id: "dsh-session-archive",
	factory: (require) => {
		const module = { exports: {} };
		const exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		const react = require("react");

		/** This pane's slot and the directory-flow hole it redeclares. */
		const SLOT = "sidebar.workspaces";
		const FLOW_HOLE = "sidebar.workspaces.directoryFlow";

		/** Column slide length: rail-search focus waits it out. */
		const EXPAND_SLIDE_MS = 300;
		/** Pause between the latest keystroke and a Host content-search request. */
		const SEARCH_DEBOUNCE_MS = 250;
		/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
		const SEARCH_QUERY_MAX_CODE_UNITS = 500;
		/** Session rows visible per Workspace before the local overflow control. */
		const COLLAPSED_SESSION_LIMIT = 5;
		/** Group key for Sessions outside every Workspace. (Upstream UNGROUPED_KEY.) */
		const UNGROUPED_KEY = "";
		/** Browser-local order account for the hierarchy-free flat Session list. */
		const FLAT_SESSION_ORDER_KEY = "__flat_session_order__";
		/** View-state persistence key (upstream store persist key). */
		const VIEW_STORE_KEY = "dsh.workspace.view.v5";

		/** Build marker, so a live page can be checked against the source. */
		const VERSION = 2;

		/* -------------------------------------------------- dictionary (en) */
		// Upstream `locales.ts` English dictionary, copied verbatim (no locale
		// namespace is joined; this pane renders English literals only).
		const EN = {
			"group.ungrouped": "Ungrouped",
			"session.new": "New Session",
			"section.workspaces": "Workspaces",
			"section.sessions": "Sessions",
			"viewOptions.label": "View options",
			"groupBy.label": "Group by",
			"groupBy.workspace": "WorkSpace",
			"groupBy.flat": "In one list",
			"orderBy.label": "Order by",
			"orderBy.manual": "Manual",
			"orderBy.updated": "Last updated",
			"sessions.expand": "Show {n} more sessions",
			"sessions.collapse": "Show less",
			"empty.none": "No sessions yet",
			"empty.noMatches": "No matches",
			"workspace.add": "Add workspace",
			"search.sessions.aria": "Search sessions",
			"search.placeholder": "Search sessions...",
			"search.clear": "Clear search",
			"search.results.aria": "Search results",
			"search.pending": "Searching session history…",
			"search.unavailable": "Content search is temporarily unavailable. Showing name matches.",
			"search.noMatches": "No matching sessions",
			"search.hasMore": "Showing the first {n} results. Narrow your search.",
			"menu.addWorkspace": "Add workspace…",
			"picker.loading": "Loading workspaces…",
			"conflict.named": "A workspace named “{name}” already exists.",
			"folderError.title": "Couldn’t open folder",
			"folderError.retry": "Choose again",
			"rename": "Rename",
			"rename.workspace.title": "Rename workspace",
			"rename.session.title": "Rename session",
			"field.workspaceName": "Workspace name",
			"field.sessionName": "Session name",
			"delete.workspace": "Delete workspace",
			"delete.desc": "This removes “{name}” from the workspace list. The folder and session logs will be kept. Its sessions will appear under Ungrouped.",
			"delete.pending": "Deleting workspace…",
			"menu.fork": "Fork session",
			"menu.archiveSession": "Archive session",
			"sessions.count.one": "{n} session",
			"sessions.count.other": "{n} sessions",
			"actions.workspace.aria": "Workspace actions for {name}",
			"actions.session.aria": "Session actions for {name}",
			"actions.newSession.aria": "New session in {name}",
			"status.running": "Running",
			"status.subagentsRunning.one": "{n} subagent running",
			"status.subagentsRunning.other": "{n} subagents running",
			"status.idle": "Idle",
			"status.waitingApproval": "Waiting for approval",
			"status.planReview": "Plan awaiting review",
			"status.waitingAnswer": "Waiting for answer",
			"status.completed": "Completed",
			"schedule.active": "Has active scheduled task",
			"hover.created": "Created {time}",
			"hover.copied": "Copied",
			"date.ymd": "{y}-{m}-{d}",
			"time.now": "now",
			"time.minutes": "{n}min",
			"time.hours": "{n}h",
			"time.days": "{n}d",
			"time.months": "{n}mo",
			"time.years": "{n}y",
			"time.ago": "{t} ago",
			"cancel": "Cancel",
			"close": "Close",
		};

		/**
		 * Minimal dictionary lookup with `{param}` interpolation.
		 *
		 * @param key dictionary key.
		 * @param params interpolation values.
		 * @returns the rendered string.
		 */
		function t(key, params) {
			let out = EN[key] !== undefined ? EN[key] : key;
			if (params !== undefined) {
				for (const name of Object.keys(params)) {
					out = out.split(`{${name}}`).join(String(params[name]));
				}
			}
			return out;
		}

		/* ------------------------------------------- pure derivations (tree) */
		// Ports of upstream `tree.ts` + `subagent-lineage.ts` + `Rows.tsx`
		// helpers, in plain JS. Semantics are unchanged; only types are gone.

		/**
		 * Keep controlled input and RPC payload inside the session.search wire contract.
		 *
		 * @param value raw input value.
		 * @returns the value without NULs, clipped to the wire bound.
		 */
		function sanitizeSearchQuery(value) {
			const withoutNul = String(value).replaceAll("\0", "");
			if (withoutNul.length <= SEARCH_QUERY_MAX_CODE_UNITS) return withoutNul;
			let end = SEARCH_QUERY_MAX_CODE_UNITS;
			const last = withoutNul.charCodeAt(end - 1);
			const next = withoutNul.charCodeAt(end);
			if (last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
			return withoutNul.slice(0, end);
		}

		/** Resolve the browser group owning one session (workspace id or UNGROUPED_KEY). */
		function owningGroupKey(workspaces, sessionId) {
			const found = workspaces.find((workspace) => workspace.sessionIds.includes(sessionId));
			return found !== undefined ? found.workspaceId : UNGROUPED_KEY;
		}

		/** Directory display label: basename of the path (both separators accepted). */
		function workspaceLabel(cwd) {
			if (cwd === undefined || cwd === "") return "";
			const parts = String(cwd).split(/[/\\]/).filter((part) => part !== "");
			// A drive root (`C:\`) has no basename; keep the raw path then.
			if (parts.length === 0) return String(cwd);
			return parts[parts.length - 1];
		}

		/** Recency comparator: newest first, id as the deterministic tiebreak. */
		function byRecency(a, b) {
			if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
			return a.id < b.id ? -1 : 1;
		}

		/**
		 * Ordinary sessions are visible; among blank sessions, only the current
		 * one is visible. Subagent children use their parent header catalog;
		 * archived sessions are visible nowhere.
		 */
		function sessionVisible(session, current, archived) {
			return session.origin !== "subagent" &&
				!archived.has(session.id) &&
				(!session.blank || session.id === current);
		}

		/** A blank session's canonical title never enters search or rows; the renderer localizes it. */
		function sessionTitle(session) {
			return session.blank ? "" : session.displayTitle;
		}

		/** The list projection alone owns the best-effort active-Schedule indicator. */
		function hasActiveSchedule(session) {
			const schedule = (session.projectionValues || {}).schedule;
			return ((schedule || {}).length ?? 0) > 0;
		}

		/** Keep navigation presentation independent from domain-owned interaction objects. */
		function visiblePendingKind(kind) {
			switch (kind) {
				case "approval":
				case "plan-review":
				case "question": return kind;
				default: return undefined;
			}
		}

		/**
		 * Index uninterrupted subagent descendants under each ancestor.
		 *
		 * @param summaries session summaries keyed by id.
		 * @returns descendant totals keyed by possible parent id.
		 */
		function indexSubagentDescendants(summaries) {
			const indexed = new Map();
			for (const descendant of Object.values(summaries)) {
				if (descendant.origin !== "subagent") continue;
				const seen = new Set();
				let current = descendant;
				while (current !== undefined && current !== null &&
					current.origin === "subagent" && current.parentId !== undefined && !seen.has(current.id)) {
					seen.add(current.id);
					const aggregate = indexed.get(current.parentId);
					if (aggregate === undefined) {
						indexed.set(current.parentId, {
							count: 1,
							runningCount: descendant.running ? 1 : 0,
						});
					} else {
						aggregate.count += 1;
						if (descendant.running) aggregate.runningCount += 1;
					}
					current = summaries[current.parentId];
				}
			}
			return indexed;
		}

		/**
		 * Project known account members by current Session recency.
		 *
		 * @param sessionIds authoritative account membership.
		 * @param summaries current Session summaries.
		 * @returns known members newest first, id as tie-break.
		 */
		function orderByRecency(sessionIds, summaries) {
			return sessionIds.flatMap((id) => {
				const summary = summaries[id];
				return summary === undefined ? [] : [{ id, updatedAt: summary.updatedAt }];
			})
				.sort((a, b) => {
					if (a.updatedAt !== b.updatedAt) return b.updatedAt - a.updatedAt;
					return a.id < b.id ? -1 : 1;
				})
				.map((member) => member.id);
		}

		/**
		 * Reconcile a browser-local manual order with current account membership.
		 *
		 * @param memberIds authoritative account membership.
		 * @param savedOrder previously saved browser-local order.
		 * @param summaries current Session summaries (new members append by recency).
		 * @returns retained saved slots followed by newly known members.
		 */
		function reconcileManualOrder(memberIds, savedOrder, summaries) {
			const members = new Map(memberIds.map((id) => [id, id]));
			const included = new Set();
			const ordered = [];
			for (const key of savedOrder ?? []) {
				const id = members.get(key);
				if (id === undefined || included.has(key)) continue;
				ordered.push(id);
				included.add(key);
			}
			for (const id of orderByRecency(memberIds, summaries)) {
				if (included.has(id)) continue;
				ordered.push(id);
				included.add(id);
			}
			return ordered;
		}

		/**
		 * Keep the selected provisional New Session ahead of either base order.
		 *
		 * @param order recency or reconciled manual order.
		 * @param currentBlank selected blank Session in this account, when present.
		 * @returns a copy with the selected blank first and no duplicate slot.
		 */
		function pinCurrentBlank(order, currentBlank) {
			if (currentBlank === undefined) return [...order];
			return [currentBlank, ...order.filter((id) => id !== currentBlank)];
		}

		function buildGroup(key, workspaceId, cwd, createdAt, label, members) {
			return { key, workspaceId, cwd, createdAt, label, sessions: [...members] };
		}

		/** Apply a stored Ungrouped order and append newly loose Sessions by recency. */
		function orderedUngrouped(members, stored, summaries) {
			const byId = new Map(members.map((session) => [session.id, session]));
			const ids = stored === undefined
				? orderByRecency(members.map((session) => session.id), summaries)
				: reconcileManualOrder(members.map((session) => session.id), stored, summaries);
			return ids.flatMap((id) => {
				const session = byId.get(id);
				return session === undefined ? [] : [session];
			});
		}

		/**
		 * Group Sessions by Host Workspace: one group per caller-ordered entity;
		 * Sessions outside every Workspace trail under Ungrouped.
		 */
		function groupByWorkspace(list, workspaces, archived, ungroupedOrder) {
			const groups = [];
			const accounted = new Set();
			for (const workspace of workspaces) {
				const members = [];
				for (const id of workspace.sessionIds) {
					const summary = list.byId[id];
					if (summary === undefined) continue;
					accounted.add(id);
					if (!sessionVisible(summary, list.current, archived)) continue;
					members.push(summary);
				}
				groups.push(buildGroup(
					workspace.workspaceId, workspace.workspaceId, workspace.path,
					Date.parse(workspace.createdAt), workspace.title, members,
				));
			}
			const stray = list.ids
				.map((id) => list.byId[id])
				.filter((s) => s !== undefined && !accounted.has(s.id) && sessionVisible(s, list.current, archived));
			if (stray.length > 0) {
				groups.push(buildGroup(
					UNGROUPED_KEY, undefined, undefined, undefined, "",
					orderedUngrouped(stray, ungroupedOrder, list.byId),
				));
			}
			return groups;
		}

		function sessionNode(s, descendants, pendingInteractions) {
			const pendingInteraction = visiblePendingKind(pendingInteractions.get(s.id)?.kind);
			return {
				id: s.id,
				title: sessionTitle(s),
				blank: s.blank,
				running: s.running,
				runningSubagentCount: descendants.get(s.id)?.runningCount ?? 0,
				completed: s.completed === true,
				hasActiveSchedule: hasActiveSchedule(s),
				updatedAt: s.updatedAt,
				...(pendingInteraction === undefined ? {} : { pendingInteraction }),
			};
		}

		/**
		 * Derive the workspace browser groups. Every group shows; sessions
		 * populate under expanded groups in the caller-projected order.
		 */
		function deriveGroups(list, workspaces, archivedSessionIds, pendingInteractions, view) {
			const archived = new Set(archivedSessionIds);
			const expandedGroups = new Set(view.expandedGroups);
			const descendants = indexSubagentDescendants(list.byId);
			const currentGroup = list.current === undefined
				? undefined
				: owningGroupKey(workspaces, list.current);
			const groups = [];
			for (const g of groupByWorkspace(list, workspaces, archived, view.ungroupedOrder)) {
				const expanded = expandedGroups.has(g.key);
				groups.push({
					key: g.key,
					workspaceId: g.workspaceId,
					cwd: g.cwd,
					createdAt: g.createdAt,
					label: g.label,
					sessionCount: g.sessions.length,
					expanded,
					containsCurrent: g.key === currentGroup,
					sessions: expanded
						? g.sessions.map((session) => sessionNode(session, descendants, pendingInteractions))
						: [],
				});
			}
			return groups;
		}

		/**
		 * Select flat-list members: known visible Session ids in list order.
		 */
		function visibleSessionIds(list, archivedSessionIds) {
			const archived = new Set(archivedSessionIds);
			return list.ids.filter((id) => {
				const s = list.byId[id];
				return s !== undefined && sessionVisible(s, list.current, archived);
			});
		}

		/**
		 * Derive flat rows from the browser's ordered visible Session ids.
		 */
		function deriveFlat(list, sessionIds, pendingInteractions) {
			const descendants = indexSubagentDescendants(list.byId);
			return sessionIds.map((id) => sessionNode(list.byId[id], descendants, pendingInteractions));
		}

		/**
		 * Derive the flat session list ("In one list" mode) from raw snapshots:
		 * every visible session as a top-level row, strictly newest-first.
		 * (Convenience over visibleSessionIds + deriveFlat; kept for compatibility.)
		 */
		function deriveFlatRows(list, archivedSessionIds, pendingInteractions) {
			const archived = new Set(archivedSessionIds ?? []);
			const rows = [];
			for (const id of list.ids ?? []) {
				const s = list.byId[id];
				if (s === undefined || !sessionVisible(s, list.current, archived)) continue;
				rows.push(s);
			}
			rows.sort(byRecency);
			const descendants = indexSubagentDescendants(list.byId);
			const pending = pendingInteractions !== undefined && typeof pendingInteractions.get === "function"
				? pendingInteractions
				: new Map();
			return rows.map((s) => sessionNode(s, descendants, pending));
		}

		/**
		 * Merge immediate title/Workspace substring matches with ranked Host
		 * content matches. Local rows lead newest-first, content-only rows
		 * retain backend order; duplicates take the backend snippet in place.
		 * (Upstream deriveSearchResults.)
		 */
		function deriveSearchResults(list, workspaces, query, archivedSessionIds, pendingInteractions, content, limit) {
			const q = query.trim().toLowerCase();
			if (q === "") return { items: [], hasMore: false };
			const archived = new Set(archivedSessionIds);
			const descendants = indexSubagentDescendants(list.byId);

			const workspaceBySession = new Map();
			for (const workspace of workspaces) {
				for (const sessionId of workspace.sessionIds) {
					if (!workspaceBySession.has(sessionId)) workspaceBySession.set(sessionId, workspace.title);
				}
			}
			const labelOf = (summary) =>
				workspaceBySession.get(summary.id) ?? workspaceLabel(summary.cwd);
			const contentBySession = new Map();
			for (const item of content.items) {
				if (!contentBySession.has(item.sessionId)) contentBySession.set(item.sessionId, item);
			}

			const local = [];
			for (const id of list.ids) {
				const summary = list.byId[id];
				if (summary === undefined || summary.blank || !sessionVisible(summary, list.current, archived)) continue;
				if (sessionTitle(summary).toLowerCase().includes(q) ||
					labelOf(summary).toLowerCase().includes(q)) {
					local.push(summary);
				}
			}
			const localById = new Map(local.map((summary) => [summary.id, summary]));
			const orderedLocal = orderByRecency(local.map((summary) => summary.id), list.byId)
				.map((id) => localById.get(id));

			const ordered = [];
			const included = new Set();
			const include = (summary) => {
				if (included.has(summary.id)) return;
				included.add(summary.id);
				ordered.push(summary);
			};
			for (const summary of orderedLocal) include(summary);
			for (const item of content.items) {
				const summary = list.byId[item.sessionId];
				if (summary !== undefined && !summary.blank && sessionVisible(summary, list.current, archived)) {
					include(summary);
				}
			}

			return {
				items: ordered.slice(0, limit).map((summary) => {
					const match = contentBySession.get(summary.id);
					const pendingInteraction = visiblePendingKind(pendingInteractions.get(summary.id)?.kind);
					return {
						id: summary.id,
						title: sessionTitle(summary),
						workspace: labelOf(summary),
						running: summary.running,
						runningSubagentCount: descendants.get(summary.id)?.runningCount ?? 0,
						...(pendingInteraction === undefined ? {} : { pendingInteraction }),
						completed: summary.completed === true,
						hasActiveSchedule: hasActiveSchedule(summary),
						...(match === undefined ? {} : { snippet: match.snippet }),
					};
				}),
				hasMore: content.hasMore || ordered.length > limit,
			};
		}

		/** Fold one Workspace without charging its provisional New Session against the row limit. */
		function collapsedSessionRows(sessions) {
			let ordinaryCount = 0;
			const rows = sessions.filter((session) => {
				if (session.blank) return true;
				if (ordinaryCount >= COLLAPSED_SESSION_LIMIT) return false;
				ordinaryCount += 1;
				return true;
			});
			return { rows, hiddenCount: sessions.length - rows.length };
		}

		/** Pointer-position half of a row (insert line above or below). */
		function rowHalf(e) {
			const rect = e.currentTarget.getBoundingClientRect();
			return e.clientY < rect.top + rect.height / 2 ? "before" : "after";
		}

		/**
		 * Pure session-drop commit math, mirrored exactly from the installed
		 * build's `commitSessionDrag` (both SessionTree and FlatList shapes).
		 *
		 * @param options.groups derived groups (sessions in rendered account order).
		 * @param options.expandedKeys group keys in their expanded state.
		 * @param options.accountIds caller-projected full account order by group key.
		 * @param options.orderBy current order mode.
		 * @param options.activeDrag in-flight drag identity.
		 * @param options.over drop target row + half.
		 * @returns null when the drop changes nothing, else the commit
		 *   (accountKey, sessionId, host anchor, local nextOrder, and whether
		 *   the host reorder call applies — never for `updated` order or the
		 *   ungrouped account, exactly as upstream).
		 */
		function commitSessionDrop({ groups, expandedKeys, accountIds, orderBy, activeDrag, over }) {
			const group = groups.find((candidate) => candidate.key === activeDrag.accountKey);
			if (group === undefined) return null;
			const expanded = expandedKeys.includes(group.key);
			const renderedSessions = expanded ? group.sessions : collapsedSessionRows(group.sessions).rows;
			const targetIndex = renderedSessions.findIndex((session) => session.id === over.id);
			if (targetIndex === -1) return null;
			const sourceIndex = renderedSessions.findIndex((session) => session.id === activeDrag.sessionId);
			if (over.id === activeDrag.sessionId) return null;
			const withoutSource = renderedSessions.filter((session) => session.id !== activeDrag.sessionId);
			const targetWithoutSourceIndex = withoutSource.findIndex((session) => session.id === over.id);
			if (targetWithoutSourceIndex === -1) return null;
			const visibleInsertAt = over.half === "before" ? targetWithoutSourceIndex : targetWithoutSourceIndex + 1;
			if (sourceIndex !== -1 && visibleInsertAt === sourceIndex) return null;
			const accountSessionIds = accountIds[activeDrag.accountKey];
			if (accountSessionIds === undefined || !accountSessionIds.includes(activeDrag.sessionId)) return null;
			const nextOrder = accountSessionIds.filter((id) => id !== activeDrag.sessionId);
			let anchor;
			if (expanded) {
				anchor = over.half === "before" ? over.id : renderedSessions[targetIndex + 1]?.id;
			} else {
				const previousVisible = withoutSource[visibleInsertAt - 1]?.id;
				if (previousVisible === undefined) {
					anchor = nextOrder[0];
				} else {
					const previousIndex = nextOrder.indexOf(previousVisible);
					if (previousIndex === -1) return null;
					anchor = nextOrder[previousIndex + 1];
				}
			}
			const insertAt = anchor === undefined ? nextOrder.length : nextOrder.indexOf(anchor);
			nextOrder.splice(insertAt === -1 ? nextOrder.length : insertAt, 0, activeDrag.sessionId);
			if (!expanded && sourceIndex !== -1) {
				const nodes = new Map(group.sessions.map((node) => [node.id, node]));
				const nextGroup = nextOrder.flatMap((id) => {
					const node = nodes.get(id);
					return node === undefined ? [] : [node];
				});
				if (!collapsedSessionRows(nextGroup).rows.some((node) => node.id === activeDrag.sessionId)) return null;
			}
			return {
				accountKey: activeDrag.accountKey,
				sessionId: activeDrag.sessionId,
				anchor,
				nextOrder: nextOrder.map((id) => id),
				callHost: !(orderBy === "updated" || activeDrag.accountKey === UNGROUPED_KEY),
			};
		}

		/**
		 * Pure workspace-drop commit math, mirrored exactly from the installed
		 * build's `commitWorkspaceDrag`.
		 *
		 * @returns null when the drop changes nothing, else `{ workspaceId, anchor }`
		 *   for `insertWorkspaceBefore` (omitted anchor appends to the end).
		 */
		function commitWorkspaceDrop({ workspaces, activeDrag, over }) {
			const rowIndex = workspaces.findIndex((workspace) => workspace.workspaceId === over.id);
			if (rowIndex === -1) return null;
			const anchor = over.half === "before" ? over.id : workspaces[rowIndex + 1]?.workspaceId;
			if (anchor === activeDrag.workspaceId) return null;
			const sourceIndex = workspaces.findIndex((workspace) => workspace.workspaceId === activeDrag.workspaceId);
			const anchorIndex = anchor === undefined
				? workspaces.length
				: workspaces.findIndex((workspace) => workspace.workspaceId === anchor);
			if (sourceIndex !== -1 && (anchorIndex === sourceIndex || anchorIndex === sourceIndex + 1)) return null;
			return { workspaceId: activeDrag.workspaceId, anchor };
		}

		/**
		 * Compact relative time bucket ("now" or a { unit, n } pair), matching
		 * the upstream primitives' `relativeTime` units the dictionary covers.
		 */
		function relativeTime(updatedAt, now) {
			const delta = Math.max(0, now - updatedAt);
			const minute = 60 * 1000;
			const hour = 60 * minute;
			const day = 24 * hour;
			const month = 30 * day;
			const year = 365 * day;
			if (delta < minute) return { unit: "now", n: 0 };
			if (delta < hour) return { unit: "minutes", n: Math.floor(delta / minute) };
			if (delta < day) return { unit: "hours", n: Math.floor(delta / hour) };
			if (delta < month) return { unit: "days", n: Math.floor(delta / day) };
			if (delta < year) return { unit: "months", n: Math.floor(delta / month) };
			return { unit: "years", n: Math.floor(delta / year) };
		}

		/** Localized compact relative time for the row's trailing cell. */
		function timeLabel(updatedAt, now) {
			const { unit, n } = relativeTime(updatedAt, now);
			return unit === "now" ? t("time.now") : t(`time.${unit}`, { n });
		}

		/* ---------------------------------------------------------------- icons */
		// Dependency-free inline glyphs (the upstream primitives are not
		// importable from a profile bundle, so every icon is drawn here).

		function svgWrap(children) {
			return react.createElement("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16",
				fill: "none", stroke: "currentColor", strokeWidth: 1.5,
				"aria-hidden": "true",
			}, ...children);
		}

		/** 16px archive (box) glyph, stroke-only so it follows `color`. */
		function IconArchive() {
			return svgWrap([
				react.createElement("rect", { key: "b", x: 2, y: 3.5, width: 12, height: 9, rx: 1 }),
				react.createElement("path", { key: "m", d: "M2 6.5h12M6.5 8.5h3" }),
				react.createElement("path", { key: "l", d: "M6 3.5V2h4v1.5" }),
			]);
		}

		/** 16px horizontal ellipsis glyph. */
		function IconEllipsis() {
			return react.createElement("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "currentColor", "aria-hidden": "true",
			},
				react.createElement("circle", { cx: 3, cy: 8, r: 1.4 }),
				react.createElement("circle", { cx: 8, cy: 8, r: 1.4 }),
				react.createElement("circle", { cx: 13, cy: 8, r: 1.4 }),
			);
		}

		/** 16px search glyph. */
		function IconSearch() {
			return svgWrap([
				react.createElement("circle", { key: "c", cx: 7, cy: 7, r: 4.5 }),
				react.createElement("path", { key: "h", d: "M10.5 10.5 14 14" }),
			]);
		}

		/** 16px plus glyph. */
		function IconPlus() {
			return svgWrap([react.createElement("path", { key: "p", d: "M8 3v10M3 8h10" })]);
		}

		/** 16px pencil glyph. */
		function IconEdit() {
			return svgWrap([
				react.createElement("path", { key: "e", d: "M11.5 2.5 13.5 4.5 5.5 12.5 2.5 13.5 3.5 10.5Z" }),
			]);
		}

		/** 16px branch glyph. */
		function IconBranch() {
			return svgWrap([
				react.createElement("circle", { key: "a", cx: 5, cy: 4, r: 1.8 }),
				react.createElement("circle", { key: "b", cx: 5, cy: 12, r: 1.8 }),
				react.createElement("circle", { key: "c", cx: 11, cy: 8, r: 1.8 }),
				react.createElement("path", { key: "p", d: "M5 5.8v4.4M5 8c0-2 4-1 4-1" }),
			]);
		}

		/** 16px trash glyph. */
		function IconTrash() {
			return svgWrap([
				react.createElement("path", { key: "t", d: "M2.5 4h11M6.5 4V2.5h3V4M4 4l.7 9.5h6.6L12 4" }),
			]);
		}

		/** 16px closed-folder glyph. */
		function IconFolderClose() {
			return svgWrap([
				react.createElement("path", { key: "f", d: "M2 4.5c0-.8.7-1.5 1.5-1.5h2L7 4.5h5.5c.8 0 1.5.7 1.5 1.5v5c0 .8-.7 1.5-1.5 1.5h-9C2.7 12.5 2 11.8 2 11Z" }),
			]);
		}

		/** 16px open-folder glyph. */
		function IconFolderOpen() {
			return svgWrap([
				react.createElement("path", { key: "f", d: "M2 5.5c0-.8.7-1.5 1.5-1.5h2L7 5.5h5.5c.8 0 1.6.7 1.5 1.6l-.5 3.9c-.1.8-.7 1.5-1.5 1.5h-9c-.8 0-1.4-.7-1.3-1.5Z" }),
			]);
		}

		/** 14px right-triangle glyph for the group chevron. */
		function IconTriangle() {
			return react.createElement("svg", {
				width: 14, height: 14, viewBox: "0 0 14 14", fill: "currentColor", "aria-hidden": "true",
			}, react.createElement("path", { d: "M5 3.5v7l5-3.5Z" }));
		}

		/** 16px alarm-clock glyph for the active-schedule marker. */
		function IconAlarmClock() {
			return svgWrap([
				react.createElement("circle", { key: "c", cx: 8, cy: 9, r: 4.5 }),
				react.createElement("path", { key: "h", d: "M8 6.8V9l1.6 1M3.5 2.5 2 4M12.5 2.5 14 4" }),
			]);
		}

		/** 16px sliders glyph for the view-options button. */
		function IconViewOptions() {
			return svgWrap([
				react.createElement("path", { key: "l", d: "M2.5 5h11M2.5 11h11" }),
				react.createElement("circle", { key: "a", cx: 6, cy: 5, r: 1.6 }),
				react.createElement("circle", { key: "b", cx: 10, cy: 11, r: 1.6 }),
			]);
		}

		/* ------------------------------------------------------- row fragments */

		/** Primary status dot plus every status's screen-reader label. */
		function SessionStatusDots({ statuses }) {
			return react.createElement(react.Fragment, null,
				react.createElement("span", {
					className: "dsh-sa-dot dsh-sa-dot-" + statuses[0].state,
					role: "img",
					"aria-label": statuses[0].label,
					title: statuses[0].label,
				}),
				statuses.map((status) => react.createElement("span", {
					key: status.label,
					className: "dsh-sa-visuallyhidden",
				}, status.label)),
			);
		}

		/**
		 * Session status presentation; pending interaction is primary and live
		 * activity outranks completion reminders. (Upstream sessionStatuses.)
		 */
		function sessionStatuses(node) {
			const subagents = node.runningSubagentCount === 0
				? undefined
				: {
					state: "ongoing",
					label: t(node.runningSubagentCount === 1
						? "status.subagentsRunning.one"
						: "status.subagentsRunning.other", { n: node.runningSubagentCount }),
				};
			let pending;
			switch (node.pendingInteraction) {
				case "approval": pending = { state: "warning", label: t("status.waitingApproval") }; break;
				case "plan-review": pending = { state: "warning", label: t("status.planReview") }; break;
				case "question": pending = { state: "warning", label: t("status.waitingAnswer") }; break;
				case undefined: break;
				default: break;
			}
			if (pending !== undefined) return subagents === undefined ? [pending] : [pending, subagents];
			if (node.running) {
				const primary = { state: "ongoing", label: t("status.running") };
				return subagents === undefined ? [primary] : [primary, subagents];
			}
			if (subagents !== undefined) return [subagents];
			if (node.completed) return [{ state: "done", label: t("status.completed") }];
			return [{ state: "done", label: t("status.idle") }];
		}

		/** Non-interactive active-schedule marker; the enclosing row remains the only action. */
		function ActiveScheduleIndicator({ search }) {
			const label = t("schedule.active");
			return react.createElement("span", {
				className: "dsh-sa-schedule" + (search ? " dsh-sa-schedulesearch" : ""),
				role: "img",
				"aria-label": label,
				title: label,
			}, react.createElement(IconAlarmClock, null));
		}

		/**
		 * One flat search result: title, workspace context, optional content
		 * excerpt. Search navigation opens the session only.
		 */
		function SearchResultItem({ result, currentId, onOpen }) {
			const selected = result.id === currentId;
			const statuses = sessionStatuses(result);
			const primaryStatus = statuses[0];
			return react.createElement("button", {
				type: "button",
				className: "dsh-sa-searchrow" + (selected ? " dsh-sa-selected" : ""),
				role: "treeitem",
				"aria-selected": selected,
				onClick: () => { onOpen(result.id); },
			},
				react.createElement("span", { className: "dsh-sa-searchhead" },
					react.createElement("span", { className: "dsh-sa-slot" },
						(primaryStatus.state !== "done" || result.completed) &&
							react.createElement(SessionStatusDots, { statuses }),
					),
					react.createElement("span", { className: "dsh-sa-searchtitle" }, result.title),
					result.hasActiveSchedule && react.createElement(ActiveScheduleIndicator, { search: true }),
				),
				react.createElement("span", { className: "dsh-sa-searchmeta" },
					react.createElement("span", { className: "dsh-sa-searchws" },
						result.workspace || t("group.ungrouped")),
					result.snippet !== undefined &&
						react.createElement("span", { className: "dsh-sa-searchsnippet" }, result.snippet),
				),
			);
		}

		/**
		 * Project (workspace) header row: folder + title; hover reveals the
		 * chevron and create button. (Upstream ProjectRowItem, minus the hover
		 * card, which needs the primitives package — `title` tooltips stay.)
		 */
		function ProjectRowItem({ group, onToggle, onCreate, actions, drag }) {
			const row = group;
			const label = row.workspaceId === undefined ? t("group.ungrouped") : row.label;
			const active = group.expanded && group.containsCurrent;
			const [menuOpen, setMenuOpen] = react.useState(false);
			const workspaceMenuItems = [
				{ id: "rename", label: t("rename") },
				{ id: "delete", label: t("delete.workspace"), danger: true },
			];
			return react.createElement("div", {
				className: "dsh-sa-projectrow" + (menuOpen ? " dsh-sa-menuopen" : ""),
				role: "treeitem",
				"aria-expanded": row.expanded,
				"data-group-key": row.key,
				title: row.cwd !== undefined ? row.cwd : label,
				onClick: onToggle,
				draggable: drag !== undefined,
				onDragStart: drag === undefined ? undefined : (e) => {
					e.dataTransfer.effectAllowed = "move";
					e.dataTransfer.setData("text/plain", row.key);
					drag.start();
				},
				onDragEnd: drag?.end,
			},
				react.createElement("span", {
					className: "dsh-sa-slot dsh-sa-folder" + (active ? " dsh-sa-folderactive" : ""),
				}, row.expanded
					? react.createElement(IconFolderOpen, null)
					: react.createElement(IconFolderClose, null)),
				react.createElement("span", { className: "dsh-sa-slot dsh-sa-chevron" },
					react.createElement("span", {
						className: "dsh-sa-arrow" + (row.expanded ? " dsh-sa-arrowopen" : ""),
					}, react.createElement(IconTriangle, null))),
				react.createElement("span", { className: "dsh-sa-projecttext" },
					react.createElement("span", { className: "dsh-sa-title" }, label)),
				react.createElement("span", { className: "dsh-sa-actions" },
					(actions !== undefined) && react.createElement("span", { className: "dsh-sa-menusep" },
						react.createElement("button", {
							type: "button",
							className: "dsh-sa-iconbtn",
							"aria-label": t("actions.workspace.aria", { name: label }),
							"aria-expanded": menuOpen,
							onClick: (e) => { e.stopPropagation(); setMenuOpen((v) => !v); },
						}, react.createElement(IconEllipsis, null)),
						menuOpen && react.createElement("span", {
							className: "dsh-sa-menu",
							role: "menu",
							onMouseLeave: () => { setMenuOpen(false); },
						}, workspaceMenuItems.map((item) => react.createElement("button", {
							key: item.id,
							type: "button",
							className: "dsh-sa-menuitem" + (item.danger ? " dsh-sa-danger" : ""),
							role: "menuitem",
							onClick: (e) => {
								e.stopPropagation();
								setMenuOpen(false);
								if (item.id !== "rename" && item.id !== "delete") return;
								if (item.id === "rename") actions.rename();
								else actions.delete();
							},
						}, item.label)))),
					react.createElement("button", {
						type: "button",
						className: "dsh-sa-iconbtn",
						"aria-label": t("actions.newSession.aria", { name: label }),
						title: t("actions.newSession.aria", { name: label }),
						onClick: (e) => { e.stopPropagation(); onCreate(); },
					}, react.createElement(IconPlus, null)),
				),
			);
		}

		/**
		 * One top-level 32px session row: status dot, title, relative time, and
		 * the hover actions cell.
		 *
		 * THE PLUGIN'S DIFF: the actions cell holds a one-click archive button
		 * BESIDE the `...` menu. It calls `onArchive(node.id)` directly — no
		 * dialog — and stops propagation so the row's own open click never
		 * fires. Everything else mirrors upstream `SessionNodeItem`.
		 */
		function SessionRow({ node, currentId, now, onOpen, onRename, onFork, onArchive, onReveal, drag, flat }) {
			const row = node;
			const title = node.blank ? t("session.new") : node.title;
			const selected = node.id === currentId;
			const statuses = sessionStatuses(node);
			const showStatus = statuses[0].state !== "done" || row.completed;
			const draggable = drag !== undefined && !row.blank;
			const [menuOpen, setMenuOpen] = react.useState(false);
			const [renameOpen, setRenameOpen] = react.useState(false);
			const [renameDraft, setRenameDraft] = react.useState("");
			const [renameBusy, setRenameBusy] = react.useState(false);
			const [renameError, setRenameError] = react.useState(null);
			const rowRef = react.useRef(null);
			react.useEffect(() => {
				if (onReveal === undefined) return undefined;
				if (rowRef.current !== null && typeof rowRef.current.scrollIntoView === "function") {
					rowRef.current.scrollIntoView({ block: "nearest" });
				}
				onReveal();
				return undefined;
			}, [onReveal]);

			// Archive hides the row through the registry-global archive set and
			// never touches the session log, so it is not styled as destructive
			// and needs no confirmation dialog. (Upstream comment, kept.)
			const sessionMenuItems = [
				{ id: "rename", label: t("rename") },
				{ id: "fork", label: t("menu.fork") },
				{ id: "archive", label: t("menu.archiveSession") },
			];

			const openRename = () => {
				setMenuOpen(false);
				setRenameDraft(row.title);
				setRenameError(null);
				setRenameOpen(true);
			};
			const confirmRename = () => {
				const next = renameDraft.trim();
				if (renameBusy || next === "" || onRename === undefined) return;
				setRenameBusy(true);
				setRenameError(null);
				Promise.resolve()
					.then(() => onRename(node.id, next))
					.then(() => {
						setRenameBusy(false);
						setRenameOpen(false);
					})
					.catch((reason) => {
						setRenameBusy(false);
						setRenameError(reason instanceof Error ? reason.message : String(reason));
					});
			};
			const selectMenuItem = (id) => {
				setMenuOpen(false);
				if (id === "rename") openRename();
				else if (id === "fork" && onFork !== undefined) onFork(node.id);
				else if (id === "archive") onArchive(node.id);
			};

			return react.createElement("div", {
				ref: rowRef,
				className: "dsh-sa-row" +
					(selected ? " dsh-sa-selected" : "") +
					(menuOpen ? " dsh-sa-menuopen" : "") +
					(flat && !showStatus ? " dsh-sa-flatnostatus" : "") +
					(drag?.marker === "before" ? " dsh-sa-dropbefore" : "") +
					(drag?.marker === "after" ? " dsh-sa-dropafter" : ""),
				role: "treeitem",
				"aria-selected": selected,
				"data-session-id": node.id,
				title,
				onClick: () => { onOpen(node.id); },
				draggable,
				onDragStart: (drag === undefined || row.blank) ? undefined : (e) => {
					e.dataTransfer.effectAllowed = "move";
					e.dataTransfer.setData("text/plain", node.id);
					drag.start();
				},
				onDragEnd: (drag === undefined || row.blank) ? undefined : drag.end,
				onDragOver: drag === undefined ? undefined : (e) => {
					if (!drag.active) return;
					e.preventDefault();
					e.dataTransfer.dropEffect = "move";
					drag.hover(rowHalf(e));
				},
				onDrop: drag === undefined ? undefined : (e) => {
					if (!drag.active) return;
					e.preventDefault();
					drag.drop(rowHalf(e));
				},
			},
				((!flat) || showStatus) && react.createElement("span", { className: "dsh-sa-slot" },
					showStatus && react.createElement(SessionStatusDots, { statuses })),
				react.createElement("span", { className: "dsh-sa-title" }, title),
				row.hasActiveSchedule && react.createElement(ActiveScheduleIndicator, {}),
				(!row.blank) && react.createElement("span", { className: "dsh-sa-time" },
					timeLabel(row.updatedAt, now)),
				(!row.blank) && react.createElement("span", { className: "dsh-sa-actions" },
					react.createElement("button", {
						type: "button",
						className: "dsh-sa-iconbtn dsh-sa-archive",
						"aria-label": t("actions.session.aria", { name: `${title} — ${t("menu.archiveSession")}` }),
						title: t("menu.archiveSession"),
						onClick: (e) => {
							e.stopPropagation();
							onArchive(node.id);
						},
					}, react.createElement(IconArchive, null)),
					react.createElement("span", { className: "dsh-sa-menusep" },
						react.createElement("button", {
							type: "button",
							className: "dsh-sa-iconbtn",
							"aria-label": t("actions.session.aria", { name: title }),
							"aria-expanded": menuOpen,
							onClick: (e) => { e.stopPropagation(); setMenuOpen((v) => !v); },
						}, react.createElement(IconEllipsis, null)),
						menuOpen && react.createElement("span", {
							className: "dsh-sa-menu",
							role: "menu",
							onMouseLeave: () => { setMenuOpen(false); },
						}, sessionMenuItems.map((item) => react.createElement("button", {
							key: item.id,
							type: "button",
							className: "dsh-sa-menuitem",
							role: "menuitem",
							onClick: (e) => {
								e.stopPropagation();
								selectMenuItem(item.id);
							},
						}, item.label)))),
				),
				renameOpen && react.createElement("span", {
					className: "dsh-sa-modalwrap",
					onClick: (e) => { e.stopPropagation(); },
				},
					react.createElement("span", {
						className: "dsh-sa-modal",
						role: "dialog",
						"aria-label": t("rename.session.title"),
					},
						react.createElement("input", {
							className: "dsh-sa-renameinput",
							value: renameDraft,
							"aria-label": t("field.sessionName"),
							autoFocus: true,
							disabled: renameBusy,
							onChange: (e) => {
								setRenameDraft(e.target.value);
								setRenameError(null);
							},
							onKeyDown: (e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									confirmRename();
								} else if (e.key === "Escape") {
									setRenameOpen(false);
								}
							},
							onClick: (e) => { e.stopPropagation(); },
						}),
						renameError !== null && react.createElement("span", {
							className: "dsh-sa-error",
							role: "alert",
						}, renameError),
						react.createElement("span", { className: "dsh-sa-modalrow" },
							react.createElement("button", {
								type: "button",
								className: "dsh-sa-btn",
								disabled: renameBusy,
								onClick: (e) => {
									e.stopPropagation();
									setRenameOpen(false);
								},
							}, t("cancel")),
							react.createElement("button", {
								type: "button",
								className: "dsh-sa-btn dsh-sa-primary",
								disabled: renameBusy || renameDraft.trim() === "",
								onClick: (e) => {
									e.stopPropagation();
									confirmRename();
								},
							}, t("rename")),
						),
					),
				),
			);
		}

		/** Grouping and ordering menu; own open state so it resets with the wide chrome. */
		function ViewOptionsMenu({ groupBy, orderBy, onGroupPick, onOrderPick }) {
			const [open, setOpen] = react.useState(false);
			const pick = (id) => {
				if (id === "workspace" || id === "flat") onGroupPick(id);
				else if (id === "manual" || id === "updated") onOrderPick(id);
				setOpen(false);
			};
			const item = (id, label, selected) => react.createElement("button", {
				key: id,
				type: "button",
				className: "dsh-sa-menuitem",
				role: "menuitemradio",
				"aria-checked": selected,
				onClick: (e) => { e.stopPropagation(); pick(id); },
			},
				react.createElement("span", { className: "dsh-sa-check" }, selected ? "✓" : ""),
				label);
			return react.createElement("span", { className: "dsh-sa-menusep" },
				react.createElement("button", {
					type: "button",
					className: "dsh-sa-iconbtn",
					"aria-label": t("viewOptions.label"),
					title: t("viewOptions.label"),
					"aria-expanded": open,
					onClick: () => { setOpen((v) => !v); },
				}, react.createElement(IconViewOptions, null)),
				open && react.createElement("span", {
					className: "dsh-sa-menu dsh-sa-viewmenu",
					role: "menu",
					onMouseLeave: () => { setOpen(false); },
				},
					react.createElement("span", { className: "dsh-sa-menulabel" }, t("groupBy.label")),
					item("workspace", t("groupBy.workspace"), groupBy === "workspace"),
					item("flat", t("groupBy.flat"), groupBy === "flat"),
					react.createElement("span", { className: "dsh-sa-menusep-line" }),
					react.createElement("span", { className: "dsh-sa-menulabel" }, t("orderBy.label")),
					item("manual", t("orderBy.manual"), orderBy === "manual"),
					item("updated", t("orderBy.updated"), orderBy === "updated")),
			);
		}

		/* --------------------------------------------- drag acceptance + row wiring */

		/**
		 * Accept the native drag at document level while a row drag is active.
		 * (Upstream useNativeDragAcceptance.)
		 */
		function useNativeDragAcceptance(active) {
			react.useEffect(() => {
				if (!active || typeof document === "undefined") return undefined;
				const acceptDrag = (event) => {
					event.preventDefault();
					if (event.dataTransfer !== null) event.dataTransfer.dropEffect = "move";
				};
				const acceptDrop = (event) => { event.preventDefault(); };
				document.addEventListener("dragover", acceptDrag);
				document.addEventListener("drop", acceptDrop);
				return () => {
					document.removeEventListener("dragover", acceptDrag);
					document.removeEventListener("drop", acceptDrop);
				};
			}, [active]);
		}

		/* ------------------------------------------------------- session tree */

		/**
		 * The scrolling session tree; unmounting drops the expand-all state.
		 * (Upstream SessionTree, with the pure commit math factored out so it
		 * stays testable without a browser.)
		 */
		function SessionTree({
			list, useSessionPendingInteraction, startSession, open, forkSession,
			workspaces, orderedWorkspaces, ungroupedSessionIds,
			archivedSessionIds, workspaceReady, usePanelInfo,
			onRenameRequest, onDeleteRequest, onSessionRename, onSessionArchive,
			insertWorkspaceBefore, insertSessionBefore,
			orderBy, groupExpansion, setGroupExpanded, setSessionOrder,
			revealSessionId, onSessionRevealed,
		}) {
			const panelActive = typeof usePanelInfo === "function"
				? usePanelInfo((info) => info.activePanelId !== null)
				: false;
			const pendingInteractions = useSessionPendingInteraction((s) => s);
			const current = panelActive ? undefined : list.current;
			const revealGroup = revealSessionId === undefined || !workspaceReady
				? undefined
				: owningGroupKey(workspaces, revealSessionId);
			const [expandedSessionGroups, setExpandedSessionGroups] = react.useState([]);
			const [drag, setDrag] = react.useState(null);
			const sessionDropCommitted = react.useRef(false);
			const [workspaceDrag, setWorkspaceDrag] = react.useState(null);
			const workspaceDropCommitted = react.useRef(false);
			useNativeDragAcceptance(drag !== null || workspaceDrag !== null);

			const currentGroup = current === undefined || !workspaceReady
				? undefined
				: owningGroupKey(workspaces, current);
			react.useEffect(() => {
				if (current === undefined || currentGroup === undefined ||
					Object.hasOwn(groupExpansion, currentGroup)) return undefined;
				setGroupExpanded(currentGroup, true);
				return undefined;
			}, [current, currentGroup, setGroupExpanded, groupExpansion]);
			const expandedGroups = Object.entries(groupExpansion)
				.filter(([, expanded]) => expanded)
				.map(([key]) => key);
			const groups = deriveGroups(list, orderedWorkspaces, archivedSessionIds, pendingInteractions, {
				expandedGroups,
				ungroupedOrder: ungroupedSessionIds,
			});
			react.useEffect(() => {
				if (revealGroup === undefined || groupExpansion[revealGroup] === true) return undefined;
				setGroupExpanded(revealGroup, true);
				return undefined;
			}, [groupExpansion, revealGroup, setGroupExpanded]);
			react.useEffect(() => {
				if (revealSessionId === undefined || revealGroup === undefined) return undefined;
				const group = groups.find((candidate) => candidate.key === revealGroup);
				if (group === undefined || !group.expanded ||
					!group.sessions.some((row) => row.id === revealSessionId)) return undefined;
				if (collapsedSessionRows(group.sessions).rows.some((row) => row.id === revealSessionId)) return undefined;
				setExpandedSessionGroups((keys) => keys.includes(revealGroup) ? keys : [...keys, revealGroup]);
				return undefined;
			}, [groups, revealGroup, revealSessionId]);

			const accountIds = {};
			for (const workspace of orderedWorkspaces) accountIds[workspace.workspaceId] = workspace.sessionIds;
			accountIds[UNGROUPED_KEY] = ungroupedSessionIds;

			const now = Date.now();
			const commitDrag = (activeDrag, over) => {
				if (sessionDropCommitted.current) return;
				sessionDropCommitted.current = true;
				setDrag(null);
				const commit = commitSessionDrop({
					groups, expandedKeys: expandedSessionGroups,
					accountIds, orderBy, activeDrag, over,
				});
				if (commit === null) return;
				setSessionOrder(commit.accountKey, commit.nextOrder);
				if (!commit.callHost) return;
				insertSessionBefore(commit.accountKey, commit.sessionId, commit.anchor).catch((reason) => {
					console.warn("session reorder rejected:", reason);
				});
			};
			const commitWSDrag = (activeDrag, over) => {
				if (workspaceDropCommitted.current) return;
				workspaceDropCommitted.current = true;
				setWorkspaceDrag(null);
				const commit = commitWorkspaceDrop({ workspaces: orderedWorkspaces, activeDrag, over });
				if (commit === null) return;
				insertWorkspaceBefore(commit.workspaceId, commit.anchor).catch((reason) => {
					console.warn("workspace reorder rejected:", reason);
				});
			};
			const workspaceDropAtListStart = groups[0]?.workspaceId !== undefined &&
				workspaceDrag?.over?.id === groups[0].workspaceId &&
				workspaceDrag.over.half === "before";

			const toggled = (keys, key) =>
				keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key];

			return react.createElement("div", { className: "dsh-sa-treebody" },
				workspaceDropAtListStart && react.createElement("span", {
					className: "dsh-sa-listtopdrop",
					"aria-hidden": "true",
				}),
				react.createElement("div", {
					className: "dsh-sa-list" + (workspaceDropAtListStart ? " dsh-sa-listtopactive" : ""),
					role: "tree",
					"aria-label": t("section.sessions"),
				},
					groups.length === 0 && react.createElement("div", { className: "dsh-sa-empty" }, t("empty.none")),
					groups.map((group) => {
						const workspaceId = group.workspaceId;
						const collapsed = collapsedSessionRows(group.sessions);
						const sessionsExpanded = expandedSessionGroups.includes(group.key);
						const workspaceMarker = workspaceId !== undefined && workspaceDrag?.over?.id === workspaceId
							? workspaceDrag.over.half
							: null;
						const wsDragProps = workspaceId === undefined ? undefined : {
							start: () => {
								workspaceDropCommitted.current = false;
								setWorkspaceDrag({ workspaceId, over: null });
							},
							end: () => {
								if (workspaceDrag?.over !== null && workspaceDrag?.over !== undefined) {
									commitWSDrag(workspaceDrag, workspaceDrag.over);
								} else {
									setWorkspaceDrag(null);
								}
								workspaceDropCommitted.current = false;
							},
						};
						const hoverWorkspace = workspaceId === undefined
							? undefined
							: (half) => {
								setWorkspaceDrag((active) => active === null
									? active
									: { ...active, over: { id: workspaceId, half } });
							};
						const dropWorkspace = workspaceId === undefined
							? undefined
							: (half) => {
								if (workspaceDrag === null) return;
								commitWSDrag(workspaceDrag, { id: workspaceId, half });
							};
						return react.createElement("div", {
							key: group.key,
							className: "dsh-sa-group" +
								(workspaceMarker === "before" ? " dsh-sa-wsdrobefore" : "") +
								(workspaceMarker === "after" ? " dsh-sa-wsdropafter" : ""),
							onDragOver: (workspaceDrag === null || hoverWorkspace === undefined)
								? undefined
								: (e) => {
									e.preventDefault();
									e.dataTransfer.dropEffect = "move";
									const rect = e.currentTarget.getBoundingClientRect();
									hoverWorkspace(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
								},
							onDrop: (workspaceDrag === null || dropWorkspace === undefined)
								? undefined
								: (e) => {
									e.preventDefault();
									const rect = e.currentTarget.getBoundingClientRect();
									dropWorkspace(e.clientY < rect.top + rect.height / 2 ? "before" : "after");
								},
						},
							react.createElement(ProjectRowItem, {
								group,
								onToggle: () => {
									if (group.expanded) {
										setExpandedSessionGroups((keys) => keys.filter((key) => key !== group.key));
									}
									setGroupExpanded(group.key, !group.expanded);
								},
								onCreate: () => {
									if (group.workspaceId !== undefined) {
										setGroupExpanded(group.key, true);
										startSession(group.workspaceId);
									}
								},
								drag: wsDragProps,
								actions: group.workspaceId === undefined
									? undefined
									: {
										rename: () => {
											if (group.workspaceId !== undefined) {
												onRenameRequest(group.workspaceId, group.label);
											}
										},
										delete: () => {
											if (group.workspaceId !== undefined) {
												onDeleteRequest(group.workspaceId, group.label);
											}
										},
									},
							}),
							(sessionsExpanded ? group.sessions : collapsed.rows).map((node) => {
								const sameGroupDrag = drag !== null && drag.accountKey === group.key;
								const normalizeHalf = (half) => (node.blank ? "after" : half);
								return react.createElement(SessionRow, {
									key: node.id,
									node,
									currentId: current,
									now,
									onOpen: open,
									onRename: onSessionRename,
									onFork: forkSession,
									onArchive: onSessionArchive,
									onReveal: node.id === revealSessionId && group.key === revealGroup
										? () => { onSessionRevealed(node.id); }
										: undefined,
									drag: {
										start: () => {
											sessionDropCommitted.current = false;
											setDrag({ accountKey: group.key, sessionId: node.id, over: null });
										},
										active: sameGroupDrag,
										marker: sameGroupDrag && drag.over?.id === node.id ? drag.over.half : null,
										hover: (half) => {
											setDrag((d) => (d === null ? d : {
												...d, over: { id: node.id, half: normalizeHalf(half) },
											}));
										},
										drop: (half) => {
											if (drag === null) return;
											commitDrag(drag, { id: node.id, half: normalizeHalf(half) });
										},
										end: () => {
											if (drag?.over !== null && drag?.over !== undefined) {
												commitDrag(drag, drag.over);
											} else setDrag(null);
											sessionDropCommitted.current = false;
										},
									},
								});
							}),
							collapsed.hiddenCount > 0 && react.createElement("button", {
								type: "button",
								className: "dsh-sa-overflow",
								"aria-expanded": sessionsExpanded,
								onClick: () => { setExpandedSessionGroups((keys) => toggled(keys, group.key)); },
							}, sessionsExpanded
								? t("sessions.collapse")
								: t("sessions.expand", { n: collapsed.hiddenCount })),
						);
					})),
				react.createElement("span", { className: "dsh-sa-fade" }),
			);
		}

		/* ------------------------------------------------------------- flat list */

		/**
		 * The flat "In one list" body: every session is one draggable
		 * top-level row. (Upstream FlatList; the host reorder call does not
		 * apply here — upstream commits flat drags to the local order only.)
		 */
		function FlatList({
			list, sessionIds, useSessionPendingInteraction, open, forkSession,
			onSessionRename, onSessionArchive, usePanelInfo, setSessionOrder,
			revealSessionId, onSessionRevealed,
		}) {
			const panelActive = typeof usePanelInfo === "function"
				? usePanelInfo((info) => info.activePanelId !== null)
				: false;
			const pendingInteractions = useSessionPendingInteraction((s) => s);
			const rows = deriveFlat(list, sessionIds, pendingInteractions);
			const [drag, setDrag] = react.useState(null);
			const dropCommitted = react.useRef(false);
			useNativeDragAcceptance(drag !== null);

			const groups = [{ key: FLAT_SESSION_ORDER_KEY, sessions: rows }];
			const commitDrag = (activeDrag, over) => {
				if (dropCommitted.current) return;
				dropCommitted.current = true;
				setDrag(null);
				const commit = commitSessionDrop({
					groups,
					expandedKeys: [FLAT_SESSION_ORDER_KEY],
					accountIds: { [FLAT_SESSION_ORDER_KEY]: rows.map((row) => row.id) },
					orderBy: "manual",
					activeDrag,
					over,
				});
				if (commit === null) return;
				setSessionOrder(FLAT_SESSION_ORDER_KEY, commit.nextOrder);
			};

			const now = Date.now();
			return react.createElement("div", { className: "dsh-sa-treebody" },
				react.createElement("div", {
					className: "dsh-sa-list dsh-sa-flatlist",
					role: "tree",
					"aria-label": t("section.sessions"),
				},
					rows.length === 0 && react.createElement("div", { className: "dsh-sa-empty" }, t("empty.none")),
					rows.map((node) => {
						const active = drag !== null;
						return react.createElement(SessionRow, {
							key: node.id,
							node,
							currentId: panelActive ? undefined : list.current,
							now,
							onOpen: open,
							onRename: onSessionRename,
							onFork: forkSession,
							onArchive: onSessionArchive,
							onReveal: node.id === revealSessionId
								? () => { onSessionRevealed(node.id); }
								: undefined,
							flat: true,
							drag: {
								start: () => {
									dropCommitted.current = false;
									setDrag({
										accountKey: FLAT_SESSION_ORDER_KEY,
										sessionId: node.id,
										over: null,
									});
								},
								active,
								marker: active && drag.over?.id === node.id ? drag.over.half : null,
								hover: (half) => {
									setDrag((current) => current === null ? current : {
										...current,
										over: { id: node.id, half },
									});
								},
								drop: (half) => {
									if (drag === null) return;
									commitDrag(drag, { id: node.id, half });
								},
								end: () => {
									if (drag?.over !== null && drag?.over !== undefined) {
										commitDrag(drag, drag.over);
									} else setDrag(null);
									dropCommitted.current = false;
								},
							},
						});
					})),
				react.createElement("span", { className: "dsh-sa-fade" }),
			);
		}

		/* -------------------------------------------------------- search results */

		/** Flat search body: local metadata matches plus the Host result page. */
		function SearchResults({
			list, useSessionPendingInteraction, open, workspaces,
			archivedSessionIds, query, remote, resultLimit, usePanelInfo,
		}) {
			const panelActive = typeof usePanelInfo === "function"
				? usePanelInfo((info) => info.activePanelId !== null)
				: false;
			const pendingInteractions = useSessionPendingInteraction((s) => s);
			const currentRemote = remote.query === query ? remote : {
				query,
				status: "loading",
				items: [],
				hasMore: false,
			};
			const results = deriveSearchResults(
				list, workspaces, query, archivedSessionIds, pendingInteractions, currentRemote, resultLimit);
			const pending = currentRemote.status === "loading";
			const failed = currentRemote.status === "error";
			return react.createElement("div", { className: "dsh-sa-treebody" },
				react.createElement("div", { className: "dsh-sa-list" },
					react.createElement("div", {
						className: "dsh-sa-searchtree",
						role: "tree",
						"aria-label": t("search.results.aria"),
					}, results.items.map((result) => react.createElement(SearchResultItem, {
						key: result.id,
						result,
						currentId: panelActive ? undefined : list.current,
						onOpen: open,
					}))),
					pending && react.createElement("div", {
						className: "dsh-sa-searchstatus",
						role: "status",
					}, t("search.pending")),
					failed && react.createElement("div", {
						className: "dsh-sa-searchwarn",
						role: "status",
					}, t("search.unavailable")),
					(!pending && results.items.length === 0) && react.createElement("div", {
						className: "dsh-sa-empty",
					}, t("search.noMatches")),
					results.hasMore && react.createElement("div", {
						className: "dsh-sa-searchstatus",
					}, t("search.hasMore", { n: resultLimit })),
				),
				react.createElement("span", { className: "dsh-sa-fade" }),
			);
		}

		/* ------------------------------------------------------------ view state */
		// Upstream persists this through the store engine
		// (`dsh.workspace.view.v5`); here it lives in component state with a
		// localStorage mirror under the same key (best effort, guarded).

		function defaultViewState() {
			return {
				groupBy: "workspace",
				orderBy: "updated",
				groupExpansion: {},
				sessionOrderByAccount: {},
			};
		}

		function loadViewState() {
			const fresh = defaultViewState();
			try {
				if (typeof localStorage === "undefined") return fresh;
				const raw = localStorage.getItem(VIEW_STORE_KEY);
				if (raw === null) return fresh;
				const parsed = JSON.parse(raw);
				return {
					groupBy: parsed.groupBy === "flat" ? "flat" : "workspace",
					orderBy: parsed.orderBy === "manual" ? "manual" : "updated",
					groupExpansion: (parsed.groupExpansion !== null &&
						typeof parsed.groupExpansion === "object" &&
						!Array.isArray(parsed.groupExpansion))
						? parsed.groupExpansion
						: {},
					sessionOrderByAccount: (parsed.sessionOrderByAccount !== null &&
						typeof parsed.sessionOrderByAccount === "object" &&
						!Array.isArray(parsed.sessionOrderByAccount))
						? parsed.sessionOrderByAccount
						: {},
				};
			} catch {
				return fresh;
			}
		}

		function saveViewState(view) {
			try {
				if (typeof localStorage === "undefined") return;
				localStorage.setItem(VIEW_STORE_KEY, JSON.stringify(view));
			} catch {
				// Persistence is best effort; the pane works without it.
			}
		}

		/* ------------------------------------------------------------ archive pane */

		/**
		 * The browsing region: section header (title + view options + add
		 * workspace), search, the grouped tree or flat list, and the workspace
		 * dialogs. Wide state renders the full browser; rail state renders the
		 * search control that requests expansion through the owner share.
		 * (Upstream WorkspaceBrowser.)
		 */
		function ArchivePane({
			wide, expandSidebar,
			useSessions, useSessionPendingInteraction, useWorkspaces, usePanelInfo,
			useDirectoryFlow, renderSlot,
			startSession, open, renameSession, forkSession,
			renameWorkspace, deleteWorkspace, insertWorkspaceBefore,
			archiveSession, insertSessionBefore, createWorkspace,
			searchSessions, searchResultLimit,
		}) {
			const list = useSessions((s) => s);
			const pendingInteractions = useSessionPendingInteraction((s) => s);
			const workspaces = useWorkspaces((state) => state.items) ?? [];
			const workspacePhase = useWorkspaces((state) => state.phase);
			const workspaceStreamState = useWorkspaces((state) => state.state);
			const archivedSessionIds = useWorkspaces((state) => state.archivedSessionIds) ?? [];
			const flowOccupied = useDirectoryFlow((occupied) => occupied);

			const [view, setView] = react.useState(loadViewState);
			const patchView = (patch) => {
				setView((prev) => {
					const next = { ...prev, ...(typeof patch === "function" ? patch(prev) : patch) };
					saveViewState(next);
					return next;
				});
			};
			const { groupBy, orderBy, groupExpansion, sessionOrderByAccount } = view;

			const workspaceReady = workspacePhase === "ready" && workspaceStreamState !== "loading";
			const currentBlank = list.current !== undefined && list.byId[list.current]?.blank === true
				? list.current
				: undefined;
			const ungroupedMemberIds = (() => {
				const accounted = new Set(workspaces.flatMap((workspace) => workspace.sessionIds));
				return list.ids.filter((id) => list.byId[id] !== undefined && !accounted.has(id));
			})();
			const flatMemberIds = visibleSessionIds(list, archivedSessionIds);

			const baseOrderFor = (memberIds, saved) => orderBy === "updated"
				? orderByRecency(memberIds, list.byId)
				: reconcileManualOrder(memberIds, saved, list.byId);
			const orderedWorkspaces = workspaces.map((workspace) => {
				const memberIds = workspace.sessionIds;
				return {
					...workspace,
					sessionIds: pinCurrentBlank(
						baseOrderFor(memberIds, sessionOrderByAccount[workspace.workspaceId]),
						currentBlank !== undefined && memberIds.includes(currentBlank) ? currentBlank : undefined),
				};
			});
			const orderedUngroupedSessionIds = pinCurrentBlank(
				baseOrderFor(ungroupedMemberIds, sessionOrderByAccount[UNGROUPED_KEY]),
				currentBlank !== undefined && ungroupedMemberIds.includes(currentBlank) ? currentBlank : undefined);
			const orderedFlatSessionIds = pinCurrentBlank(
				baseOrderFor(flatMemberIds, sessionOrderByAccount[FLAT_SESSION_ORDER_KEY]),
				currentBlank !== undefined && flatMemberIds.includes(currentBlank) ? currentBlank : undefined);
			const activeSessionOrders = {};
			for (const workspace of orderedWorkspaces) {
				activeSessionOrders[workspace.workspaceId] = workspace.sessionIds;
			}
			activeSessionOrders[UNGROUPED_KEY] = orderedUngroupedSessionIds;
			activeSessionOrders[FLAT_SESSION_ORDER_KEY] = orderedFlatSessionIds;

			// Retain only live accounts (upstream retainAccountKeys effect).
			react.useEffect(() => {
				if (workspacePhase !== "ready") return undefined;
				const retained = new Set([
					UNGROUPED_KEY, FLAT_SESSION_ORDER_KEY,
					...workspaces.map((workspace) => workspace.workspaceId),
				]);
				patchView((prev) => {
					const nextExpansion = Object.fromEntries(
						Object.entries(prev.groupExpansion).filter(([key]) => retained.has(key)));
					const nextOrders = Object.fromEntries(
						Object.entries(prev.sessionOrderByAccount).filter(([key]) => retained.has(key)));
					return { ...prev, groupExpansion: nextExpansion, sessionOrderByAccount: nextOrders };
				});
				return undefined;
			}, [workspacePhase]);

			// Promote the selected provisional blank ahead of either base order.
			const promotedBlank = react.useRef(undefined);
			react.useEffect(() => {
				const currentBlankAccount = currentBlank === undefined || workspacePhase !== "ready"
					? undefined
					: owningGroupKey(workspaces, currentBlank);
				if (currentBlank === undefined || currentBlankAccount === undefined) {
					promotedBlank.current = undefined;
					return undefined;
				}
				const promoted = promotedBlank.current;
				if (promoted !== undefined && promoted.sessionId === currentBlank &&
					promoted.accountKey === currentBlankAccount) return undefined;
				promotedBlank.current = { sessionId: currentBlank, accountKey: currentBlankAccount };
				for (const accountKey of new Set([currentBlankAccount, FLAT_SESSION_ORDER_KEY])) {
					const previous = sessionOrderByAccount[accountKey] ?? [];
					saveSessionOrder(accountKey, [currentBlank, ...previous.filter((id) => id !== currentBlank)]);
				}
				return undefined;
			}, [currentBlank, workspacePhase]);

			const setGroupExpanded = (key, expanded) => {
				patchView((prev) => ({
					...prev,
					groupExpansion: { ...prev.groupExpansion, [key]: expanded },
				}));
			};
			const saveSessionOrder = (accountKey, order) => {
				patchView((prev) => {
					const next = { ...prev.sessionOrderByAccount };
					if (prev.orderBy === "updated") {
						for (const [key, ids] of Object.entries(activeSessionOrders)) next[key] = [...ids];
					}
					next[accountKey] = [...order];
					return { ...prev, orderBy: "manual", sessionOrderByAccount: next };
				});
			};

			// The query outlives the tree and the input so collapsing does not
			// silently drop an in-progress filter.
			const [query, setQuery] = react.useState("");
			const [searchExpanded, setSearchExpanded] = react.useState(false);
			const [revealSessionId, setRevealSessionId] = react.useState(undefined);
			const normalizedQuery = sanitizeSearchQuery(query).trim();
			const [remoteSearch, setRemoteSearch] = react.useState({
				query: "", status: "idle", items: [], hasMore: false,
			});
			const searchInput = react.useRef(null);
			const [wsPickerOpen, setWsPickerOpen] = react.useState(false);
			const [flowBusy, setFlowBusy] = react.useState(false);
			const [flowError, setFlowError] = react.useState(null);
			const composingRef = react.useRef(false);

			const openSearchResult = (sessionId) => {
				setRevealSessionId(sessionId);
				setQuery("");
				setSearchExpanded(false);
				open(sessionId);
			};
			const acknowledgeSessionReveal = (sessionId) => {
				setRevealSessionId((current) => current === sessionId ? undefined : current);
			};
			react.useEffect(() => {
				if (normalizedQuery !== "") setRevealSessionId(undefined);
				return undefined;
			}, [normalizedQuery]);

			// Rail search = expand + land in the search box.
			const [searchOnExpand, setSearchOnExpand] = react.useState(false);
			react.useEffect(() => {
				if (wide && searchOnExpand) {
					const timer = window.setTimeout(() => {
						if (searchInput.current !== null &&
							typeof searchInput.current.focus === "function") {
							searchInput.current.focus({ preventScroll: true });
						}
						setSearchOnExpand(false);
					}, EXPAND_SLIDE_MS);
					return () => { window.clearTimeout(timer); };
				}
				return undefined;
			}, [wide, searchOnExpand]);
			react.useEffect(() => {
				if (!wide || !searchExpanded || searchOnExpand) return undefined;
				if (searchInput.current !== null && typeof searchInput.current.focus === "function") {
					searchInput.current.focus({ preventScroll: true });
				}
				return undefined;
			}, [wide, searchExpanded, searchOnExpand]);

			react.useEffect(() => {
				if (normalizedQuery === "") {
					setRemoteSearch({ query: "", status: "idle", items: [], hasMore: false });
					return undefined;
				}
				const controller = new AbortController();
				setRemoteSearch({ query: normalizedQuery, status: "loading", items: [], hasMore: false });
				const timer = window.setTimeout(() => {
					Promise.resolve()
						.then(() => searchSessions(normalizedQuery, controller.signal))
						.then((result) => {
							if (controller.signal.aborted) return;
							setRemoteSearch({
								query: normalizedQuery,
								status: "ready",
								items: result.items,
								hasMore: result.hasMore,
							});
						})
						.catch(() => {
							if (controller.signal.aborted) return;
							setRemoteSearch({ query: normalizedQuery, status: "error", items: [], hasMore: false });
						});
				}, SEARCH_DEBOUNCE_MS);
				return () => {
					window.clearTimeout(timer);
					controller.abort();
				};
			}, [normalizedQuery, searchSessions]);

			// Rename dialog (browser-owned so it outlives row unmounts during collapse).
			const [renameTarget, setRenameTarget] = react.useState(null);
			const [renameDraft, setRenameDraft] = react.useState("");
			const [renaming, setRenaming] = react.useState(false);
			const [renameError, setRenameError] = react.useState(null);
			const renameTrimmed = renameDraft.trim();
			const renameDuplicate = renameTarget !== null && renameTrimmed !== "" &&
				renameTrimmed !== renameTarget.currentTitle &&
				workspaces.some((w) => w.title === renameTrimmed);
			const renameBlocked = renaming || renameTrimmed === "" ||
				renameTarget === null || renameTrimmed === renameTarget.currentTitle || renameDuplicate;
			const closeRename = () => {
				if (renaming) return;
				setRenameTarget(null);
				setRenameError(null);
			};
			const confirmRename = () => {
				if (renameBlocked) return;
				setRenaming(true);
				setRenameError(null);
				Promise.resolve()
					.then(() => renameWorkspace(renameTarget.workspaceId, renameTrimmed))
					.then(() => {
						setRenaming(false);
						setRenameTarget(null);
					})
					.catch((reason) => {
						setRenaming(false);
						setRenameError(reason instanceof Error ? reason.message : String(reason));
					});
			};

			// Archive is dialog-free: not destructive (the log and the accounting slot
			// remain), so the menu action commits directly; the row disappears when the
			// archive-set echo lands. Failures are non-fatal console diagnostics, the
			// same posture as reorder rejections.
			const onSessionArchive = (sessionId) => {
				Promise.resolve()
					.then(() => archiveSession(sessionId))
					.catch((reason) => {
						console.warn("session archive rejected:", reason);
					});
			};
			const onSessionRename = (sessionId, currentTitle) => {
				// Row-level rename modal (see SessionRow); the browser keeps no
				// separate session-rename dialog because the row owns it.
				if (renameSession !== undefined) {
					return renameSession(sessionId, currentTitle);
				}
				return Promise.resolve();
			};

			// Delete dialog is separate from the row so a successful removal can
			// unmount that row without tearing down the in-flight confirmation state.
			const [deleteTarget, setDeleteTarget] = react.useState(null);
			const [deleting, setDeleting] = react.useState(false);
			const [deleteCommittedId, setDeleteCommittedId] = react.useState(null);
			const [deleteError, setDeleteError] = react.useState(null);
			react.useEffect(() => {
				if (deleteCommittedId === null ||
					workspaces.some((workspace) => workspace.workspaceId === deleteCommittedId)) {
					return undefined;
				}
				setDeleting(false);
				setDeleteCommittedId(null);
				setDeleteTarget(null);
				return undefined;
			}, [deleteCommittedId, workspaces]);
			const closeDelete = () => {
				if (deleting) return;
				setDeleteTarget(null);
				setDeleteError(null);
			};
			const confirmDelete = () => {
				if (deleting || deleteTarget === null) return;
				setDeleting(true);
				setDeleteCommittedId(null);
				setDeleteError(null);
				Promise.resolve()
					.then(() => deleteWorkspace(deleteTarget.workspaceId))
					.then(() => {
						// Keep the confirmation pending until the committed list
						// projection renders without the deleted id.
						setDeleteCommittedId(deleteTarget.workspaceId);
					})
					.catch((reason) => {
						setDeleting(false);
						setDeleteError(reason instanceof Error ? reason.message : String(reason));
					});
			};

			const adoptPicked = (path) => {
				setFlowBusy(true);
				setFlowError(null);
				Promise.resolve()
					.then(() => createWorkspace({ path }))
					.then((workspace) => {
						setFlowBusy(false);
						setWsPickerOpen(false);
						startSession(workspace.workspaceId);
					})
					.catch((reason) => {
						setFlowBusy(false);
						setFlowError(reason instanceof Error ? reason.message : String(reason));
					});
			};

			if (!wide) {
				return react.createElement("div", { className: "dsh-sa-root dsh-sa-rail" },
					react.createElement("button", {
						type: "button",
						className: "dsh-sa-iconbtn dsh-sa-railbtn",
						"aria-label": t("search.sessions.aria"),
						title: t("search.sessions.aria"),
						onClick: () => {
							setSearchExpanded(true);
							setSearchOnExpand(true);
							expandSidebar();
						},
					}, react.createElement(IconSearch, null)),
				);
			}

			const modal = (label, body, foot) => react.createElement("span", {
				className: "dsh-sa-modalwrap",
				onClick: (e) => { e.stopPropagation(); },
			}, react.createElement("span", {
				className: "dsh-sa-modal",
				role: "dialog",
				"aria-label": label,
			}, body, react.createElement("span", { className: "dsh-sa-modalrow" }, ...foot)));
			const modalButton = (label, primary, disabled, onClick) => react.createElement("button", {
				type: "button",
				className: "dsh-sa-btn" + (primary ? " dsh-sa-primary" : ""),
				disabled,
				onClick: (e) => { e.stopPropagation(); onClick(); },
			}, label);
			const renameInput = (value, ariaLabel, disabled, onChange, onEnter) =>
				react.createElement("input", {
					className: "dsh-sa-renameinput",
					value,
					"aria-label": ariaLabel,
					autoFocus: true,
					disabled,
					onFocus: (e) => { e.target.select(); },
					onChange: (e) => { onChange(e.target.value); },
					onCompositionStart: () => { composingRef.current = true; },
					onCompositionEnd: () => { composingRef.current = false; },
					onKeyDown: (e) => {
						if (e.key === "Enter" && !composingRef.current) {
							e.preventDefault();
							onEnter();
						}
					},
					onClick: (e) => { e.stopPropagation(); },
				});

			return react.createElement("div", { className: "dsh-sa-root" },
				react.createElement("div", { className: "dsh-sa-header" },
					(!searchExpanded) && react.createElement("span", { className: "dsh-sa-label" },
						groupBy === "flat" ? t("section.sessions") : t("section.workspaces")),
					react.createElement("div", {
						className: "dsh-sa-searchslot" + (searchExpanded ? " dsh-sa-searchexpanded" : ""),
					},
						react.createElement("div", {
							className: "dsh-sa-search" + (searchExpanded ? " dsh-sa-searchexpanded" : ""),
							onClick: () => {
								setWsPickerOpen(false);
								setSearchExpanded(true);
								if (searchInput.current !== null &&
									typeof searchInput.current.focus === "function") {
									searchInput.current.focus();
								}
							},
						},
							react.createElement("button", {
								type: "button",
								className: "dsh-sa-iconbtn dsh-sa-searchbtn",
								"aria-label": t("search.sessions.aria"),
								"aria-expanded": searchExpanded,
								onClick: () => {
									setWsPickerOpen(false);
									setSearchExpanded(true);
								},
							}, react.createElement(IconSearch, null)),
							react.createElement("input", {
								ref: searchInput,
								className: "dsh-sa-searchinput",
								type: "text",
								placeholder: t("search.placeholder"),
								maxLength: SEARCH_QUERY_MAX_CODE_UNITS,
								value: query,
								tabIndex: searchExpanded ? 0 : -1,
								onChange: (e) => { setQuery(sanitizeSearchQuery(e.target.value)); },
								onKeyDown: (e) => {
									if (e.key !== "Escape") return;
									setQuery("");
									setSearchExpanded(false);
								},
							}),
							searchExpanded && react.createElement("button", {
								type: "button",
								className: "dsh-sa-iconbtn",
								"aria-label": t("search.clear"),
								onClick: (e) => {
									e.stopPropagation();
									setQuery("");
									setSearchExpanded(false);
								},
							}, react.createElement(IconTrash, null)),
						),
					),
					react.createElement("div", {
						className: "dsh-sa-headeractions" + (searchExpanded ? " dsh-sa-headerhidden" : ""),
					},
						react.createElement(ViewOptionsMenu, {
							groupBy,
							orderBy,
							onGroupPick: (mode) => {
								patchView((prev) => ({ ...prev, groupBy: mode }));
							},
							onOrderPick: (mode) => {
								patchView((prev) => {
									if (mode === prev.orderBy) return prev;
									return {
										...prev,
										orderBy: mode,
										sessionOrderByAccount: mode === "manual"
											? Object.fromEntries(Object.entries(activeSessionOrders)
												.map(([key, ids]) => [key, [...ids]]))
											: {},
									};
								});
							},
						}),
						(flowOccupied === true) && react.createElement("button", {
							type: "button",
							className: "dsh-sa-iconbtn",
							"aria-label": t("workspace.add"),
							title: t("workspace.add"),
							onClick: () => {
								setFlowError(null);
								setWsPickerOpen((v) => !v);
							},
						}, react.createElement(IconPlus, null)),
					),
					(wsPickerOpen && flowOccupied === true && typeof renderSlot === "function") &&
						react.createElement("div", { className: "dsh-sa-flow" },
							renderSlot(FLOW_HOLE, {
								open: wsPickerOpen,
								busy: flowBusy,
								onPicked: adoptPicked,
								onCancel: () => {
									if (!flowBusy) {
										setWsPickerOpen(false);
										setFlowError(null);
									}
								},
								onError: (message) => {
									setFlowBusy(false);
									setFlowError(String(message));
								},
							}),
							flowError !== null && react.createElement("div", {
								className: "dsh-sa-error",
								role: "alert",
							}, flowError),
						),
				),
				react.createElement("div", { className: "dsh-sa-listarea" },
					wide && (normalizedQuery !== ""
						? react.createElement(SearchResults, {
							list,
							useSessionPendingInteraction,
							open: openSearchResult,
							workspaces: orderedWorkspaces,
							archivedSessionIds,
							query: normalizedQuery,
							remote: remoteSearch,
							resultLimit: typeof searchResultLimit === "number" ? searchResultLimit : 20,
							usePanelInfo,
						})
						: groupBy === "flat"
							? react.createElement(FlatList, {
								list,
								sessionIds: orderedFlatSessionIds,
								useSessionPendingInteraction,
								open,
								forkSession,
								onSessionRename,
								onSessionArchive,
								usePanelInfo,
								setSessionOrder: saveSessionOrder,
								revealSessionId,
								onSessionRevealed: acknowledgeSessionReveal,
							})
							: react.createElement(SessionTree, {
								list,
								useSessionPendingInteraction,
								startSession,
								open,
								forkSession,
								workspaces,
								orderedWorkspaces,
								ungroupedSessionIds: orderedUngroupedSessionIds,
								archivedSessionIds,
								workspaceReady,
								usePanelInfo,
								onRenameRequest: (workspaceId, currentTitle) => {
									setRenameTarget({ workspaceId, currentTitle });
									setRenameDraft(currentTitle);
									setRenameError(null);
								},
								onDeleteRequest: (workspaceId, title) => {
									setDeleteTarget({ workspaceId, title });
									setDeleteError(null);
								},
								onSessionRename,
								onSessionArchive,
								insertWorkspaceBefore,
								insertSessionBefore,
								orderBy,
								groupExpansion,
								setGroupExpanded,
								setSessionOrder: saveSessionOrder,
								revealSessionId,
								onSessionRevealed: acknowledgeSessionReveal,
							})),
				),
				renameTarget !== null && modal(t("rename.workspace.title"),
					react.createElement(react.Fragment, null,
						renameInput(renameDraft, t("field.workspaceName"), renaming,
							(v) => { setRenameDraft(v); setRenameError(null); }, confirmRename),
						renameDuplicate && react.createElement("div", {
							className: "dsh-sa-error",
							role: "alert",
						}, t("conflict.named", { name: renameTrimmed })),
						renameError !== null && react.createElement("div", {
							className: "dsh-sa-error",
							role: "alert",
						}, renameError)),
					[
						modalButton(t("cancel"), false, renaming, closeRename),
						modalButton(t("rename"), true, renameBlocked, confirmRename),
					]),
				deleteTarget !== null && modal(t("delete.workspace"),
					react.createElement(react.Fragment, null,
						react.createElement("div", { className: "dsh-sa-modaldesc" },
							t("delete.desc", { name: deleteTarget.title })),
						deleting && react.createElement("div", {
							className: "dsh-sa-searchstatus",
							role: "status",
						}, t("delete.pending")),
						deleteError !== null && react.createElement("div", {
							className: "dsh-sa-error",
							role: "alert",
						}, deleteError)),
					[
						modalButton(t("cancel"), false, deleting, closeDelete),
						modalButton(t("delete.workspace"), false, deleting, confirmDelete),
					]),
			);
		}

		/* -------------------------------------------------------------------- css */

		const css = [
			".dsh-sa-root{display:flex;flex-direction:column;min-height:0;height:100%;gap:4px}",
			".dsh-sa-header{display:flex;align-items:center;gap:4px;padding:2px 8px;position:relative}",
			".dsh-sa-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#8a8f98);white-space:nowrap}",
			".dsh-sa-searchslot{flex:1;min-width:0;display:flex;justify-content:flex-end}",
			".dsh-sa-search{display:flex;align-items:center;gap:2px;border-radius:8px;padding:2px}",
			".dsh-sa-searchexpanded{flex:1;background:var(--dsw-alias-interactive-bg-subtle,rgba(127,127,127,.12))}",
			".dsh-sa-searchbtn{width:24px;height:24px}",
			".dsh-sa-searchinput{flex:1;min-width:0;background:transparent;border:none;outline:none;color:inherit;font-size:13px;display:none}",
			".dsh-sa-searchexpanded .dsh-sa-searchinput{display:block}",
			".dsh-sa-headeractions{display:flex;align-items:center;gap:4px}",
			".dsh-sa-headerhidden{display:none}",
			".dsh-sa-listarea{flex:1;min-height:0;display:flex;flex-direction:column}",
			".dsh-sa-treebody{flex:1;min-height:0;display:flex;flex-direction:column;position:relative}",
			".dsh-sa-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:1px;padding:0 4px 8px}",
			".dsh-sa-group{margin:2px 0}",
			".dsh-sa-projectrow{display:flex;align-items:center;gap:6px;height:34px;padding:0 8px;border-radius:8px;cursor:pointer;user-select:none;color:var(--dsw-alias-label-primary,inherit)}",
			".dsh-sa-projectrow:hover,.dsh-sa-projectrow.dsh-sa-menuopen{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
			".dsh-sa-projecttext{flex:1;min-width:0;display:flex;flex-direction:column}",
			".dsh-sa-folder{color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-folderactive{color:var(--dsw-alias-state-business-primary,#1f6feb)}",
			".dsh-sa-chevron{display:none;color:var(--dsw-alias-label-caption,#6e7681)}",
			".dsh-sa-projectrow:hover .dsh-sa-chevron{display:inline-flex}",
			".dsh-sa-projectrow:hover .dsh-sa-folder{display:none}",
			".dsh-sa-arrow{display:inline-flex;transition:transform .15s}",
			".dsh-sa-arrowopen{transform:rotate(90deg)}",
			".dsh-sa-row{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);user-select:none;position:relative}",
			".dsh-sa-row:hover,.dsh-sa-selected{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
			".dsh-sa-row.dsh-sa-menuopen{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
			".dsh-sa-slot{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-dot{width:8px;height:8px;border-radius:50%}",
			".dsh-sa-dot-ongoing{background:#1f6feb}",
			".dsh-sa-dot-warning{background:#d97706}",
			".dsh-sa-dot-done{background:#1a7f37}",
			".dsh-sa-visuallyhidden{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}",
			".dsh-sa-schedule{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center;margin-right:6px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-schedulesearch{margin-left:4px;margin-right:0}",
			".dsh-sa-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;margin:0 4px}",
			".dsh-sa-flatnostatus .dsh-sa-title{margin-left:0}",
			".dsh-sa-time{flex:none;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-actions{flex:none;display:none;align-items:center;gap:4px}",
			".dsh-sa-row:hover .dsh-sa-actions,.dsh-sa-row:focus-within .dsh-sa-actions,.dsh-sa-row.dsh-sa-menuopen .dsh-sa-actions,.dsh-sa-projectrow:hover .dsh-sa-actions,.dsh-sa-projectrow.dsh-sa-menuopen .dsh-sa-actions{display:inline-flex}",
			".dsh-sa-row:hover .dsh-sa-time,.dsh-sa-row:focus-within .dsh-sa-time,.dsh-sa-row.dsh-sa-menuopen .dsh-sa-time{display:none}",
			".dsh-sa-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;background:transparent;border:none;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-iconbtn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.24))}",
			".dsh-sa-archive:hover{color:#f0883e}",
			".dsh-sa-menusep{position:relative;display:inline-flex}",
			".dsh-sa-menu{position:absolute;right:0;top:26px;z-index:30;display:flex;flex-direction:column;min-width:150px;padding:4px;border-radius:8px;background:var(--dsw-alias-elevated-fill,#1d1d20);border:1px solid var(--dsw-alias-border-l4,#3a3a3f);box-shadow:0 8px 24px rgba(0,0,0,.4)}",
			".dsh-sa-menuitem{display:flex;align-items:center;gap:8px;background:transparent;border:none;text-align:left;padding:6px 10px;border-radius:6px;font-size:13px;color:inherit;cursor:pointer}",
			".dsh-sa-menuitem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
			".dsh-sa-danger{color:#f85149}",
			".dsh-sa-check{width:14px;flex:none}",
			".dsh-sa-menulabel{padding:6px 10px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-menusep-line{height:1px;margin:4px 8px;background:var(--dsw-alias-border-l4,#3a3a3f)}",
			".dsh-sa-modalwrap{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}",
			".dsh-sa-modal{display:flex;flex-direction:column;gap:8px;min-width:260px;max-width:320px;padding:12px;border-radius:10px;background:var(--dsw-alias-elevated-fill,#1d1d20);border:1px solid var(--dsw-alias-border-l4,#3a3a3f)}",
			".dsh-sa-modaldesc{font-size:13px;line-height:18px}",
			".dsh-sa-renameinput{background:var(--dsw-alias-button-elevated-fill,#2a2a2e);border:1px solid var(--dsw-alias-border-l4,#3a3a3f);border-radius:6px;color:inherit;padding:6px 8px;font-size:14px;outline:none}",
			".dsh-sa-modalrow{display:flex;justify-content:flex-end;gap:8px}",
			".dsh-sa-btn{background:transparent;border:1px solid var(--dsw-alias-border-l4,#3a3a3f);border-radius:6px;padding:5px 12px;font-size:13px;color:inherit;cursor:pointer}",
			".dsh-sa-primary{background:#1f6feb;border-color:#1f6feb;color:#fff}",
			".dsh-sa-error{font-size:12px;color:#f85149}",
			".dsh-sa-empty{padding:12px 8px;font-size:13px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-searchrow{box-sizing:border-box;cursor:pointer;text-align:left;width:100%;background:transparent;border:none;border-radius:8px;color:var(--dsw-alias-label-primary,inherit);display:flex;flex-direction:column;align-items:stretch;padding:4px 8px}",
			".dsh-sa-searchrow:hover,.dsh-sa-searchrow.dsh-sa-selected{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
			".dsh-sa-searchhead{display:flex;align-items:center;min-width:0}",
			".dsh-sa-searchtitle{flex:0 auto;min-width:0;margin-left:4px;font-size:14px;line-height:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
			".dsh-sa-searchmeta{display:flex;align-items:center;gap:6px;min-width:0;margin-left:20px}",
			".dsh-sa-searchws{flex:none;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-searchsnippet{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98)}",
			".dsh-sa-searchstatus{padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98)}",
			".dsh-sa-searchwarn{padding:6px 8px;font-size:12px;color:#d97706}",
			".dsh-sa-overflow{background:transparent;border:none;cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#8a8f98);text-align:left;padding:4px 8px;border-radius:6px}",
			".dsh-sa-overflow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
			".dsh-sa-dropbefore{box-shadow:0 -2px 0 0 #1f6feb}",
			".dsh-sa-dropafter{box-shadow:0 2px 0 0 #1f6feb}",
			".dsh-sa-wsdrobefore{box-shadow:0 -2px 0 0 #1f6feb}",
			".dsh-sa-wsdropafter{box-shadow:0 2px 0 0 #1f6feb}",
			".dsh-sa-listtopdrop{display:block;height:2px;background:#1f6feb;margin:0 4px}",
			".dsh-sa-fade{display:block}",
			".dsh-sa-flow{padding:0 8px 4px}",
			".dsh-sa-rail{align-items:center;justify-content:flex-start;padding-top:4px}",
			".dsh-sa-railbtn{width:36px;height:36px}",
		].join("");

		/** Inject once; the hmr reload path deletes `<style data-plugin>` tags. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			const tagId = "dsh-session-archive/pane.css";
			if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.plugin = "dsh-session-archive";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}

		const inject = ["slots"];

		function apply(ctx) {
			ensureStyles();
			if (typeof window !== "undefined") {
				window.__dshSessionArchive = { version: VERSION, slot: SLOT, hole: FLOW_HOLE };
			}

			// Occupancy source for the redeclared directory-flow hole, bound once
			// so the renderer's hook cache keys it stably (upstream pattern).
			const flowSource = {
				getSnapshot: () => ctx.slots.entries(FLOW_HOLE).length > 0,
				subscribe: (listener) => ctx.slots.subscribe(FLOW_HOLE, listener),
			};

			const injected = () => {
				const navigation = ctx.get("uiWorkspace");
				const sessions = ctx.get("sessions");
				const workspaces = ctx.get("workspaces");
				return {
					open: (sessionId) => {
						if (navigation === undefined) throw new Error("dsh-session-archive: uiWorkspace unavailable");
						navigation.openSession(sessionId);
					},
					archiveSession: async (sessionId) => {
						if (navigation !== undefined) {
							await navigation.archiveSession(sessionId);
							return;
						}
						if (workspaces === undefined) throw new Error("dsh-session-archive: no archive path available");
						await workspaces.archiveSession(sessionId);
					},
					renameSession: async (sessionId, title) => {
						if (sessions === undefined) throw new Error("dsh-session-archive: sessions unavailable");
						const session = sessions.binding(sessionId)?.session;
						if (session === undefined) throw new Error(`unknown session "${sessionId}"`);
						const result = await session.rename(title);
						if (!result.ok) throw new Error(result.error.message);
					},
					forkSession: (sessionId) => {
						if (navigation === undefined) throw new Error("dsh-session-archive: uiWorkspace unavailable");
						navigation.forkSession(sessionId).catch(() => {
							// Fork failure keeps the current selection.
						});
					},
					startSession: (workspaceId) => {
						if (navigation === undefined) throw new Error("dsh-session-archive: uiWorkspace unavailable");
						navigation.startSession(workspaceId);
					},
					renameWorkspace: async (workspaceId, title) => {
						if (workspaces === undefined) throw new Error("dsh-session-archive: workspaces unavailable");
						await workspaces.rename(workspaceId, title);
					},
					deleteWorkspace: async (workspaceId) => {
						if (workspaces === undefined) throw new Error("dsh-session-archive: workspaces unavailable");
						await workspaces.delete(workspaceId);
					},
					insertWorkspaceBefore: async (workspaceId, beforeWorkspaceId) => {
						if (workspaces === undefined) throw new Error("dsh-session-archive: workspaces unavailable");
						await workspaces.insertBefore(workspaceId, beforeWorkspaceId);
					},
					insertSessionBefore: async (workspaceId, sessionId, beforeSessionId) => {
						if (workspaces === undefined) throw new Error("dsh-session-archive: workspaces unavailable");
						await workspaces.insertSessionBefore(workspaceId, sessionId, beforeSessionId);
					},
					createWorkspace: (input) => {
						if (workspaces === undefined) throw new Error("dsh-session-archive: workspaces unavailable");
						return workspaces.create(input);
					},
					searchSessions: async (query, signal) => {
						if (sessions === undefined) throw new Error("dsh-session-archive: sessions unavailable");
						const result = await sessions.search(query, signal);
						if (!result.ok) throw new Error(result.error.message);
						return result.value;
					},
					searchResultLimit: sessions?.searchResultLimit ?? 20,
					hooks: { directoryFlow: flowSource },
				};
			};

			ctx.slots.inject(SLOT, () => ctx.slots.register({
				name: SLOT,
				children: { [FLOW_HOLE]: { kind: "single", scope: "root" } },
				inject: injected,
			}, ArchivePane));
		}

		exports.apply = apply;
		exports.inject = inject;
		exports.SLOT = SLOT;
		exports.FLOW_HOLE = FLOW_HOLE;
		exports.VERSION = VERSION;
		exports.UNGROUPED_KEY = UNGROUPED_KEY;
		exports.FLAT_SESSION_ORDER_KEY = FLAT_SESSION_ORDER_KEY;
		exports.EN = EN;
		exports.t = t;
		exports.ArchivePane = ArchivePane;
		exports.SessionTree = SessionTree;
		exports.FlatList = FlatList;
		exports.SearchResults = SearchResults;
		exports.SessionRow = SessionRow;
		exports.ProjectRowItem = ProjectRowItem;
		exports.SearchResultItem = SearchResultItem;
		exports.ViewOptionsMenu = ViewOptionsMenu;
		exports.sessionVisible = sessionVisible;
		exports.byRecency = byRecency;
		exports.sessionStatuses = sessionStatuses;
		exports.owningGroupKey = owningGroupKey;
		exports.workspaceLabel = workspaceLabel;
		exports.orderByRecency = orderByRecency;
		exports.reconcileManualOrder = reconcileManualOrder;
		exports.pinCurrentBlank = pinCurrentBlank;
		exports.deriveGroups = deriveGroups;
		exports.visibleSessionIds = visibleSessionIds;
		exports.deriveFlat = deriveFlat;
		exports.deriveFlatRows = deriveFlatRows;
		exports.deriveSearchResults = deriveSearchResults;
		exports.collapsedSessionRows = collapsedSessionRows;
		exports.rowHalf = rowHalf;
		exports.commitSessionDrop = commitSessionDrop;
		exports.commitWorkspaceDrop = commitWorkspaceDrop;
		exports.sanitizeSearchQuery = sanitizeSearchQuery;
		exports.relativeTime = relativeTime;
		exports.timeLabel = timeLabel;
		exports.loadViewState = loadViewState;
		return module.exports;
	},
});
