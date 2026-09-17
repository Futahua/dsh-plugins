/**
 * Sidebar session pane with a one-click hover-archive button.
 *
 * This bundle REPLACES the shipped session pane: it registers into
 * `sidebar.workspaces` (a `single` slot declared by
 * `@deepseek-ai/dsh-client-ui-sidebar`), which shadows the shipped
 * `WorkspaceBrowser` from `@deepseek-ai/dsh-client-ui-workspace`. There is no
 * slot for per-session-row actions, so a row-level button is only reachable
 * by owning the whole region.
 *
 * What the replacement renders is deliberately the flat "In one list" view:
 * every visible session as one top-level row, newest first, with a search
 * box. Row anatomy mirrors upstream `SessionNodeItem`
 * (`packages/client/ui-workspace/src/client/rows/Rows.tsx` on `master`):
 * status dot, title, relative time, and a hover actions cell — except the
 * actions cell holds a one-click archive button BESIDE the `...` menu.
 *
 * Archive semantics are upstream's, unchanged: the button calls
 * `archiveSession(sessionId)` directly — no confirmation dialog, because
 * archiving hides the row through the registry-global archive set and never
 * touches the session log (upstream `Rows.tsx`: "commits without a dialog").
 * The row disappears when the archive-set echo lands, which is also what
 * filters it here (`archivedSessionIds` from the workspace snapshot).
 *
 * The `sidebar.workspaces.directoryFlow` hole is redeclared with the
 * identical owner contract (`{ kind: "single", scope: "root" }`), so the
 * shipped directory pickers (browse + native, both injected by hole name)
 * keep working and "Add workspace" keeps its affordance. The hole is only
 * rendered while occupied.
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

		/** Pause between the latest keystroke and a Host content-search request. */
		const SEARCH_DEBOUNCE_MS = 250;
		/** `session.search` wire bound, measured in JavaScript UTF-16 code units. */
		const SEARCH_QUERY_MAX_CODE_UNITS = 500;

		/** Build marker, so a live page can be checked against the source. */
		const VERSION = 1;

		/* ---------------------------------------------------------- pure rows */

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

		/**
		 * Ordinary sessions are visible; among blank sessions, only the current
		 * one is visible. Subagent children use their parent header catalog;
		 * archived sessions are visible nowhere. (Upstream `sessionVisible`.)
		 *
		 * @param session session summary.
		 * @param current selected session id.
		 * @param archived archive set.
		 * @returns whether the session renders a row.
		 */
		function sessionVisible(session, current, archived) {
			return session.origin !== "subagent" &&
				!archived.has(session.id) &&
				(!session.blank || session.id === current);
		}

		/**
		 * Recency comparator: newest first, id as the deterministic tiebreak.
		 * (Upstream `byRecency`.)
		 */
		function byRecency(a, b) {
			if (b.updatedAt !== a.updatedAt) return b.updatedAt - a.updatedAt;
			return a.id < b.id ? -1 : 1;
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
		 * Derive the flat session rows ("In one list" mode): every visible
		 * session as a top-level row, strictly newest-first. (Upstream
		 * `deriveFlat`, minus the descendant index the status dot needs.)
		 *
		 * @param list sessions list snapshot (`current` feeds blank visibility).
		 * @param archivedSessionIds registry-global archive set (hidden rows).
		 * @param pendingInteractions pending UI interactions by session id.
		 * @returns flat row nodes in render order.
		 */
		function deriveFlatRows(list, archivedSessionIds, pendingInteractions) {
			const archived = new Set(archivedSessionIds ?? []);
			const rows = [];
			for (const id of list.ids ?? []) {
				const s = list.byId[id];
				if (s === undefined || !sessionVisible(s, list.current, archived)) continue;
				const pendingKind = pendingInteractions !== undefined && typeof pendingInteractions.get === "function"
					? visiblePendingKind(pendingInteractions.get(s.id)?.kind)
					: undefined;
				rows.push({
					id: s.id,
					title: s.blank ? "" : s.displayTitle,
					blank: s.blank === true,
					running: s.running === true,
					runningSubagentCount: 0,
					completed: s.completed === true,
					hasActiveSchedule: ((s.projectionValues?.schedule?.length) ?? 0) > 0,
					updatedAt: s.updatedAt,
					...(pendingKind === undefined ? {} : { pendingInteraction: pendingKind }),
				});
			}
			rows.sort(byRecency);
			return rows;
		}

		/**
		 * Localized compact relative time. Upstream renders through the
		 * workspace dictionary; this pane owns no locale namespace, so it
		 * renders terse English ("now", "5min", "2h", "3d").
		 */
		function timeLabel(updatedAt, now) {
			const delta = Math.max(0, now - updatedAt);
			const minute = 60 * 1000;
			const hour = 60 * minute;
			const day = 24 * hour;
			if (delta < minute) return "now";
			if (delta < hour) return `${Math.floor(delta / minute)}min`;
			if (delta < day) return `${Math.floor(delta / hour)}h`;
			return `${Math.floor(delta / day)}d`;
		}

		/* ---------------------------------------------------------------- icons */

		/** 16px archive (box) glyph, stroke-only so it follows `color`. */
		function IconArchive() {
			return react.createElement("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": "true",
			},
				react.createElement("rect", { x: 2, y: 3.5, width: 12, height: 9, rx: 1 }),
				react.createElement("path", { d: "M2 6.5h12M6.5 8.5h3" }),
				react.createElement("path", { d: "M6 3.5V2h4v1.5" }),
			);
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
			return react.createElement("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": "true",
			},
				react.createElement("circle", { cx: 7, cy: 7, r: 4.5 }),
				react.createElement("path", { d: "M10.5 10.5 14 14" }),
			);
		}

		/** 16px plus glyph for "Add workspace". */
		function IconPlus() {
			return react.createElement("svg", {
				width: 16, height: 16, viewBox: "0 0 16 16", fill: "none",
				stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": "true",
			},
				react.createElement("path", { d: "M8 3v10M3 8h10" }),
			);
		}

		/* ------------------------------------------------------------- session row */

		/**
		 * One top-level 32px session row: status dot, title, relative time, and
		 * the hover actions cell holding the one-click archive button beside
		 * the `...` menu.
		 *
		 * The archive button calls `onArchive(node.id)` directly — no dialog —
		 * and stops propagation so the row's own open click never fires.
		 */
		function SessionRow({ node, currentId, now, onOpen, onRename, onFork, onArchive }) {
			const [menuOpen, setMenuOpen] = react.useState(false);
			const [renameOpen, setRenameOpen] = react.useState(false);
			const [renameDraft, setRenameDraft] = react.useState("");
			const [renameBusy, setRenameBusy] = react.useState(false);
			const [renameError, setRenameError] = react.useState(null);
			const selected = node.id === currentId;
			const title = node.blank ? "New Session" : node.title;

			const statusState = node.pendingInteraction !== undefined
				? "warning"
				: node.running
					? "ongoing"
					: node.completed
						? "done"
						: "idle";
			const statusLabel = node.pendingInteraction !== undefined
				? node.pendingInteraction
				: node.running
					? "running"
					: node.completed
						? "completed"
						: "idle";

			const openRename = () => {
				setMenuOpen(false);
				setRenameDraft(node.title);
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

			const menuItems = [
				...(onRename === undefined ? [] : [{ id: "rename", label: "Rename" }]),
				...(onFork === undefined ? [] : [{ id: "fork", label: "Fork" }]),
				{ id: "archive", label: "Archive session" },
			];
			const selectMenuItem = (id) => {
				setMenuOpen(false);
				if (id === "rename") openRename();
				else if (id === "fork" && onFork !== undefined) onFork(node.id);
				else if (id === "archive") onArchive(node.id);
			};

			return react.createElement("div", {
				className: "dsh-sa-row" + (selected ? " dsh-sa-selected" : ""),
				role: "treeitem",
				"aria-selected": selected,
				"data-session-id": node.id,
				onClick: () => { onOpen(node.id); },
			},
				react.createElement("span", { className: "dsh-sa-slot" },
					(statusState !== "idle") && react.createElement("span", {
						className: "dsh-sa-dot dsh-sa-dot-" + statusState,
						role: "img",
						"aria-label": statusLabel,
						title: statusLabel,
					}),
				),
				react.createElement("span", { className: "dsh-sa-title", title }, title),
				(!node.blank) && react.createElement("span", {
					className: "dsh-sa-time",
				}, timeLabel(node.updatedAt, now)),
				(!node.blank) && react.createElement("span", { className: "dsh-sa-actions" },
					react.createElement("button", {
						type: "button",
						className: "dsh-sa-iconbtn dsh-sa-archive",
						"aria-label": `Archive session ${title}`,
						title: "Archive session",
						onClick: (e) => {
							e.stopPropagation();
							onArchive(node.id);
						},
					}, react.createElement(IconArchive, null)),
					react.createElement("span", { className: "dsh-sa-menusep" },
						react.createElement("button", {
							type: "button",
							className: "dsh-sa-iconbtn",
							"aria-label": `Session actions for ${title}`,
							"aria-expanded": menuOpen,
							onClick: (e) => {
								e.stopPropagation();
								setMenuOpen((v) => !v);
							},
						}, react.createElement(IconEllipsis, null)),
						menuOpen && react.createElement("span", {
							className: "dsh-sa-menu",
							role: "menu",
							onMouseLeave: () => { setMenuOpen(false); },
						}, menuItems.map((item) => react.createElement("button", {
							key: item.id,
							type: "button",
							className: "dsh-sa-menuitem",
							role: "menuitem",
							onClick: (e) => {
								e.stopPropagation();
								selectMenuItem(item.id);
							},
						}, item.label))),
					),
				),
				renameOpen && react.createElement("span", {
					className: "dsh-sa-modalwrap",
					onClick: (e) => { e.stopPropagation(); },
				},
					react.createElement("span", {
						className: "dsh-sa-modal",
						role: "dialog",
						"aria-label": "Rename session",
					},
						react.createElement("input", {
							className: "dsh-sa-renameinput",
							value: renameDraft,
							"aria-label": "Session name",
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
							}, "Cancel"),
							react.createElement("button", {
								type: "button",
								className: "dsh-sa-btn dsh-sa-primary",
								disabled: renameBusy || renameDraft.trim() === "",
								onClick: (e) => {
									e.stopPropagation();
									confirmRename();
								},
							}, "Rename"),
						),
					),
				),
			);
		}

		/* ------------------------------------------------------------ archive pane */

		/**
		 * Flat session browser replacing the shipped pane: header (label,
		 * search, add workspace), then every visible session as a top-level
		 * row, newest first.
		 */
		function ArchivePane({
			wide, expandSidebar,
			useSessions, useSessionPendingInteraction, useWorkspaces, usePanelInfo,
			useDirectoryFlow, renderSlot,
			open, archiveSession, renameSession, forkSession, startSession,
			createWorkspace, searchSessions, searchResultLimit,
		}) {
			const [query, setQuery] = react.useState("");
			const [flowOpen, setFlowOpen] = react.useState(false);
			const [flowBusy, setFlowBusy] = react.useState(false);
			const [flowError, setFlowError] = react.useState(null);
			const [remote, setRemote] = react.useState({ status: "idle", items: [], hasMore: false });

			const list = useSessions((s) => s);
			const pendingInteractions = useSessionPendingInteraction((s) => s);
			const archivedSessionIds = useWorkspaces((s) => s.archivedSessionIds);
			const flowOccupied = useDirectoryFlow((occupied) => occupied);
			const panelActive = typeof usePanelInfo === "function"
				? usePanelInfo((info) => info.activePanelId !== null)
				: false;
			const current = panelActive ? undefined : list.current;

			const rows = react.useMemo(
				() => deriveFlatRows(list, archivedSessionIds, pendingInteractions),
				[list, archivedSessionIds, pendingInteractions],
			);
			const now = Date.now();

			const normalizedQuery = sanitizeSearchQuery(query).trim().toLowerCase();

			// Host content search, debounced; local title matches always lead.
			react.useEffect(() => {
				if (normalizedQuery === "" || typeof searchSessions !== "function") {
					setRemote({ status: "idle", items: [], hasMore: false });
					return undefined;
				}
				const controller = new AbortController();
				setRemote({ status: "loading", items: [], hasMore: false });
				const timer = window.setTimeout(() => {
					Promise.resolve()
						.then(() => searchSessions(normalizedQuery, controller.signal))
						.then((result) => {
							if (controller.signal.aborted) return;
							setRemote({
								status: "ready",
								items: result.items ?? [],
								hasMore: result.hasMore === true,
							});
						})
						.catch(() => {
							if (controller.signal.aborted) return;
							setRemote({ status: "error", items: [], hasMore: false });
						});
				}, SEARCH_DEBOUNCE_MS);
				return () => {
					window.clearTimeout(timer);
					controller.abort();
				};
			}, [normalizedQuery, searchSessions]);

			// Archive is dialog-free: not destructive (the log and the accounting
			// slot remain), so the action commits directly; the row disappears
			// when the archive-set echo lands. Failures are non-fatal console
			// diagnostics, the same posture as upstream reorder rejections.
			const onSessionArchive = (sessionId) => {
				Promise.resolve()
					.then(() => archiveSession(sessionId))
					.catch((reason) => {
						console.warn("session archive rejected:", reason);
					});
			};

			if (!wide) {
				return react.createElement("div", { className: "dsh-sa-root dsh-sa-rail" },
					react.createElement("button", {
						type: "button",
						className: "dsh-sa-iconbtn dsh-sa-railbtn",
						"aria-label": "Search sessions",
						title: "Search sessions",
						onClick: () => { expandSidebar(); },
					}, react.createElement(IconSearch, null)),
				);
			}

			const byId = list.byId ?? {};
			const limit = typeof searchResultLimit === "number" ? searchResultLimit : 20;
			let visible;
			if (normalizedQuery === "") {
				visible = rows;
			} else {
				const local = rows.filter((row) => row.title.toLowerCase().includes(normalizedQuery));
				const seen = new Set(local.map((row) => row.id));
				const remoteRows = [];
				for (const item of remote.items) {
					if (remoteRows.length + local.length >= limit) break;
					if (seen.has(item.sessionId)) continue;
					seen.add(item.sessionId);
					const summary = byId[item.sessionId];
					if (summary === undefined) continue;
					const archived = new Set(archivedSessionIds ?? []);
					if (!sessionVisible(summary, list.current, archived)) continue;
					remoteRows.push({
						id: summary.id,
						title: summary.blank ? "" : summary.displayTitle,
						blank: summary.blank === true,
						running: summary.running === true,
						runningSubagentCount: 0,
						completed: summary.completed === true,
						hasActiveSchedule: false,
						updatedAt: summary.updatedAt,
						snippet: item.snippet,
					});
				}
				visible = [...local, ...remoteRows];
			}

			const adoptPicked = (path) => {
				setFlowBusy(true);
				setFlowError(null);
				Promise.resolve()
					.then(() => createWorkspace({ path }))
					.then((workspace) => {
						setFlowBusy(false);
						setFlowOpen(false);
						startSession(workspace.workspaceId);
					})
					.catch((reason) => {
						setFlowBusy(false);
						setFlowError(reason instanceof Error ? reason.message : String(reason));
					});
			};

			return react.createElement("div", { className: "dsh-sa-root" },
				react.createElement("div", { className: "dsh-sa-header" },
					react.createElement("span", { className: "dsh-sa-label" }, "Sessions"),
					react.createElement("span", { className: "dsh-sa-headeractions" },
						(flowOccupied === true) && react.createElement("button", {
							type: "button",
							className: "dsh-sa-iconbtn",
							"aria-label": "Add workspace",
							title: "Add workspace",
							onClick: () => {
								setFlowError(null);
								setFlowOpen((v) => !v);
							},
						}, react.createElement(IconPlus, null)),
					),
				),
				react.createElement("div", { className: "dsh-sa-search" },
					react.createElement("span", { className: "dsh-sa-searchicon" },
						react.createElement(IconSearch, null)),
					react.createElement("input", {
						className: "dsh-sa-searchinput",
						type: "text",
						placeholder: "Search sessions",
						"aria-label": "Search sessions",
						maxLength: SEARCH_QUERY_MAX_CODE_UNITS,
						value: query,
						onChange: (e) => { setQuery(sanitizeSearchQuery(e.target.value)); },
						onKeyDown: (e) => {
							if (e.key === "Escape") setQuery("");
						},
					}),
				),
				(flowOpen && flowOccupied === true && typeof renderSlot === "function") &&
					react.createElement("div", { className: "dsh-sa-flow" },
						renderSlot(FLOW_HOLE, {
							open: flowOpen,
							busy: flowBusy,
							onPicked: adoptPicked,
							onCancel: () => {
								if (!flowBusy) {
									setFlowOpen(false);
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
				react.createElement("div", {
					className: "dsh-sa-list",
					role: "tree",
					"aria-label": "Sessions",
				},
					visible.length === 0
						? react.createElement("div", { className: "dsh-sa-empty" },
							normalizedQuery !== ""
								? (remote.status === "error" ? "Search unavailable" : "No matching sessions")
								: "No sessions")
						: visible.map((node) => react.createElement(SessionRow, {
							key: node.id,
							node,
							currentId: current,
							now,
							onOpen: open,
							onRename: renameSession,
							onFork: forkSession,
							onArchive: onSessionArchive,
						})),
				),
				(normalizedQuery !== "" && remote.hasMore === true) &&
					react.createElement("div", { className: "dsh-sa-more" }, "More results — narrow the search"),
			);
		}

		/* -------------------------------------------------------------------- css */

		const css = [
			".dsh-sa-root{display:flex;flex-direction:column;min-height:0;height:100%;gap:4px}",
			".dsh-sa-header{display:flex;align-items:center;justify-content:space-between;padding:2px 8px}",
			".dsh-sa-label{font-size:12px;font-weight:600;color:var(--dsw-alias-label-secondary,#8a8f98)}",
			".dsh-sa-headeractions{display:flex;align-items:center;gap:4px}",
			".dsh-sa-search{display:flex;align-items:center;gap:6px;margin:0 8px 2px;padding:4px 8px;border-radius:8px;background:var(--dsw-alias-interactive-bg-subtle,rgba(127,127,127,.12))}",
			".dsh-sa-searchicon{display:inline-flex;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-searchinput{flex:1;min-width:0;background:transparent;border:none;outline:none;color:inherit;font-size:13px}",
			".dsh-sa-list{flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;gap:1px;padding:0 4px 8px}",
			".dsh-sa-row{display:flex;align-items:center;gap:6px;height:32px;padding:0 8px;border-radius:8px;cursor:pointer;color:var(--dsw-alias-label-primary,inherit);user-select:none}",
			".dsh-sa-row:hover,.dsh-sa-selected{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
			".dsh-sa-slot{width:16px;height:20px;flex:none;display:inline-flex;align-items:center;justify-content:center}",
			".dsh-sa-dot{width:8px;height:8px;border-radius:50%}",
			".dsh-sa-dot-ongoing{background:#1f6feb}",
			".dsh-sa-dot-warning{background:#d97706}",
			".dsh-sa-dot-done{background:#1a7f37}",
			".dsh-sa-title{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:14px;line-height:20px;margin:0 4px}",
			".dsh-sa-time{flex:none;font-size:12px;line-height:20px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-actions{flex:none;display:none;align-items:center;gap:4px}",
			".dsh-sa-row:hover .dsh-sa-actions,.dsh-sa-row:focus-within .dsh-sa-actions{display:inline-flex}",
			".dsh-sa-row:hover .dsh-sa-time,.dsh-sa-row:focus-within .dsh-sa-time{display:none}",
			".dsh-sa-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;background:transparent;border:none;border-radius:6px;cursor:pointer;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-iconbtn:hover{color:var(--dsw-alias-label-primary,#fff);background:var(--dsw-alias-interactive-bg-active,rgba(127,127,127,.24))}",
			".dsh-sa-archive:hover{color:#f0883e}",
			".dsh-sa-menusep{position:relative;display:inline-flex}",
			".dsh-sa-menu{position:absolute;right:0;top:26px;z-index:30;display:flex;flex-direction:column;min-width:150px;padding:4px;border-radius:8px;background:var(--dsw-alias-elevated-fill,#1d1d20);border:1px solid var(--dsw-alias-border-l4,#3a3a3f);box-shadow:0 8px 24px rgba(0,0,0,.4)}",
			".dsh-sa-menuitem{background:transparent;border:none;text-align:left;padding:6px 10px;border-radius:6px;font-size:13px;color:inherit;cursor:pointer}",
			".dsh-sa-menuitem:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.16))}",
			".dsh-sa-modalwrap{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.5)}",
			".dsh-sa-modal{display:flex;flex-direction:column;gap:8px;min-width:260px;max-width:320px;padding:12px;border-radius:10px;background:var(--dsw-alias-elevated-fill,#1d1d20);border:1px solid var(--dsw-alias-border-l4,#3a3a3f)}",
			".dsh-sa-renameinput{background:var(--dsw-alias-button-elevated-fill,#2a2a2e);border:1px solid var(--dsw-alias-border-l4,#3a3a3f);border-radius:6px;color:inherit;padding:6px 8px;font-size:14px;outline:none}",
			".dsh-sa-modalrow{display:flex;justify-content:flex-end;gap:8px}",
			".dsh-sa-btn{background:transparent;border:1px solid var(--dsw-alias-border-l4,#3a3a3f);border-radius:6px;padding:5px 12px;font-size:13px;color:inherit;cursor:pointer}",
			".dsh-sa-primary{background:#1f6feb;border-color:#1f6feb;color:#fff}",
			".dsh-sa-error{font-size:12px;color:#f85149}",
			".dsh-sa-empty{padding:12px 8px;font-size:13px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
			".dsh-sa-more{padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary,#8a8f98)}",
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
		exports.SessionRow = SessionRow;
		exports.ArchivePane = ArchivePane;
		exports.sessionVisible = sessionVisible;
		exports.byRecency = byRecency;
		exports.deriveFlatRows = deriveFlatRows;
		exports.sanitizeSearchQuery = sanitizeSearchQuery;
		exports.timeLabel = timeLabel;
		return module.exports;
	},
});
