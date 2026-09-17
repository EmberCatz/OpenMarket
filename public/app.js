const MAX_VISIBLE_ROWS = 40;

// Firing all of a row batch's price lookups at once used to trip
// warframe.market's rate limiting on broad searches (e.g. "meso" ->
// ~40 simultaneous /api/price calls) - stagger them through a small
// concurrency-limited queue instead.
const PRICE_FETCH_CONCURRENCY = 5;
let activePriceFetches = 0;
const priceFetchQueue = [];

function schedulePriceFetch(task) {
    priceFetchQueue.push(task);
    pumpPriceFetchQueue();
}

function pumpPriceFetchQueue() {
    while (activePriceFetches < PRICE_FETCH_CONCURRENCY && priceFetchQueue.length > 0) {
        const task = priceFetchQueue.shift();
        activePriceFetches++;
        task().finally(() => {
            activePriceFetches--;
            pumpPriceFetchQueue();
        });
    }
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// The concurrency cap above shrinks how often a broad search (e.g. "meso",
// ~40 rows) trips warframe.market's rate limiting, but doesn't guarantee
// zero hits on a near-worst-case burst. Retry a couple of times with a
// short backoff before actually giving up and showing "?" - makes a
// transient rate-limit hit self-heal instead of needing the user to
// manually narrow the search to work around it.
async function fetchPriceWithRetry(url, attempt = 0) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if (attempt >= 2) throw new Error(`HTTP ${res.status}`);
    await delay(500 * (attempt + 1));
    return fetchPriceWithRetry(url, attempt + 1);
}

const statusEl = document.getElementById("status");
const searchEl = document.getElementById("search");
const listEl = document.getElementById("mod-list");
const rowTemplate = document.getElementById("mod-row-template");
const toastContainer = document.getElementById("toast-container");

let allItems = [];

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
        setStatus(`${allItems.length} items loaded.`);
        render();
    } catch (err) {
        setStatus(`Failed to load items: ${err.message}`);
    }
}

function render() {
    const query = searchEl.value.trim().toLowerCase();
    const matches = query ? allItems.filter(m => m.name.toLowerCase().includes(query)) : allItems;
    listEl.innerHTML = "";
    matches.slice(0, MAX_VISIBLE_ROWS).forEach(item => renderRow(item));
    if (matches.length > MAX_VISIBLE_ROWS) {
        setStatus(`${matches.length} matches, showing first ${MAX_VISIBLE_ROWS} - refine your search.`);
    } else if (query) {
        setStatus(`${matches.length} matches.`);
    } else {
        setStatus(`${allItems.length} items loaded.`);
    }
}

function renderRow(item) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    const icon = row.querySelector(".mod-icon");
    const name = row.querySelector(".mod-name");
    const price = row.querySelector(".mod-price");
    const buyBtn = row.querySelector(".btn-buy");
    const sellBtn = row.querySelector(".btn-sell");

    if (item.icon) icon.src = item.icon;
    icon.alt = item.name;
    name.textContent = item.name;

    schedulePriceFetch(() =>
        fetchPriceWithRetry(`/api/price/${encodeURIComponent(item.slug)}?subtype=${encodeURIComponent(item.defaultSubtype)}`)
            .then(info => {
                price.textContent = info.platinum != null ? `${info.platinum}p` : "no price";
            })
            .catch(() => {
                price.textContent = "?";
            })
    );

    buyBtn.addEventListener("click", () => placeOrder(item, "buy", price, buyBtn, sellBtn));
    sellBtn.addEventListener("click", () => {
        if (!confirm(`Sell your copy of "${item.name}"? This removes it from your inventory.`)) return;
        placeOrder(item, "sell", price, buyBtn, sellBtn);
    });

    listEl.appendChild(row);
}

async function placeOrder(item, direction, priceEl, buyBtn, sellBtn) {
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
            body: JSON.stringify({ gameRef: item.gameRef, direction, price: platinum })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        toast(`${direction === "buy" ? "Buying" : "Selling"} ${item.name}...`, true);
        pollOrder(body.orderId, item, direction, buyBtn, sellBtn);
    } catch (err) {
        toast(`Order failed: ${err.message}`, false);
        buyBtn.disabled = false;
        sellBtn.disabled = false;
    }
}

function pollOrder(orderId, item, direction, buyBtn, sellBtn) {
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`/api/order/${orderId}`);
            const order = await res.json();
            if (order.status === "done") {
                clearInterval(interval);
                toast(`${direction === "buy" ? "Bought" : "Sold"} ${item.name} for ${order.price}p.`, true);
                buyBtn.disabled = false;
                sellBtn.disabled = false;
            } else if (order.status === "failed") {
                clearInterval(interval);
                toast(`${direction === "buy" ? "Buy" : "Sell"} failed for ${item.name}: ${order.detail || "unknown error"}`, false);
                buyBtn.disabled = false;
                sellBtn.disabled = false;
            }
            // else still pending/processing - keep polling
        } catch (err) {
            clearInterval(interval);
            toast(`Lost track of order for ${item.name}: ${err.message}`, false);
            buyBtn.disabled = false;
            sellBtn.disabled = false;
        }
    }, 1500);
}

searchEl.addEventListener("input", render);
loadItems();
