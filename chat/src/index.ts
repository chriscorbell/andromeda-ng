import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import path from "path";
import fs from "fs/promises";
import { initDb } from "./db";

const PORT = Number(process.env.PORT || 3001);
const JWT_SECRET = process.env.JWT_SECRET || "";
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";
const DB_PATH =
    process.env.DB_PATH ||
    path.resolve(__dirname, "..", "data", "chat.db");

if (!JWT_SECRET) {
    console.error("JWT_SECRET is required");
    process.exit(1);
}

type AuthedRequest = Request & { user?: { nickname: string } };
type StreamClient = {
    res: Response;
};

const streamClients = new Set<StreamClient>();
let heartbeatTimer: NodeJS.Timeout | null = null;

function validateNickname(value: string): boolean {
    return /^[a-zA-Z0-9_-]{3,24}$/.test(value);
}

function validatePassword(value: string): boolean {
    return value.length >= 6 && value.length <= 72;
}

function validateMessage(value: string): boolean {
    return value.length >= 1 && value.length <= 500;
}

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction) {
    const header = req.header("authorization") || "";
    const match = header.match(/^Bearer (.+)$/);
    if (!match) {
        return res.status(401).json({ error: "Missing auth token" });
    }

    try {
        const payload = jwt.verify(match[1], JWT_SECRET) as { nickname?: string };
        if (!payload.nickname) {
            return res.status(401).json({ error: "Invalid token" });
        }

        req.user = { nickname: payload.nickname };
        return next();
    } catch (err) {
        return res.status(401).json({ error: "Invalid token" });
    }
}

function requireAdmin(req: Request, res: Response, next: NextFunction) {
    const token = req.header("x-admin-token") || "";
    if (!ADMIN_TOKEN || token !== ADMIN_TOKEN) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    return next();
}

function getNicknameFromToken(token: string): string | null {
    try {
        const payload = jwt.verify(token, JWT_SECRET) as { nickname?: string };
        return payload.nickname || null;
    } catch (err) {
        return null;
    }
}

function writeSseEvent(res: Response, event: string, data: unknown) {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function startHeartbeat() {
    if (heartbeatTimer) {
        return;
    }

    heartbeatTimer = setInterval(() => {
        for (const client of streamClients) {
            client.res.write(": heartbeat\n\n");
        }
    }, 25000);
}

async function main() {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    const db = await initDb(DB_PATH);

    const app = express();
    app.use(
        cors({
            origin: CORS_ORIGIN === "*" ? true : CORS_ORIGIN,
            credentials: true,
        })
    );
    app.use(express.json({ limit: "8kb" }));

    app.get("/health", (_req: Request, res: Response) => {
        res.json({ ok: true });
    });

    app.post("/auth/register", async (req: Request, res: Response) => {
        const nickname = String(req.body?.nickname || "").trim();
        const password = String(req.body?.password || "");

        if (!validateNickname(nickname)) {
            return res.status(400).json({ error: "Invalid username" });
        }
        if (!validatePassword(password)) {
            return res.status(400).json({ error: "Invalid password" });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const createdAt = new Date().toISOString();

        try {
            await db.run(
                "INSERT INTO users (nickname, password_hash, created_at) VALUES (?, ?, ?)",
                nickname,
                passwordHash,
                createdAt
            );
        } catch (err: any) {
            if (String(err?.code) === "SQLITE_CONSTRAINT") {
                return res.status(409).json({ error: "Username already exists" });
            }
            return res.status(500).json({ error: "Failed to register" });
        }

        const token = jwt.sign({ nickname }, JWT_SECRET, { expiresIn: "7d" });
        return res.status(201).json({ nickname, token });
    });

    app.post("/auth/login", async (req: Request, res: Response) => {
        const nickname = String(req.body?.nickname || "").trim();
        const password = String(req.body?.password || "");

        if (!validateNickname(nickname) || !validatePassword(password)) {
            return res.status(400).json({ error: "Invalid credentials" });
        }

        const user = await db.get<{
            nickname: string;
            password_hash: string;
        }>("SELECT nickname, password_hash FROM users WHERE nickname = ?", nickname);

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign({ nickname }, JWT_SECRET, { expiresIn: "7d" });
        return res.json({ nickname, token });
    });

    app.get("/messages", requireAuth, async (_req: AuthedRequest, res: Response) => {
        const rows = await db.all<
            Array<{
                id: number;
                nickname: string;
                body: string;
                created_at: string;
            }>
        >(
            "SELECT id, nickname, body, created_at FROM messages ORDER BY id DESC LIMIT 100"
        );
        const messages = rows.slice().reverse();

        return res.json({ messages });
    });

    app.get("/messages/public", async (_req: Request, res: Response) => {
        const rows = await db.all<
            Array<{
                id: number;
                nickname: string;
                body: string;
                created_at: string;
            }>
        >(
            "SELECT id, nickname, body, created_at FROM messages ORDER BY id DESC LIMIT 100"
        );
        const messages = rows.slice().reverse();

        return res.json({ messages });
    });

    app.get("/messages/stream", (req: Request, res: Response) => {
        const token = String(req.query?.token || "");
        const nickname = token ? getNicknameFromToken(token) : null;
        if (!nickname) {
            return res.status(401).json({ error: "Invalid token" });
        }

        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        res.write("retry: 5000\n\n");
        writeSseEvent(res, "ready", { ok: true });

        const client: StreamClient = { res };
        streamClients.add(client);
        startHeartbeat();

        req.on("close", () => {
            streamClients.delete(client);
            if (streamClients.size === 0 && heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
        });

        return undefined;
    });

    app.get("/messages/public/stream", (_req: Request, res: Response) => {
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();

        res.write("retry: 5000\n\n");
        writeSseEvent(res, "ready", { ok: true });

        const client: StreamClient = { res };
        streamClients.add(client);
        startHeartbeat();

        _req.on("close", () => {
            streamClients.delete(client);
            if (streamClients.size === 0 && heartbeatTimer) {
                clearInterval(heartbeatTimer);
                heartbeatTimer = null;
            }
        });

        return undefined;
    });

    app.post("/messages", requireAuth, async (req: AuthedRequest, res: Response) => {
        const body = String(req.body?.body || "").trim();
        if (!validateMessage(body)) {
            return res.status(400).json({ error: "Invalid message" });
        }

        const nickname = req.user?.nickname || "";
        const createdAt = new Date().toISOString();

        const result = await db.run(
            "INSERT INTO messages (nickname, body, created_at) VALUES (?, ?, ?)",
            nickname,
            body,
            createdAt
        );

        await db.run(
            "DELETE FROM messages WHERE id NOT IN (" +
            "SELECT id FROM messages ORDER BY id DESC LIMIT 100" +
            ")"
        );

        const message = {
            id: result.lastID,
            nickname,
            body,
            created_at: createdAt,
        };

        for (const client of streamClients) {
            writeSseEvent(client.res, "message", message);
        }

        return res.status(201).json({ message });
    });

    app.post("/admin/clear", requireAdmin, async (_req: Request, res: Response) => {
        await db.run("DELETE FROM messages");

        for (const client of streamClients) {
            writeSseEvent(client.res, "clear", { ok: true });
        }

        return res.json({ ok: true });
    });

    app.listen(PORT, () => {
        console.log(`chat backend listening on ${PORT}`);
    });
}

main().catch((err) => {
    console.error("Failed to start server", err);
    process.exit(1);
});
