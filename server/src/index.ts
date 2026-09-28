import express, { type NextFunction, type Request, type Response } from "express";
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

// Last-resort error handler (must come after the routes). asyncHandler in
// routes.ts forwards rejected async handlers here; express.json() also
// lands here on an unparseable/oversized body. Without it Express 4 hangs
// the request and, for async routes, the process exits.
app.use((err: Error & { status?: number; type?: string }, _req: Request, res: Response, _next: NextFunction) => {
    const status = typeof err.status === "number" && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error("Unhandled request error:", err);
    if (res.headersSent) {
        res.end();
        return;
    }
    res.status(status).json({ error: status >= 500 ? "Internal server error" : err.message });
});

app.listen(PORT, () => {
    console.log(`Market Emulator backend listening on http://127.0.0.1:${PORT}`);
    console.log(`Frontend: http://127.0.0.1:${PORT}/`);
    console.log(`Waiting for My Scripts/Market Sync.pluto to poll /internal/pending-order ...`);
});
