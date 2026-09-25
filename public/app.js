const ITEMS_PER_PAGE = 40;

// An item.icon can be either a local /icon-cache/... URL (always works)
// or an opportunistic browse.wf network fallback (server/src/itemsCache.ts's
// iconUrl() - only used when local extraction hasn't reached that item
// yet). The network case can fail (offline, or browse.wf itself down) -
// falling back to this placeholder on <img> error keeps that failure from
// ever showing a browser's default broken-image icon.
const ICON_PLACEHOLDER = "/assets/no-icon.svg";
function setIconSrc(img, src) {
    img.onerror = () => {
        img.onerror = null;
        img.src = ICON_PLACEHOLDER;
    };
    img.src = src;
}

// Firing all of a page's price/owned-count lookups at once used to trip
// warframe.market's rate limiting on broad searches (e.g. "meso" ->
// ~40 simultaneous /api/price calls) - stagger them through a small
// concurrency-limited queue instead. Shared by both /api/price and
// /api/owned calls, since they're both per-row lookups that fire at the
// same time on render and should share one request budget.
const FETCH_CONCURRENCY = 5;
let activeFetches = 0;
const fetchQueue = [];

function scheduleFetch(task) {
    fetchQueue.push(task);
    pumpFetchQueue();
}

function pumpFetchQueue() {
    while (activeFetches < FETCH_CONCURRENCY && fetchQueue.length > 0) {
        const task = fetchQueue.shift();
        activeFetches++;
        updatePriceLoadingIndicator();
        task().finally(() => {
            activeFetches--;
            updatePriceLoadingIndicator();
            pumpFetchQueue();
        });
    }
}

// Shows "Loading prices..." for as long as anything is still in-flight or
// queued through the shared fetch queue (price/owned-count/owned-rank
// lookups all go through it) - so a page whose rows have already
// rendered but whose values are still trickling in doesn't read as
// finished/stuck. Derived straight from the queue's own counters rather
// than tracked separately, so it can never drift out of sync with them.
function updatePriceLoadingIndicator() {
    priceLoadingEl.hidden = activeFetches === 0 && fetchQueue.length === 0;
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// The concurrency cap above shrinks how often a broad search trips
// warframe.market's rate limiting, but doesn't guarantee zero hits on a
// near-worst-case burst. Retry a couple of times with a short backoff
// before actually giving up and showing "?" - makes a transient
// rate-limit hit self-heal instead of needing the user to manually
// narrow the search to work around it. Used for both /api/price (rate
// limited by warframe.market) and /api/owned (not rate limited itself,
// but shares the retry-on-transient-failure behavior for consistency).
async function fetchJsonWithRetry(url, attempt = 0) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt >= 2) throw new Error(`HTTP ${res.status}`);
    await delay(500 * (attempt + 1));
    return fetchJsonWithRetry(url, attempt + 1);
}

const statusEl = document.getElementById("status");
const priceLoadingEl = document.getElementById("price-loading");
const searchEl = document.getElementById("search");
const listEl = document.getElementById("mod-list");
const rowTemplate = document.getElementById("mod-row-template");
const toastContainer = document.getElementById("toast-container");
const typeFilterEl = document.getElementById("type-filter");
const viewToggleEl = document.getElementById("view-toggle");
const prevPageBtn = document.getElementById("prev-page");
const nextPageBtn = document.getElementById("next-page");
const pageIndicatorEl = document.getElementById("page-indicator");
const sortSelectEl = document.getElementById("sort-select");
const ownedFilterEl = document.getElementById("owned-filter");
const rarityFilterEl = document.getElementById("rarity-filter");
const eraFilterEl = document.getElementById("era-filter");
const legendaryBtnEl = document.getElementById("rarity-legendary-btn");
const iconPreviewEl = document.getElementById("icon-preview");
const iconPreviewImgEl = document.getElementById("icon-preview-img");
const refreshPricesBtn = document.getElementById("refresh-prices-btn");

let allItems = [];
let typeFilter = "all";
let currentPage = 1;
let sortMode = "default";
let ownedFilter = "all"; // "all" | "owned" | "not-owned"
let rarityFilter = "all"; // mods/arcanes only
let eraFilter = "all"; // relics only

// A render() this large (owned-filter/sort can await a bulk fetch, price
// sort can await fetching an entire filtered set) can take a while - if
// the user changes something before it finishes, an older in-flight
// render must never clobber a newer one's result. Each render() captures
// its own generation number and checks it's still current before
// touching the DOM.
let renderGeneration = 0;

function setStatus(text) {
    statusEl.textContent = text;
}

function toast(message, ok) {
    const el = document.createElement("div");
    el.className = `toast ${ok ? "ok" : "err"}`;
    el.textContent = message;
    toastContainer.appendChild(el);
    setTimeout(() => el.remove(), 6000);
}

// This app runs entirely off its local cache (catalog + prices + icons) -
// see server/src/itemsCache.ts/priceCache.ts/localIcons.ts's module
// comments. GET /api/items never touches the network and never rejects;
// an empty result specifically means no cache exists at all yet (a
// genuinely fresh install with no seed, before the first "Update Data"),
// not a transient failure.
async function loadItems() {
    setStatus("Loading local catalog...");
    try {
        const res = await fetch("/api/items");
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        allItems = await res.json();
        if (allItems.length === 0) {
            setStatus("No local data yet - connect to the internet once and click Update Data.");
            return;
        }
        render();
    } catch (err) {
        setStatus(`Failed to load items: ${err.message}`);
    }
}

