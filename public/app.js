const MAX_VISIBLE_ROWS = 40;

const statusEl = document.getElementById("status");
const searchEl = document.getElementById("search");
const listEl = document.getElementById("mod-list");
const rowTemplate = document.getElementById("mod-row-template");
const toastContainer = document.getElementById("toast-container");

let allMods = [];

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

async function loadMods() {
    setStatus("Loading mods from warframe.market...");
    try {
        const res = await fetch("/api/mods");
        if (!res.ok) throw new Error((await res.json()).error || res.statusText);
        allMods = await res.json();
        setStatus(`${allMods.length} mods loaded.`);
        render();
    } catch (err) {
        setStatus(`Failed to load mods: ${err.message}`);
    }
}

function render() {
    const query = searchEl.value.trim().toLowerCase();
    const matches = query ? allMods.filter(m => m.name.toLowerCase().includes(query)) : allMods;
    listEl.innerHTML = "";
    matches.slice(0, MAX_VISIBLE_ROWS).forEach(mod => renderRow(mod));
    if (matches.length > MAX_VISIBLE_ROWS) {
        setStatus(`${matches.length} matches, showing first ${MAX_VISIBLE_ROWS} - refine your search.`);
    } else if (query) {
        setStatus(`${matches.length} matches.`);
    } else {
        setStatus(`${allMods.length} mods loaded.`);
    }
}

function renderRow(mod) {
    const row = rowTemplate.content.firstElementChild.cloneNode(true);
    const icon = row.querySelector(".mod-icon");
    const name = row.querySelector(".mod-name");
    const price = row.querySelector(".mod-price");
    const buyBtn = row.querySelector(".btn-buy");
    const sellBtn = row.querySelector(".btn-sell");

    if (mod.icon) icon.src = mod.icon;
    icon.alt = mod.name;
    name.textContent = mod.name;

    fetch(`/api/price/${encodeURIComponent(mod.slug)}`)
        .then(res => res.json())
        .then(info => {
            price.textContent = info.platinum != null ? `${info.platinum}p` : "no price";
        })
        .catch(() => {
            price.textContent = "?";
        });

    buyBtn.addEventListener("click", () => placeOrder(mod, "buy", price, buyBtn, sellBtn));
    sellBtn.addEventListener("click", () => {
        if (!confirm(`Sell your copy of "${mod.name}"? This removes it from your inventory.`)) return;
        placeOrder(mod, "sell", price, buyBtn, sellBtn);
    });

    listEl.appendChild(row);
}

async function placeOrder(mod, direction, priceEl, buyBtn, sellBtn) {
    const priceText = priceEl.textContent;
    const platinum = parseInt(priceText, 10);
    if (Number.isNaN(platinum)) {
        toast(`No known price for ${mod.name} yet - try again in a moment.`, false);
        return;
    }
    buyBtn.disabled = true;
    sellBtn.disabled = true;
    try {
        const res = await fetch("/api/order", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ gameRef: mod.gameRef, direction, price: platinum })
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || res.statusText);
        toast(`${direction === "buy" ? "Buying" : "Selling"} ${mod.name}...`, true);
        pollOrder(body.orderId, mod, direction, buyBtn, sellBtn);
    } catch (err) {
        toast(`Order failed: ${err.message}`, false);
        buyBtn.disabled = false;
        sellBtn.disabled = false;
    }
}

function pollOrder(orderId, mod, direction, buyBtn, sellBtn) {
    const interval = setInterval(async () => {
        try {
            const res = await fetch(`/api/order/${orderId}`);
            const order = await res.json();
            if (order.status === "done") {
                clearInterval(interval);
                toast(`${direction === "buy" ? "Bought" : "Sold"} ${mod.name} for ${order.price}p.`, true);
                buyBtn.disabled = false;
                sellBtn.disabled = false;
            } else if (order.status === "failed") {
                clearInterval(interval);
                toast(`${direction === "buy" ? "Buy" : "Sell"} failed for ${mod.name}: ${order.detail || "unknown error"}`, false);
                buyBtn.disabled = false;
                sellBtn.disabled = false;
            }
            // else still pending/processing - keep polling
        } catch (err) {
            clearInterval(interval);
            toast(`Lost track of order for ${mod.name}: ${err.message}`, false);
            buyBtn.disabled = false;
            sellBtn.disabled = false;
        }
    }, 1500);
}

searchEl.addEventListener("input", render);
loadMods();
