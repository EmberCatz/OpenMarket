import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { apiRouter, internalRouter } from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.MARKET_EMULATOR_PORT ? Number(process.env.MARKET_EMULATOR_PORT) : 7890;

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "../../public")));
app.use("/icon-cache", express.static(path.join(__dirname, "../icon-cache")));
app.use("/api", apiRouter);
app.use("/internal", internalRouter);

app.listen(PORT, () => {
    console.log(`Market Emulator backend listening on http://127.0.0.1:${PORT}`);
    console.log(`Frontend: http://127.0.0.1:${PORT}/`);
    console.log(`Waiting for My Scripts/Market Sync.pluto to poll /internal/pending-order ...`);
});