// "Update Data" button - the only thing that ever talks to
// warframe.market or extracts icons (see server/src/routes.ts's POST
// /api/update-data). Everything else - browsing, pricing, icons - runs
// off the local cache with zero network calls, so this button is the
// user's explicit "go get anything new" action, not something that runs
// on its own. Takes a while server-side (catalog refresh, then a full
// price resweep, then icon extraction) and runs in the background, so
// this just starts it and polls /api/status for progress/completion
// rather than waiting on the POST itself.
let refreshPollTimer = null;

function setRefreshButtonState(inProgress) {
    refreshPricesBtn.disabled = inProgress;
    refreshPricesBtn.textContent = inProgress ? "Updating Data…" : "Update Data";
}

function isUpdateInProgress(status) {
    return status.catalog.refreshInProgress || status.database.refreshInProgress || status.icons.extracting;
}

async function pollRefreshStatus() {
    try {
        const status = await fetchJsonWithRetry("/api/status");
        if (isUpdateInProgress(status)) {
            setRefreshButtonState(true);
            return;
        }
    } catch {
        // A transient /api/status failure shouldn't get the button stuck
        // showing "Updating..." forever - fall through and stop polling,
        // same as if the refresh had finished.
    }
    setRefreshButtonState(false);
    clearInterval(refreshPollTimer);
    refreshPollTimer = null;
    // The catalog may have gone from empty to populated (first-ever
    // update on a fresh install) - reload so the shop actually shows it
    // without needing a manual page refresh.
    if (allItems.length === 0) loadItems();
}

function startPollingRefreshStatus() {
    if (refreshPollTimer !== null) return;
    setRefreshButtonState(true);
    refreshPollTimer = setInterval(pollRefreshStatus, 5000);
}

refreshPricesBtn.addEventListener("click", async () => {
    setRefreshButtonState(true);
    try {
        const res = await fetch("/api/update-data", { method: "POST" });
        if (res.status === 409) {
            toast("An update is already running.", true);
            startPollingRefreshStatus();
            return;
        }
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        toast("Update started - this takes several minutes.", true);
        startPollingRefreshStatus();
    } catch (err) {
        toast(`Failed to start update: ${err.message}`, false);
        setRefreshButtonState(false);
    }
});

// Reflects a refresh already in progress from before this page load
// (e.g. the page was reloaded mid-sweep, or another browser tab started
// one) rather than only ever reacting to this tab's own button click.
(async () => {
    try {
        const status = await fetchJsonWithRetry("/api/status");
        if (isUpdateInProgress(status)) startPollingRefreshStatus();
    } catch {
        // Best-effort only - the button just stays in its default state.
    }
})();

function matchesTypeFilter(item) {
    if (typeFilter === "all") return true;
    if (typeFilter === "prime") return item.type === "prime_part" || item.type === "prime_set";
    return item.type === typeFilter;
}

function getFilteredItems() {
    const query = searchEl.value.trim().toLowerCase();
    return allItems.filter(item => {
        if (!matchesTypeFilter(item)) return false;
        if (query && !item.name.toLowerCase().includes(query)) return false;
        if ((item.type === "mod" || item.type === "arcane") && rarityFilter !== "all" && item.rarity !== rarityFilter) return false;
        if (item.type === "relic" && eraFilter !== "all" && item.relicEra !== eraFilter) return false;
        return true;
    });
}

// Bulk total-owned-per-item map (see routes.ts's /api/owned-summary) -
// loaded lazily, once, the first time an owned-based filter or sort is
// actually used, then kept for the rest of the session. All in-memory
// data server-side (no external calls), so this is cheap even though it
// covers the whole catalog at once - the alternative (resolving "am I
// filtering out this item" per-row like price/owned-count already do)
// doesn't work for a FILTER, which needs to know before deciding what's
// even on the page.
let ownedSummary = null;
let ownedSummaryPromise = null;

function ensureOwnedSummary() {
    if (ownedSummary) return Promise.resolve(ownedSummary);
    if (!ownedSummaryPromise) {
        ownedSummaryPromise = fetch("/api/owned-summary")
            .then(res => res.json())
            .then(body => {
                ownedSummary = body.owned || {};
                return ownedSummary;
            })
            .catch(() => {
                // Fail open - an unfiltered/unsorted-by-owned view is
                // better than the whole page refusing to render.
                ownedSummary = {};
                return ownedSummary;
            });
    }
    return ownedSummaryPromise;
}

function ownedCountFor(item) {
    return (ownedSummary && ownedSummary[item.gameRef]) || 0;
}

// Client-side price cache, keyed by the item's DEFAULT display state
// (rank 0 / default refinement - whatever a freshly-rendered row shows
// before anyone touches its stepper), so "sort by price" can reuse
// anything already seen this session instead of always re-fetching, and
// so the comparison is apples-to-apples across items (comparing one
// item's rank-3 price against another's rank-0 price wouldn't mean
// anything). Populated both here (bulk sort fetch) and opportunistically
// by each row's own fetchPrice() when it happens to be at rank 0/default.
const clientPriceCache = new Map();

function defaultPriceCacheKey(item) {
    const subtype = item.refinements ? item.defaultSubtype : "regular";
    return `${item.slug}:${subtype}:0`;
}

async function ensurePricesFor(items) {
    const toFetch = items.filter(item => !clientPriceCache.has(defaultPriceCacheKey(item)));
    await Promise.all(
        toFetch.map(
            item =>
                new Promise(resolve => {
                    scheduleFetch(() =>
                        fetchJsonWithRetry(
                            `/api/price/${encodeURIComponent(item.slug)}?subtype=${encodeURIComponent(item.refinements ? item.defaultSubtype : "regular")}&rank=0`
                        )
                            .then(info => {
                                clientPriceCache.set(defaultPriceCacheKey(item), info.platinum);
                            })
                            .catch(() => {
                                clientPriceCache.set(defaultPriceCacheKey(item), null);
                            })
                            .finally(resolve)
                    );
                })
        )
    );
}

