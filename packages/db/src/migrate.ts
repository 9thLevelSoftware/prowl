import { runMigrations, dbFilePath, getDb } from "./client";

runMigrations(getDb());
console.log(`Database migrated: ${dbFilePath()}`);
