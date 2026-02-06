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
        "created_at TEXT NOT NULL" +
        ");"
    );

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