function cachedPriceFor(item) {
    const key = defaultPriceCacheKey(item);
    return clientPriceCache.has(key) ? clientPriceCache.get(key) : null;
}

const TYPE_SORT_ORDER = { mod: 0, arcane: 1, relic: 2, prime_part: 3, prime_set: 3 };

// Applied to the already-grouped display rows (post prime-set collapsing)
// rather than the raw item list, so a set sorts as one unit alongside
// everything else instead of its (hidden) children being compared
// individually. Returns a NEW array - never mutates `rows` in place,
// since the caller may still need the original order (e.g. if a sort
// mode is later changed back to "default").
async function applySort(rows) {
    if (sortMode === "default") return rows;

    if (sortMode === "name-asc" || sortMode === "name-desc") {
        const sorted = [...rows].sort((a, b) => a.item.name.localeCompare(b.item.name));
        return sortMode === "name-asc" ? sorted : sorted.reverse();
    }

    if (sortMode === "type") {
        return [...rows].sort((a, b) => TYPE_SORT_ORDER[a.item.type] - TYPE_SORT_ORDER[b.item.type]);
    }

    if (sortMode === "owned-asc" || sortMode === "owned-desc") {
        await ensureOwnedSummary();
        const sorted = [...rows].sort((a, b) => ownedCountFor(a.item) - ownedCountFor(b.item));
        return sortMode === "owned-desc" ? sorted.reverse() : sorted;
    }

    if (sortMode === "price-asc" || sortMode === "price-desc") {
        await ensurePricesFor(rows.map(r => r.item));
        // Sorting an ascending result with .reverse() (like name/owned
        // above) would flip "unknown price" items from last to first on
        // descending - handle the null case directly in the comparator
        // instead, with the direction only affecting the known-vs-known
        // comparison.
        const dir = sortMode === "price-asc" ? 1 : -1;
        return [...rows].sort((a, b) => {
            const pa = cachedPriceFor(a.item);
            const pb = cachedPriceFor(b.item);
            if (pa == null && pb == null) return 0;
            if (pa == null) return 1; // unknown price always sorts last, either direction
            if (pb == null) return -1;
            return (pa - pb) * dir;
        });
    }

    return rows;
}

// Collapse a Prime set's individual part rows into their owning set row
// (one top-level row instead of one-per-part) whenever the set itself is
// also present in the current filtered results - expanding it always
// shows the real parts (resolved fresh from allItems by gameRef, not
// re-filtered), so toggling it open never depends on what search text got
// you there. A part whose set ISN'T in the current results (e.g.
// searching "chassis" matches every frame's Chassis Blueprint by name but
// no set name contains "chassis") has nothing to nest under, so it stays
// a normal flat row - deliberate fallback rather than hiding it.
function buildDisplayRows(matches) {
    const byGameRef = new Map(allItems.map(i => [i.gameRef, i]));
    const matchedSetGameRefs = new Set(matches.filter(i => i.type === "prime_set").map(i => i.gameRef));
    const partsOwnedByMatchedSets = new Set();
    for (const item of matches) {
        if (item.type === "prime_set") {
            for (const part of item.parts) partsOwnedByMatchedSets.add(part.gameRef);
        }
    }

    const rows = [];
    for (const item of matches) {
        if (item.type === "prime_part" && partsOwnedByMatchedSets.has(item.gameRef)) continue;
        if (item.type === "prime_set" && matchedSetGameRefs.has(item.gameRef)) {
            // item.parts can list the same gameRef more than once - some
            // weapon Prime sets need 2 copies of the same real part to
            // grant (see itemsCache.ts's buildPrimeCategoryItems()) - but
            // the accordion should still show each distinct part once.
            const seenGameRefs = new Set();
            const children = [];
            for (const part of item.parts) {
                if (seenGameRefs.has(part.gameRef)) continue;
                seenGameRefs.add(part.gameRef);
                const child = byGameRef.get(part.gameRef);
                if (child) children.push(child);
            }
            rows.push({ item, children });
        } else {
            rows.push({ item, children: null });
        }
    }
    return rows;
}

async function render() {
    const myGeneration = ++renderGeneration;

    let matches = getFilteredItems();

    if (ownedFilter !== "all") {
        await ensureOwnedSummary();
        if (myGeneration !== renderGeneration) return; // superseded while awaiting
        matches = matches.filter(item => (ownedFilter === "owned") === (ownedCountFor(item) > 0));
    }

    let rows = buildDisplayRows(matches);

    rows = await applySort(rows);
    if (myGeneration !== renderGeneration) return; // superseded while awaiting (esp. a slow price sort)

    const totalPages = Math.max(1, Math.ceil(rows.length / ITEMS_PER_PAGE));
    currentPage = Math.min(Math.max(1, currentPage), totalPages);

    const start = (currentPage - 1) * ITEMS_PER_PAGE;
    const pageRows = rows.slice(start, start + ITEMS_PER_PAGE);

    listEl.innerHTML = "";
    pageRows.forEach(({ item, children }) => {
        const row = renderRow(item);
        listEl.appendChild(row);
        if (children) attachSetChildren(row, children);
        attachOwnedRanksDisplay(row, item); // no-ops internally for non-rankable items
    });

    setStatus(rows.length === 0 ? "No matches." : `${rows.length} item${rows.length === 1 ? "" : "s"} match.`);

    pageIndicatorEl.textContent = `Page ${currentPage} of ${totalPages}`;
    prevPageBtn.disabled = currentPage <= 1;
    nextPageBtn.disabled = currentPage >= totalPages;
}

