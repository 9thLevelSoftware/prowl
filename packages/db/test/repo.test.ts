import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDb,
  runMigrations,
  enqueue,
  claimTask,
  completeTask,
  failTask,
  ensureApplication,
  transitionApplication,
  InvalidTransitionError,
  savePreferences,
  getPreferences,
  schema,
  type Db,
} from "../src";

let db: Db;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jh-db-"));
  db = openDb(path.join(dir, "t.sqlite"));
  runMigrations(db);
});

describe("queue", () => {
  it("claims by priority, dedups, and retries with backoff", () => {
    enqueue(db, "process_job", { n: 1 }, { priority: 100 });
    enqueue(db, "tailor", { n: 2 }, { priority: 10, dedupKey: "t:1" });
    expect(enqueue(db, "tailor", { n: 3 }, { dedupKey: "t:1" })).toBeNull();

    const first = claimTask(db, "w1")!;
    expect(first.type).toBe("tailor");
    expect(first.attempts).toBe(1);
    failTask(db, first, "boom");
    const retried = db.select().from(schema.queueTasks).all().find((t) => t.id === first.id)!;
    expect(retried.status).toBe("pending");
    expect(new Date(retried.runAfter).getTime()).toBeGreaterThan(Date.now());

    const second = claimTask(db, "w1")!;
    expect(second.type).toBe("process_job");
    completeTask(db, second.id);
    expect(claimTask(db, "w1")).toBeUndefined();
  });

  it("filters by task type", () => {
    enqueue(db, "apply", {});
    expect(claimTask(db, "w", ["tailor"])).toBeUndefined();
    expect(claimTask(db, "w", ["apply"])?.type).toBe("apply");
  });
});

describe("applications", () => {
  it("enforces the state machine and logs events", () => {
    const job = db
      .insert(schema.jobs)
      .values({ sourceType: "greenhouse", externalId: "1", dedupKey: "k", title: "Eng", company: "Co", applyUrl: "https://x", atsType: "greenhouse" })
      .returning()
      .get();
    const app = ensureApplication(db, job.id);
    expect(app.status).toBe("matched");
    expect(ensureApplication(db, job.id).id).toBe(app.id);
    expect(() => transitionApplication(db, app.id, "submitted")).toThrow(InvalidTransitionError);
    transitionApplication(db, app.id, "tailoring");
    transitionApplication(db, app.id, "ready_for_review");
    const events = db.select().from(schema.applicationEvents).all().map((e) => e.type);
    expect(events).toEqual(["created", "status:tailoring", "status:ready_for_review"]);
  });
});

describe("preferences", () => {
  it("merges partial updates over defaults", () => {
    expect(getPreferences(db).dryRun).toBe(true);
    savePreferences(db, { targetTitles: ["PM"], dryRun: false });
    const p = getPreferences(db);
    expect(p.targetTitles).toEqual(["PM"]);
    expect(p.dryRun).toBe(false);
    expect(p.minMatchScore).toBe(65);
  });
});
