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
const rateLimits = new Map<
    string,
    { timestamps: number[]; cooldownUntil?: number }
>();

const RATE_LIMIT_MAX = 5;
const RATE_WINDOW_MS = 10_000;
const COOLDOWN_MS = 60_000;

function validateNickname(value: string): boolean {
    return /^[a-zA-Z0-9_-]{3,24}$/.test(value);
}

function validatePassword(value: string): boolean {
    return value.length >= 6 && value.length <= 72;
}

function validateMessage(value: string): boolean {
    return value.length >= 1 && value.length <= 500;
}

function containsUrl(value: string): boolean {
    return /(https?:\/\/|www\.)\S+/i.test(value) ||
        /\b([a-z0-9-]+\.)+[a-z]{2,}(\/\S*)?/i.test(value);
}

function checkRateLimit(nickname: string, now: number) {
    const entry = rateLimits.get(nickname) || { timestamps: [] };
    const recent = entry.timestamps.filter(
        (timestamp) => now - timestamp < RATE_WINDOW_MS
    );

    if (entry.cooldownUntil && now < entry.cooldownUntil) {
        rateLimits.set(nickname, { ...entry, timestamps: recent });
        const remainingMs = entry.cooldownUntil - now;
        return {
            allowed: false,
            cooldownSeconds: Math.ceil(remainingMs / 1000),
        };
    }

    if (recent.length >= RATE_LIMIT_MAX) {
        const cooldownUntil = now + COOLDOWN_MS;
        rateLimits.set(nickname, { timestamps: recent, cooldownUntil });
        return {
            allowed: false,
            cooldownSeconds: Math.ceil(COOLDOWN_MS / 1000),
        };
    }

    recent.push(now);
    rateLimits.set(nickname, { timestamps: recent });
    return { allowed: true };
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

        const existingUser = await db.get<{ banned: number }>(
            "SELECT banned FROM users WHERE nickname = ?",
            nickname
        );
        if (existingUser?.banned) {
            return res.status(403).json({ error: "this account has been banned" });
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
            banned: number;
        }>(
            "SELECT nickname, password_hash, banned FROM users WHERE nickname = ?",
            nickname
        );

        if (!user) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        if (user.banned) {
            return res.status(403).json({ error: "this account has been banned" });
        }

        const ok = await bcrypt.compare(password, user.password_hash);
        if (!ok) {
            return res.status(401).json({ error: "Invalid credentials" });
        }

        const token = jwt.sign({ nickname }, JWT_SECRET, { expiresIn: "7d" });
        return res.json({ nickname, token });
    });

    app.get("/messages", requireAuth, async (req: AuthedRequest, res: Response) => {
        const nickname = req.user?.nickname || "";
        const user = await db.get<{ banned: number }>(
            "SELECT banned FROM users WHERE nickname = ?",
            nickname
        );
        if (!user) {
            return res.status(401).json({ error: "Invalid token" });
        }
        if (user.banned) {
            return res.status(403).json({ error: "this account has been banned" });
        }

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

    app.get("/messages/stream", async (req: Request, res: Response) => {
        const token = String(req.query?.token || "");
        const nickname = token ? getNicknameFromToken(token) : null;
        if (!nickname) {
            return res.status(401).json({ error: "Invalid token" });
        }

        const user = await db.get<{ banned: number }>(
            "SELECT banned FROM users WHERE nickname = ?",
            nickname
        );
        if (!user) {
            return res.status(401).json({ error: "Invalid token" });
        }
        if (user.banned) {
            return res.status(403).json({ error: "this account has been banned" });
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
        const nickname = req.user?.nickname || "";
        const user = await db.get<{ banned: number }>(
            "SELECT banned FROM users WHERE nickname = ?",
            nickname
        );
        if (!user) {
            return res.status(401).json({ error: "Invalid token" });
        }
        if (user.banned) {
            return res.status(403).json({ error: "this account has been banned" });
        }

        const body = String(req.body?.body || "").trim();
        if (!validateMessage(body)) {
            return res.status(400).json({ error: "Invalid message" });
        }

        if (containsUrl(body)) {
            return res.status(400).json({ error: "Links are not allowed" });
        }

        const now = Date.now();
        const limit = checkRateLimit(nickname, now);
        if (!limit.allowed) {
            const cooldownSeconds = limit.cooldownSeconds || 0;
            return res.status(429).json({
                error: "slow down, don't spam!",
                cooldownSeconds,
                retryAt: new Date(now + cooldownSeconds * 1000).toISOString(),
            });
        }
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

    app.post(
        "/admin/messages/:id/delete",
        requireAdmin,
        async (req: Request, res: Response) => {
            const messageId = Number(req.params.id);
            if (!Number.isFinite(messageId) || messageId <= 0) {
                return res.status(400).json({ error: "Invalid message id" });
            }

            const existing = await db.get("SELECT 1 FROM messages WHERE id = ?", messageId);
            if (!existing) {
                return res.status(404).json({ error: "Message not found" });
            }

            await db.run(
                "UPDATE messages SET body = ? WHERE id = ?",
                "message deleted",
                messageId
            );

            for (const client of streamClients) {
                writeSseEvent(client.res, "delete", { id: messageId });
            }

            return res.json({ ok: true });
        }
    );

    app.post(
        "/admin/messages/:id/warn",
        requireAdmin,
        async (req: Request, res: Response) => {
            const messageId = Number(req.params.id);
            if (!Number.isFinite(messageId) || messageId <= 0) {
                return res.status(400).json({ error: "Invalid message id" });
            }

            const message = await db.get<{ nickname: string }>(
                "SELECT nickname FROM messages WHERE id = ?",
                messageId
            );
            if (!message?.nickname) {
                return res.status(404).json({ error: "Message not found" });
            }

            await db.run(
                "UPDATE messages SET body = ? WHERE id = ?",
                "message deleted",
                messageId
            );

            for (const client of streamClients) {
                writeSseEvent(client.res, "delete", { id: messageId });
                writeSseEvent(client.res, "warn", {
                    nickname: message.nickname,
                    messageId,
                });
            }

            return res.json({ ok: true, nickname: message.nickname });
        }
    );

    app.post(
        "/admin/users/:nickname/ban",
        requireAdmin,
        async (req: Request, res: Response) => {
            const nickname = String(req.params.nickname || "").trim();
            if (!validateNickname(nickname)) {
                return res.status(400).json({ error: "Invalid username" });
            }

            await db.run("UPDATE users SET banned = 1 WHERE nickname = ?", nickname);
            await db.run(
                "UPDATE messages SET body = ? WHERE nickname = ?",
                "message deleted",
                nickname
            );

            const createdAt = new Date().toISOString();
            const logResult = await db.run(
                "INSERT INTO messages (nickname, body, created_at) VALUES (?, ?, ?)",
                "system",
                `user ${nickname} has been banned`,
                createdAt
            );

            await db.run(
                "DELETE FROM messages WHERE id NOT IN (" +
                "SELECT id FROM messages ORDER BY id DESC LIMIT 100" +
                ")"
            );

            for (const client of streamClients) {
                writeSseEvent(client.res, "purge", { nickname });
                writeSseEvent(client.res, "ban", { nickname });
                writeSseEvent(client.res, "message", {
                    id: logResult.lastID,
                    nickname: "system",
                    body: `user ${nickname} has been banned`,
                    created_at: createdAt,
                });
            }

            return res.json({ ok: true });
        }
    );

    app.get(
        "/admin/users/active",
        requireAdmin,
        async (_req: Request, res: Response) => {
            const rows = await db.all<Array<{ nickname: string; created_at: string }>>(
                "SELECT nickname, created_at FROM users WHERE banned = 0 ORDER BY nickname COLLATE NOCASE"
            );
            return res.json({ users: rows });
        }
    );

    app.get(
        "/admin/users/banned",
        requireAdmin,
        async (_req: Request, res: Response) => {
            const rows = await db.all<Array<{ nickname: string; created_at: string }>>(
                "SELECT nickname, created_at FROM users WHERE banned = 1 ORDER BY nickname COLLATE NOCASE"
            );
            return res.json({ users: rows });
        }
    );

    app.post(
        "/admin/users/:nickname/unban",
        requireAdmin,
        async (req: Request, res: Response) => {
            const nickname = String(req.params.nickname || "").trim();
            if (!validateNickname(nickname)) {
                return res.status(400).json({ error: "Invalid username" });
            }

            const user = await db.get<{ banned: number }>(
                "SELECT banned FROM users WHERE nickname = ?",
                nickname
            );
            if (!user) {
                return res.status(404).json({ error: "User not found" });
            }

            await db.run("UPDATE users SET banned = 0 WHERE nickname = ?", nickname);

            const createdAt = new Date().toISOString();
            const logResult = await db.run(
                "INSERT INTO messages (nickname, body, created_at) VALUES (?, ?, ?)",
                "system",
                `user ${nickname} has been unbanned`,
                createdAt
            );

            await db.run(
                "DELETE FROM messages WHERE id NOT IN (" +
                "SELECT id FROM messages ORDER BY id DESC LIMIT 100" +
                ")"
            );

            for (const client of streamClients) {
                writeSseEvent(client.res, "message", {
                    id: logResult.lastID,
                    nickname: "system",
                    body: `user ${nickname} has been unbanned`,
                    created_at: createdAt,
                });
            }

            return res.json({ ok: true });
        }
    );

    app.delete(
        "/admin/users/:nickname",
        requireAdmin,
        async (req: Request, res: Response) => {
            const nickname = String(req.params.nickname || "").trim();
            if (!validateNickname(nickname)) {
                return res.status(400).json({ error: "Invalid username" });
            }

            await db.run("DELETE FROM messages WHERE nickname = ?", nickname);
            await db.run("DELETE FROM users WHERE nickname = ?", nickname);

            for (const client of streamClients) {
                writeSseEvent(client.res, "purge", { nickname });
            }

            return res.json({ ok: true });
        }
    );

    app.listen(PORT, () => {
        console.log(`chat backend listening on ${PORT}`);
    });
}

main().catch((err) => {
    console.error("Failed to start server", err);
    process.exit(1);
});