// Repurposes a Prime set row's otherwise-unused Sell button slot (sets
// can't be sold as a unit - see renderRow's module comment) into a
// collapse/expand toggle for its real parts (2-4 for Warframes and
// weapons alike, since both are drawn from the same deduped per-part
// catalog rows - see itemsCache.ts's buildPrimeCategoryItems()), rendered
// as ordinary nested rows via the same renderRow() every other item uses.
function attachSetChildren(row, childItems) {
    const toggleBtn = row.querySelector(".btn-sell");
    toggleBtn.classList.remove("btn-sell");
    toggleBtn.classList.add("btn-toggle-parts");
    toggleBtn.title = "";
    toggleBtn.textContent = "▸ Parts";

    const childrenEl = document.createElement("div");
    childrenEl.className = "set-children";
    childrenEl.hidden = true;
    childItems.forEach(childItem => {
        childrenEl.appendChild(renderRow(childItem));
    });

    toggleBtn.addEventListener("click", () => {
        childrenEl.hidden = !childrenEl.hidden;
        toggleBtn.textContent = childrenEl.hidden ? "▸ Parts" : "▾ Parts";
    });

    row.after(childrenEl);
}

// Ranked (rank > 0) mod/arcane copies are unique-instance database
// records, invisible to the plain "Owned: N" count (which only ever
// reflects the rank-0 RawUpgrades stack - see fetchOwned() inside
// renderRow) - owning a rank 0, rank 3, and max-rank copy at once would
// otherwise collapse into one ambiguous number. This shows each owned
// rank as its own line via a toggle, with its own Sell button that
// removes exactly ONE instance at that exact rank - the server resolves
// which real database id to delete (routes.ts's takeOidForRank()), this
// function never sees an oid itself. No-ops for anything that isn't
// rankable at all (relics, Prime parts/sets - item.maxRank is null).
function attachOwnedRanksDisplay(row, item) {
    if (item.maxRank === null || item.maxRank <= 0) return;

    const toggleBtn = row.querySelector(".owned-ranks-toggle");
    let listEl = null;
    let currentRanks = [];

    function updateToggleLabel() {
        const totalOwned = currentRanks.reduce((sum, r) => sum + r.count, 0);
        const expanded = listEl && !listEl.hidden;
        const arrow = expanded ? "▾" : "▸";
        const noun = currentRanks.length === 1 ? "another rank" : "other ranks";
        toggleBtn.textContent = `${arrow} ${totalOwned} owned at ${noun}`;
    }

    function renderList() {
        listEl.innerHTML = "";
        currentRanks.forEach(({ rank, count }) => {
            const line = document.createElement("div");
            line.className = "owned-rank-row";

            const label = document.createElement("span");
            label.className = "owned-rank-label";
            label.textContent = `Rank ${rank}${rank === item.maxRank ? " (Max)" : ""} — Owned: ${count}`;

            const price = document.createElement("span");
            price.className = "owned-rank-price";
            price.textContent = "…";
            function fetchRankPrice() {
                price.textContent = "…";
                price.classList.remove("retryable");
                scheduleFetch(() =>
                    fetchJsonWithRetry(`/api/price/${encodeURIComponent(item.slug)}?subtype=regular&rank=${rank}`)
                        .then(info => {
                            price.textContent = info.platinum != null ? `${info.platinum}p` : "no price";
                        })
                        .catch(() => {
                            price.textContent = "?";
                            price.classList.add("retryable");
                        })
                );
            }
            // A "?" means the fetch itself failed (not a real "no price"
            // answer from the server) - click it to try again instead of
            // it being a dead end until the next full re-render.
            price.addEventListener("click", () => {
                if (price.classList.contains("retryable")) fetchRankPrice();
            });
            fetchRankPrice();

            const buyBtn = document.createElement("button");
            buyBtn.className = "btn btn-buy";
            buyBtn.textContent = "Buy";
            buyBtn.addEventListener("click", () => buyOneAtRank(rank, price, buyBtn));

            const sellBtn = document.createElement("button");
            sellBtn.className = "btn btn-sell";
            sellBtn.textContent = "Sell";
            sellBtn.addEventListener("click", () => sellOneAtRank(rank, sellBtn));

            line.appendChild(label);
            line.appendChild(price);
            line.appendChild(buyBtn);
            line.appendChild(sellBtn);
            listEl.appendChild(line);
        });
    }

    function refresh() {
        scheduleFetch(() =>
            fetchJsonWithRetry(`/api/owned-ranks/${encodeURIComponent(item.slug)}`)
                .then(info => {
                    currentRanks = (info.ranks || []).filter(r => r.count > 0);
                    if (currentRanks.length === 0) {
                        toggleBtn.hidden = true;
                        if (listEl) listEl.hidden = true;
                        return;
                    }
                    toggleBtn.hidden = false;
                    if (!listEl) {
                        listEl = document.createElement("div");
                        listEl.className = "owned-ranks-list";
                        listEl.hidden = true;
                        row.after(listEl);
                        toggleBtn.addEventListener("click", () => {
                            listEl.hidden = !listEl.hidden;
                            updateToggleLabel();
                        });
                    }
                    renderList();
                    updateToggleLabel();
                })
                .catch(() => {
                    // Secondary display, not the main price/owned-count path -
                    // fail quietly rather than adding another toast for it.
                })
        );
    }

    // Buying a specific rank here is the exact same mechanism the main
    // row's rank stepper already uses (a plain rank>0 buy order) - just a
    // convenience shortcut for "buy one more at a rank I already own
    // some of", not a new order type.
    async function buyOneAtRank(rank, priceEl, btnEl) {
        const platinum = parseInt(priceEl.textContent, 10);
        if (Number.isNaN(platinum)) {
            toast(`No known price for ${item.name} at rank ${rank} yet - try again in a moment.`, false);
            return;
        }
        btnEl.disabled = true;
        try {
            const res = await fetch("/api/order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gameRef: item.gameRef, direction: "buy", price: platinum, rank })
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || res.statusText);
            toast(`Buying ${item.name} (Rank ${rank})...`, true);
            pollRankedOrder(body.orderId, "buy", rank, btnEl, refresh);
        } catch (err) {
            toast(`Order failed: ${err.message}`, false);
            btnEl.disabled = false;
        }
    }

    async function sellOneAtRank(rank, btnEl) {
        if (!confirm(`Sell your rank ${rank} copy of "${item.name}"? This removes it from your inventory.`)) return;
        btnEl.disabled = true;
        try {
            const priceInfo = await fetchJsonWithRetry(`/api/price/${encodeURIComponent(item.slug)}?subtype=regular&rank=${rank}`);
            if (priceInfo.platinum == null) {
                toast(`No known price for ${item.name} at rank ${rank} - try again in a moment.`, false);
                btnEl.disabled = false;
                return;
            }
            const res = await fetch("/api/order", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ gameRef: item.gameRef, direction: "sell", price: priceInfo.platinum, rank })
            });
            const body = await res.json();
            if (!res.ok) throw new Error(body.error || res.statusText);
            toast(`Selling ${item.name} (Rank ${rank})...`, true);
            pollRankedOrder(body.orderId, "sell", rank, btnEl, refresh);
        } catch (err) {
            toast(`Order failed: ${err.message}`, false);
            btnEl.disabled = false;
        }
    }

    refresh();
}

