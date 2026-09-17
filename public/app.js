const ITEMS_PER_PAGE = 40;

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
        task().finally(() => {
            activeFetches--;
            pumpFetchQueue();
        });
    }
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
const searchEl = document.getElementById("search");
const listEl = document.getElementById("mod-list");
const rowTemplate = document.getElementById("mod-row-template");
const toastContainer = document.getElementById("toast-container");
const typeFilterEl = document.getElementById("type-filter");
const viewToggleEl = document.getElementById("view-toggle");
const prevPageBtn = document.getElementById("prev-page");
const nextPageBtn = document.getElementById("next-page");
const pageIndicatorEl = document.getElementById("page-indicator");

let allItems = [];
let typeFilter = "all";
let currentPage = 1;

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

async function loadItems() {
    setStatus("Loading items from warframe.market...");
    try {
        const res = await fetch("/api/items");
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        allItems = await res.json();
        render();
    } catch (err) {
        setStatus(`Failed to load items: ${err.message}`);
    }
}

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
        return true;
    });
}

// Collapse a Prime set's 4 individual part rows into their owning set row
// (one top-level row instead of 5) whenever the set itself is also present
// in the current filtered results - expanding it always shows the real 4
// parts (resolved fresh from allItems by gameRef, not re-filtered), so
// toggling it open never depends on what search text got you there. A part
// whose set ISN'T in the current results (e.g. searching "chassis" matches
// every frame's Chassis Blueprint by name but no set name contains
// "chassis") has nothing to nest under, so it stays a normal flat row -
// deliberate fallback rather than hiding it.
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
            const children = item.parts.map(p => byGameRef.get(p.gameRef)).filter(Boolean);
            rows.push({ item, children });
        } else {
            rows.push({ item, children: null });
        }
    }
    return rows;
}

function render() {
    const matches = getFilteredItems();
    const rows = buildDisplayRows(matches);
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
// collapse/expand toggle for its 4 real parts, rendered as ordinary
// nested rows via the same renderRow() every other item uses.
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
            label.textContent = `Rank ${rank}${rank === item.maxRank ? " (Max)" : ""} — Owned: ${count}`;

            const sellBtn = document.createElement("button");
            sellBtn.className = "btn btn-sell";
            sellBtn.textContent = "Sell";
            sellBtn.addEventListener("click", () => sellOneAtRank(rank, sellBtn));

            line.appendChild(label);
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
            pollRankedSell(body.orderId, rank, btnEl, refresh);
        } catch (err) {
            toast(`Order failed: ${err.message}`, false);
            btnEl.disabled = false;
        }
    }

    refresh();
}

function pollRankedSell(orderId, rank, btnEl, onSettled) {
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`/api/order/${orderId}`);
            const order = await res.json();
            if (order.status === "done") {
                clearInterval(interval);
                toast(`Sold rank ${rank} copy for ${order.price}p.`, true);
                onSettled(); // re-fetches the breakdown, rebuilding the list with a fresh (enabled) button
            } else if (order.status === "failed") {
                clearInterval(interval);
                toast(`Sell failed: ${order.detail || "unknown error"}`, false);
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

// Small bottom-right badge on a Prime part's icon showing which of the 4
// fixed Warframe slots it is (item.slot, set server-side in itemsCache.ts
// from the part's gameRef - "Blueprint"/"HelmetBlueprint"/"ChassisBlueprint"/
// "SystemsBlueprint" suffixes, verified uniform across all 50 sets). Hand-
// drawn glyphs, not real game assets - the actual slot icon textures aren't
// exposed in the local Public Export data (they're packed game textures).
// Paths deliberately avoid fine detail since they render at ~10-12px.
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
        '<rect x="10" y="10" width="4" height="4" fill="var(--bg)"/>'
};

const SLOT_LABELS = {
    blueprint: "Blueprint",
    helmet: "Neuroptics",
    chassis: "Chassis",
    systems: "Systems"
};

function applySlotBadge(row, item) {
    const badge = row.querySelector(".slot-badge");
    if (!item.slot || !SLOT_ICONS[item.slot]) {
        badge.hidden = true;
        return;
    }
    badge.hidden = false;
    badge.title = SLOT_LABELS[item.slot];
    badge.innerHTML = `<svg viewBox="0 0 24 24">${SLOT_ICONS[item.slot]}</svg>`;
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

    if (item.icon) icon.src = item.icon;
    icon.alt = item.name;
    name.textContent = item.name;
    applySlotBadge(row, item);

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
        scheduleFetch(() =>
            fetchJsonWithRetry(
                `/api/price/${encodeURIComponent(item.slug)}?subtype=${encodeURIComponent(currentSubtype())}&rank=${selectedRank}`
            )
                .then(info => {
                    price.textContent = info.platinum != null ? `${info.platinum}p` : "no price";
                })
                .catch(() => {
                    price.textContent = "?";
                })
        );
    }

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

    // A Prime set has no single "owned" count (buying one grants 4
    // different real parts, never the set's own path) and its Sell slot
    // is repurposed as the parts-dropdown toggle anyway - skip entirely.
    function fetchOwned() {
        if (item.type === "prime_set") return;
        ownedEl.hidden = false;
        ownedEl.textContent = "Owned: …";
        ownedEl.classList.remove("none");
        scheduleFetch(() =>
            fetchJsonWithRetry(`/api/owned/${encodeURIComponent(item.slug)}?refinement=${encodeURIComponent(currentSubtype())}`)
                .then(info => {
                    ownedKnown = info.known;
                    ownedCount = info.known ? info.owned : null;
                    ownedEl.textContent = info.known ? `Owned: ${info.owned}` : "Owned: ?";
                    ownedEl.classList.toggle("none", info.known && info.owned === 0);
                    updateSellAvailability();
                })
                .catch(() => {
                    ownedEl.textContent = "Owned: ?";
                    ownedEl.classList.remove("none");
                })
        );
    }

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

typeFilterEl.addEventListener("click", e => {
    const btn = e.target.closest(".filter-btn");
    if (!btn) return;
    typeFilterEl.querySelectorAll(".filter-btn").forEach(b => b.classList.toggle("active", b === btn));
    typeFilter = btn.dataset.type;
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
