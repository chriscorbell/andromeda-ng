import sqlite3 from "sqlite3";
import { open, Database } from "sqlite";

export async function initDb(dbPath: string): Promise<Database> {
    const db = await open({
        filename: dbPath,
        driver: sqlite3.Database,
    });

    await db.exec("PRAGMA journal_mode = WAL;");

    await db.exec(
        "CREATE TABLE IF NOT EXISTS users (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "nickname TEXT NOT NULL UNIQUE," +
        "password_hash TEXT NOT NULL," +
        "created_at TEXT NOT NULL," +
        "banned INTEGER NOT NULL DEFAULT 0" +
        ");"
    );

    const userColumns = await db.all<
        Array<{ name: string }>
    >("PRAGMA table_info(users)");
    const hasBannedColumn = userColumns.some((column) => column.name === "banned");
    if (!hasBannedColumn) {
        await db.exec(
            "ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0"
        );
    }

    await db.exec(
        "CREATE TABLE IF NOT EXISTS messages (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT," +
        "nickname TEXT NOT NULL," +
        "body TEXT NOT NULL," +
        "created_at TEXT NOT NULL" +
        ");"
    );

    return db;
}