function pollRankedOrder(orderId, direction, rank, btnEl, onSettled) {
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`/api/order/${orderId}`);
            const order = await res.json();
            if (order.status === "done") {
                clearInterval(interval);
                toast(`${direction === "buy" ? "Bought" : "Sold"} rank ${rank} copy for ${order.price}p.`, true);
                onSettled(); // re-fetches the breakdown, rebuilding the list with fresh (enabled) buttons
            } else if (order.status === "failed") {
                clearInterval(interval);
                toast(`${direction === "buy" ? "Buy" : "Sell"} failed: ${order.detail || "unknown error"}`, false);
                btnEl.disabled = false;
            }
            // else still pending/processing - keep polling
        } catch (err) {
            clearInterval(interval);
            toast(`Lost track of order: ${err.message}`, false);
            btnEl.disabled = false;
        }
    }, 1500);
}

function capitalize(s) {
    return s.length ? s[0].toUpperCase() + s.slice(1) : s;
}

// Small bottom-right badge on a Prime part's icon showing which slot it is
// (item.slot, set server-side in itemsCache.ts from the part's gameRef
// suffix). Warframe parts are one of exactly 4 fixed slots; weapon parts
// vary by weapon type (2-4 real parts, ~17 possible slot names - see
// itemsCache.ts's weaponPrimeSlotFromGameRef()). Hand-drawn glyphs, not
// real game assets - the actual slot icon textures aren't exposed in the
// local Public Export data (they're packed game textures). Paths
// deliberately avoid fine detail since they render at ~10-12px. The
// rarer/more specific weapon slots (gauntlet/guard/head/disc/grip/boot/
// chain/ornament/upperLimb/lowerLimb - ~10% of real weapon parts) share
// one generic "component" glyph rather than 10 more bespoke shapes -
// SLOT_LABELS still gives each its own exact tooltip text.
const SLOT_ICONS = {
    blueprint:
        '<rect x="5" y="3" width="14" height="18" rx="1.5"/>' +
        '<path d="M8 8h8M8 12h8M8 16h5" stroke="var(--bg)" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
    helmet:
        '<path d="M12 4a8 8 0 0 0-8 8v7a1 1 0 0 0 1 1h4v-6a3 3 0 0 1 6 0v6h4a1 1 0 0 0 1-1v-7a8 8 0 0 0-8-8z"/>',
    chassis:
        '<path d="M12 3l7 3v5c0 5-3 8.5-7 10-4-1.5-7-5-7-10V6z"/>',
    systems:
        '<path d="M9 3h6v3h3v6h-3v3H9v-3H6V6h3z"/>' +
        '<rect x="10" y="10" width="4" height="4" fill="var(--bg)"/>',
    barrel:
        '<rect x="4" y="10" width="16" height="4" rx="1"/>' +
        '<rect x="15" y="9" width="2" height="6" fill="var(--bg)"/>',
    receiver:
        '<rect x="4" y="8" width="16" height="8" rx="1.5"/>' +
        '<rect x="8" y="8" width="2" height="8" fill="var(--bg)"/>' +
        '<rect x="14" y="8" width="2" height="8" fill="var(--bg)"/>',
    stock:
        '<path d="M4 9h9l6 3v3l-6 3H4a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z"/>',
    blade:
        '<path d="M6 21l3-16 3-2 2 2-6 16z"/>',
    handle:
        '<rect x="9" y="3" width="6" height="14" rx="2"/>' +
        '<path d="M7 17h10v2a2 2 0 0 1-2 2H9a2 2 0 0 1-2-2z"/>',
    link:
        '<circle cx="9" cy="9" r="4" fill="none" stroke="currentColor" stroke-width="2.5"/>' +
        '<circle cx="15" cy="15" r="4" fill="none" stroke="currentColor" stroke-width="2.5"/>',
    component:
        '<path d="M12 3l3 3-3 3-3-3z"/>' +
        '<path d="M12 15l3 3-3 3-3-3z"/>' +
        '<path d="M3 12l3-3 3 3-3 3z"/>' +
        '<path d="M15 12l3-3 3 3-3 3z"/>'
};

const SLOT_LABELS = {
    blueprint: "Blueprint",
    helmet: "Neuroptics",
    chassis: "Chassis",
    systems: "Systems",
    barrel: "Barrel",
    receiver: "Receiver",
    stock: "Stock",
    blade: "Blade",
    handle: "Handle",
    link: "Link",
    gauntlet: "Gauntlet",
    guard: "Guard",
    head: "Head",
    disc: "Disc",
    grip: "Grip",
    boot: "Boot",
    chain: "Chain",
    ornament: "Ornament",
    string: "String",
    upperLimb: "Upper Limb",
    lowerLimb: "Lower Limb"
};

// Slots sharing the generic "component" glyph (see SLOT_ICONS comment).
const GENERIC_COMPONENT_SLOTS = new Set([
    "gauntlet", "guard", "head", "disc", "grip", "boot", "chain", "ornament", "string", "upperLimb", "lowerLimb"
]);

// Shows a larger version of an item's icon next to the cursor on hover -
// especially useful for reading a mod's artwork/text at a size the tiny
// row icon can't. pointer-events:none on the popup (see style.css) means
// it never itself triggers mouseleave, so this stays simple: just follow
// the cursor and flip to the other side if it would run off-screen.
function attachIconPreview(icon, item) {
    if (!item.icon) return;
    icon.addEventListener("mouseenter", () => {
        setIconSrc(iconPreviewImgEl, item.icon);
        iconPreviewImgEl.alt = item.name;
        iconPreviewEl.hidden = false;
    });
    icon.addEventListener("mousemove", e => {
        const margin = 16;
        const width = iconPreviewEl.offsetWidth;
        const height = iconPreviewEl.offsetHeight;
        let x = e.clientX + margin;
        if (x + width > window.innerWidth - 8) {
            x = e.clientX - margin - width; // flip to the left of the cursor instead
        }
        let y = e.clientY - height / 2;
        y = Math.max(8, Math.min(y, window.innerHeight - height - 8));
        iconPreviewEl.style.left = `${x}px`;
        iconPreviewEl.style.top = `${y}px`;
    });
    icon.addEventListener("mouseleave", () => {
        iconPreviewEl.hidden = true;
    });
}

function applySlotBadge(row, item) {
    const badge = row.querySelector(".slot-badge");
    if (!item.slot || !SLOT_LABELS[item.slot]) {
        badge.hidden = true;
        return;
    }
    const iconKey = GENERIC_COMPONENT_SLOTS.has(item.slot) ? "component" : item.slot;
    badge.hidden = false;
    badge.title = SLOT_LABELS[item.slot];
    badge.innerHTML = `<svg viewBox="0 0 24 24">${SLOT_ICONS[iconKey]}</svg>`;
}

// The same +/-/value markup (".rank-stepper") is reused for two different
// variant kinds: mod/arcane RANK (a numeric 0..maxRank range, set via a
// Fingerprint on the grant - buy-only, see routes.ts) and relic REFINEMENT
// (a named Intact/Exceptional/Flawless/Radiant list - just a different
// plain grantable path per option, so it works for both buy AND sell).
function renderRow(item) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    const icon = row.querySelector(".mod-icon");
    const name = row.querySelector(".mod-name");
    const price = row.querySelector(".mod-price");
    const buyBtn = row.querySelector(".btn-buy");
    const sellBtn = row.querySelector(".btn-sell");
    const stepper = row.querySelector(".rank-stepper");
    const stepperValue = row.querySelector(".rank-value");
    const stepperMinus = row.querySelector(".rank-minus");
    const stepperPlus = row.querySelector(".rank-plus");
    const ownedEl = row.querySelector(".owned-count");

    if (item.icon) setIconSrc(icon, item.icon);
    icon.alt = item.name;
    name.textContent = item.name;
    applySlotBadge(row, item);
    attachIconPreview(icon, item);

    // A Prime set isn't a single grantable item - buying it fires the
    // backend's multi-part grant loop (see routes.ts/Market Sync.pluto),
    // and selling a whole set isn't supported at all (only individual
    // parts can be sold back - see itemsCache.ts's module comment for
    // why the set's own gameRef can never be granted/sold directly). Its
    // Sell button slot gets repurposed into a parts dropdown toggle by
    // attachSetChildren() instead - see render().
    if (item.type === "prime_set") {
        buyBtn.textContent = "Buy Full Set";
    }

    const isRefinable = item.refinements !== null && item.refinements.length > 0;
    const isRankable = item.maxRank !== null && item.maxRank > 0;

    // Both reset whenever this row is re-created (page/search/filter
    // change re-renders everything from scratch) - a deliberate
    // simplification rather than tracking per-item state across renders.
    let selectedRank = 0;
    let refinementIndex = isRefinable ? Math.max(0, item.refinements.indexOf(item.defaultSubtype)) : 0;

    function currentSubtype() {
        return isRefinable ? item.refinements[refinementIndex] : item.defaultSubtype;
    }

    function fetchPrice() {
        price.textContent = "…";
        price.classList.remove("retryable");
        scheduleFetch(() =>
            fetchJsonWithRetry(
                `/api/price/${encodeURIComponent(item.slug)}?subtype=${encodeURIComponent(currentSubtype())}&rank=${selectedRank}`
            )
                .then(info => {
                    price.textContent = info.platinum != null ? `${info.platinum}p` : "no price";
                    // Feeds "sort by price"'s cache for free whenever a row
                    // happens to be at its default rank/refinement - see
                    // defaultPriceCacheKey's comment for why only the
                    // default state counts.
                    if (selectedRank === 0 && currentSubtype() === (item.refinements ? item.defaultSubtype : "regular")) {
                        clientPriceCache.set(defaultPriceCacheKey(item), info.platinum);
                    }
                })
                .catch(() => {
                    price.textContent = "?";
                    price.classList.add("retryable");
                })
        );
    }

    // A "?" means the fetch itself failed (not a real "no price" answer
    // from the server) - click it to try again instead of it being a
    // dead end until the next full re-render.
    price.addEventListener("click", () => {
        if (price.classList.contains("retryable")) fetchPrice();
    });

    // Owned count, reported by Market Sync.pluto from /api/inventory.php
    // (see itemsCache.ts/routes.ts's /api/owned) - a UX aid only, NOT a
    // safety mechanism (SpaceNinjaServer itself already rejects overselling
    // - see inventorySnapshot.ts's module comment), so a wrong/stale/
    // unknown count just means Sell might stay enabled for something you
    // don't have, resulting in a normal failed-order toast, not real data
    // loss. `known` stays false (shown as "Owned: ?", never blocks Sell)
    // until Market Sync.pluto's first inventory sync lands - distinct from
    // a confirmed "Owned: 0".
    let ownedCount = null;
    let ownedKnown = false;

    // A Prime set has no single "owned" count (buying one grants several
    // different real parts, never the set's own path) and its Sell slot
    // is repurposed as the parts-dropdown toggle anyway - skip entirely.
    function fetchOwned() {
        if (item.type === "prime_set") return;
        ownedEl.hidden = false;
        ownedEl.textContent = "Owned: …";
        ownedEl.classList.remove("none", "retryable");
        scheduleFetch(() =>
            fetchJsonWithRetry(`/api/owned/${encodeURIComponent(item.slug)}?refinement=${encodeURIComponent(currentSubtype())}`)
                .then(info => {
                    ownedKnown = info.known;
                    ownedCount = info.known ? info.owned : null;
                    ownedEl.textContent = info.known ? `Owned: ${info.owned}` : "Owned: ?";
                    ownedEl.classList.toggle("none", info.known && info.owned === 0);
                    ownedEl.classList.toggle("retryable", !info.known);
                    updateSellAvailability();
                })
                .catch(() => {
                    ownedEl.textContent = "Owned: ?";
                    ownedEl.classList.remove("none");
                    ownedEl.classList.add("retryable");
                })
        );
    }

    // "Owned: ?" means either the fetch failed or no inventory sync has
    // landed yet - click it to try again in either case rather than
    // waiting for the next full re-render.
    ownedEl.addEventListener("click", () => {
        if (ownedEl.classList.contains("retryable")) fetchOwned();
    });

    // Applied optimistically right after a buy/sell order completes, so
    // the count/Sell-availability update instantly instead of waiting up
    // to INVENTORY_POLL_MS (30s) for Market Sync.pluto's next real sync.
    // Only touches state we actually have (ownedKnown) - never fabricates
    // a count we haven't confirmed via /api/owned at least once.
    function adjustOwnedLocally(delta) {
        if (!ownedKnown) return;
        ownedCount = Math.max(0, ownedCount + delta);
        ownedEl.textContent = `Owned: ${ownedCount}`;
        ownedEl.classList.toggle("none", ownedCount === 0);
        updateSellAvailability();
    }

    // Selling a specific RANKED mod/arcane copy isn't supported (would
    // need an /api/inventory.php oid lookup) - disable Sell whenever a
    // nonzero rank is selected. Relic refinement has no such limit (every
    // refinement is still a plain stackable grant), so Sell always stays
    // available for relics regardless of the stepper position. Also
    // disables whenever the owned count is confirmed 0 - "confirmed"
    // meaning ownedKnown, so an unfetched/unknown count never blocks Sell.
    function updateSellAvailability() {
        const rankBlocked = isRankable && selectedRank > 0;
        const outOfStock = ownedKnown && ownedCount === 0;
        sellBtn.disabled = rankBlocked || outOfStock;
        sellBtn.title = rankBlocked
            ? "Selling a specific rank isn't supported yet - reset to Rank 0 to sell."
            : outOfStock
              ? "You don't own any of these to sell."
              : "";
    }

    if (isRankable) {
        stepper.hidden = false;
        const refresh = () => {
            stepperValue.textContent = `${selectedRank} of ${item.maxRank}`;
            stepperMinus.disabled = selectedRank <= 0;
            stepperPlus.disabled = selectedRank >= item.maxRank;
            updateSellAvailability();
            fetchPrice();
        };
        stepperMinus.addEventListener("click", () => {
            if (selectedRank <= 0) return;
            selectedRank--;
            refresh();
        });
        stepperPlus.addEventListener("click", () => {
            if (selectedRank >= item.maxRank) return;
            selectedRank++;
            refresh();
        });
        stepperValue.textContent = `${selectedRank} of ${item.maxRank}`;
        stepperMinus.disabled = true;
        stepperPlus.disabled = item.maxRank === 0;
    } else if (isRefinable) {
        stepper.hidden = false;
        const refresh = () => {
            stepperValue.textContent = capitalize(item.refinements[refinementIndex]);
            stepperMinus.disabled = refinementIndex <= 0;
            stepperPlus.disabled = refinementIndex >= item.refinements.length - 1;
            fetchPrice();
            fetchOwned();
        };
        stepperMinus.addEventListener("click", () => {
            if (refinementIndex <= 0) return;
            refinementIndex--;
            refresh();
        });
        stepperPlus.addEventListener("click", () => {
            if (refinementIndex >= item.refinements.length - 1) return;
            refinementIndex++;
            refresh();
        });
        stepperValue.textContent = capitalize(item.refinements[refinementIndex]);
        stepperMinus.disabled = refinementIndex <= 0;
        stepperPlus.disabled = refinementIndex >= item.refinements.length - 1;
    }

    fetchPrice();
    fetchOwned();

    updateSellAvailability();

    buyBtn.addEventListener("click", () =>
        placeOrder(item, "buy", price, buyBtn, sellBtn, selectedRank, currentSubtype(), updateSellAvailability, adjustOwnedLocally)
    );
    // Sets don't get a Sell listener at all - their Sell button slot is
    // repurposed as a parts-dropdown toggle by attachSetChildren(), which
    // attaches its own click handler to the same element instead.
    if (item.type !== "prime_set") {
        sellBtn.addEventListener("click", () => {
            if (!confirm(`Sell your copy of "${item.name}"? This removes it from your inventory.`)) return;
            placeOrder(item, "sell", price, buyBtn, sellBtn, 0, currentSubtype(), updateSellAvailability, adjustOwnedLocally);
        });
    }

    return row;
}

// restoreSellState re-applies the rank-gated Sell disable instead of
// blindly clearing it - otherwise finishing an order while a nonzero
// rank is selected would incorrectly re-enable Sell for a rank it can't
// actually target.
async function placeOrder(item, direction, priceEl, buyBtn, sellBtn, rank, refinement, restoreSellState, adjustOwnedLocally) {
    const priceText = priceEl.textContent;
    const platinum = parseInt(priceText, 10);
    if (Number.isNaN(platinum)) {
        toast(`No known price for ${item.name} yet - try again in a moment.`, false);
        return;
    }
    buyBtn.disabled = true;
    sellBtn.disabled = true;
    try {
        const res = await fetch("/api/order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameRef: item.gameRef, direction, price: platinum, rank, refinement })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        const variantNote =
            direction === "buy" && rank > 0
                ? ` (Rank ${rank})`
                : item.type === "relic"
                  ? ` (${capitalize(refinement)})`
                  : "";
        toast(`${direction === "buy" ? "Buying" : "Selling"} ${item.name}${variantNote}...`, true);
        pollOrder(body.orderId, item, direction, rank, buyBtn, restoreSellState, adjustOwnedLocally);
    } catch (err) {
        toast(`Order failed: ${err.message}`, false);
        buyBtn.disabled = false;
        restoreSellState();
    }
}

function pollOrder(orderId, item, direction, rank, buyBtn, restoreSellState, adjustOwnedLocally) {
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`/api/order/${orderId}`);
            const order = await res.json();
            if (order.status === "done") {
                clearInterval(interval);
                toast(`${direction === "buy" ? "Bought" : "Sold"} ${item.name} for ${order.price}p.`, true);
                buyBtn.disabled = false;
                restoreSellState();
                // A rank>0 buy lands in the unique-instance Upgrades
                // collection, not the plain stack /api/owned reads from -
                // don't optimistically bump a count that call can't see.
                if (direction === "sell") adjustOwnedLocally(-1);
                else if (direction === "buy" && rank === 0) adjustOwnedLocally(1);
            } else if (order.status === "failed") {
                clearInterval(interval);
                toast(`${direction === "buy" ? "Buy" : "Sell"} failed for ${item.name}: ${order.detail || "unknown error"}`, false);
                buyBtn.disabled = false;
                restoreSellState();
            }
            // else still pending/processing - keep polling
        } catch (err) {
            clearInterval(interval);
            toast(`Lost track of order for ${item.name}: ${err.message}`, false);
            buyBtn.disabled = false;
            restoreSellState();
        }
    }, 1500);
}

searchEl.addEventListener("input", () => {
    currentPage = 1;
    render();
});

// Rarity (Mods/Arcanes) and relic-era filters only make sense - and are
// only shown - on their one matching tab, never on "All" or each other's
// tab. Switching away resets the hidden filter back to "All" rather than
// leaving an invisible filter still silently applied.
function updateConditionalFilters() {
    const showRarity = typeFilter === "mod" || typeFilter === "arcane";
    rarityFilterEl.hidden = !showRarity;
    if (!showRarity && rarityFilter !== "all") {
        rarityFilter = "all";
        rarityFilterEl.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.rarity === "all"));
    }
    if (showRarity) {
        legendaryBtnEl.textContent = typeFilter === "mod" ? "Primed" : "Legendary";
    }

    const showEra = typeFilter === "relic";
    eraFilterEl.hidden = !showEra;
    if (!showEra && eraFilter !== "all") {
        eraFilter = "all";
        eraFilterEl.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b.dataset.era === "all"));
    }
}

typeFilterEl.addEventListener("click", e => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    typeFilterEl.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b === btn));
    typeFilter = btn.dataset.type;
    currentPage = 1;
    updateConditionalFilters();
    render();
});

sortSelectEl.addEventListener("change", () => {
    sortMode = sortSelectEl.value;
    currentPage = 1;
    render();
});

ownedFilterEl.addEventListener("click", e => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    ownedFilterEl.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b === btn));
    ownedFilter = btn.dataset.owned;
    currentPage = 1;
    render();
});

rarityFilterEl.addEventListener("click", e => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    rarityFilterEl.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b === btn));
    rarityFilter = btn.dataset.rarity;
    currentPage = 1;
    render();
});

eraFilterEl.addEventListener("click", e => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    eraFilterEl.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b === btn));
    eraFilter = btn.dataset.era;
    currentPage = 1;
    render();
});

// Grid vs list is pure CSS on the shared row markup - toggling it never
// needs to re-render/re-fetch prices, just restyle what's already there.
viewToggleEl.addEventListener("click", e => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    viewToggleEl.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b === btn));
    listEl.classList.toggle("grid-view", btn.dataset.view === "grid");
});

prevPageBtn.addEventListener("click", () => {
    currentPage--;
    render();
});

nextPageBtn.addEventListener("click", () => {
    currentPage++;
    render();
});

loadItems();
