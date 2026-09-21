import { describe, expect, it, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  openDb,
  runMigrations,
  ensureApplication,
  transitionApplication,
  recoverInterruptedApplies,
  recoverStaleTasks,
  enqueue,
  claimTask,
  InvalidTransitionError,
  eq,
  schema,
  type Db,
} from "../src";

let db: Db;
let seq = 0;

function seedApplying(opts: { dryRun: boolean }) {
  const externalId = `job-${++seq}-${opts.dryRun}`;
  const job = db
    .insert(schema.jobs)
    .values({
      sourceType: "greenhouse",
      externalId,
      dedupKey: externalId,
      title: "Engineer",
      company: "Co",
      applyUrl: "https://example.com/apply",
      atsType: "greenhouse",
    })
    .returning()
    .get();
  const app = ensureApplication(db, job.id);
  expect(app.status).toBe("matched");
  db.update(schema.applications).set({ dryRun: opts.dryRun }).where(eq(schema.applications.id, app.id)).run();
  transitionApplication(db, app.id, "tailoring");
  transitionApplication(db, app.id, "ready_for_review");
  transitionApplication(db, app.id, "approved", "Approved", { dryRun: opts.dryRun });
  transitionApplication(db, app.id, "applying", "Filling form");
  return app.id;
}

function getApp(id: string) {
  return db.select().from(schema.applications).where(eq(schema.applications.id, id)).get()!;
}

function getEvents(applicationId: string) {
  return db.select().from(schema.applicationEvents).where(eq(schema.applicationEvents.applicationId, applicationId)).all();
}

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "prowl-recovery-"));
  db = openDb(path.join(dir, "t.sqlite"));
  runMigrations(db);
});

describe("dry-run defaults (D-04)", () => {
  it("ensureApplication inserts dryRun true", () => {
    const externalId = `dry-default-${++seq}`;
    const job = db
      .insert(schema.jobs)
      .values({ sourceType: "greenhouse", externalId, dedupKey: externalId, title: "Eng", company: "Co", applyUrl: "https://x", atsType: "greenhouse" })
      .returning()
      .get();
    const app = ensureApplication(db, job.id);
    expect(app.dryRun).toBe(true);
    expect(app.status).toBe("matched");
  });

  it("raw insert without dryRun inherits column default true", () => {
    const externalId = `dry-col-${++seq}`;
    const job = db
      .insert(schema.jobs)
      .values({ sourceType: "greenhouse", externalId, dedupKey: externalId, title: "Eng", company: "Co", applyUrl: "https://x", atsType: "greenhouse" })
      .returning()
      .get();
    const row = db
      .insert(schema.applications)
      .values({ jobId: job.id, status: "matched", atsType: "greenhouse", applyUrl: "https://example.com" })
      .returning()
      .get();
    expect(row.dryRun).toBe(true);
  });
});

describe("crash recovery fail-safe (D-01)", () => {
  it("moves interrupted dry-run apply to needs_input via transitionApplication, never approved", () => {
    const id = seedApplying({ dryRun: true });
    expect(getApp(id).status).toBe("applying");

    const { recovered } = recoverInterruptedApplies(db);
    expect(recovered).toBe(1);

    const after = getApp(id);
    expect(after.status).toBe("needs_input");
    expect(after.needsInputReason).toBeTruthy();

    const events = getEvents(id).map((e) => e.type);
    expect(events).toContain("recovery:interrupted");
    expect(events).toContain("status:needs_input");
    // Seed legitimately approved to reach applying; recovery must not add another approved.
    const statusEvents = events.filter((t) => t.startsWith("status:"));
    expect(statusEvents.at(-1)).toBe("status:needs_input");
    expect(statusEvents.filter((t) => t === "status:approved")).toHaveLength(1);
    expect(getApp(id).status).toBe("needs_input");
  });

  it("moves interrupted real apply to needs_input regardless of dryRun false", () => {
    const id = seedApplying({ dryRun: false });
    expect(getApp(id).dryRun).toBe(false);

    recoverInterruptedApplies(db);

    const after = getApp(id);
    expect(after.status).toBe("needs_input");
    // Recovery must not rewrite the historical dryRun flag either way.
    expect(after.dryRun).toBe(false);
    const recovery = getEvents(id).find((e) => e.type === "recovery:interrupted")!;
    expect(recovery.payload?.dryRun).toBe(false);
    expect(recovery.payload?.policy).toContain("fail-safe");
  });

  it("never uses applying→approved on recovery", () => {
    const dryId = seedApplying({ dryRun: true });
    const realId = seedApplying({ dryRun: false });

    recoverInterruptedApplies(db);

    for (const id of [dryId, realId]) {
      expect(getApp(id).status).toBe("needs_input");
      const statusEvents = getEvents(id)
        .filter((e) => e.type.startsWith("status:"))
        .map((e) => e.type);
      // Seed approved once to reach applying; recovery must end at needs_input, not re-approve.
      expect(statusEvents.at(-1)).toBe("status:needs_input");
      expect(statusEvents.filter((t) => t === "status:approved")).toHaveLength(1);
    }
  });

  it("recovery is a no-op when nothing is applying", () => {
    const externalId = `no-crash-${++seq}`;
    const job = db
      .insert(schema.jobs)
      .values({ sourceType: "greenhouse", externalId, dedupKey: externalId, title: "Eng", company: "Co", applyUrl: "https://x", atsType: "greenhouse" })
      .returning()
      .get();
    const app = ensureApplication(db, job.id);
    expect(recoverInterruptedApplies(db)).toEqual({ recovered: 0 });
    expect(getApp(app.id).status).toBe("matched");
  });

  it("re-approve after recovery is a separate explicit path", () => {
    const id = seedApplying({ dryRun: true });
    recoverInterruptedApplies(db);
    expect(getApp(id).status).toBe("needs_input");

    // needs_input → approved is legal in states.ts but only via approveApplication, not recovery.
    transitionApplication(db, id, "approved", "User re-approves after crash", { dryRun: true });
    expect(getApp(id).status).toBe("approved");
  });

  it("queue recoverStaleTasks does not re-drive an apply that recovery moved off approved", () => {
    const id = seedApplying({ dryRun: false });
    enqueue(db, "apply", { applicationId: id }, { dedupKey: `apply:${id}`, userId: "local" });
    const task = claimTask(db, "crashed-worker", ["apply"])!;
    expect(task.type).toBe("apply");
    db.update(schema.queueTasks).set({ status: "running", lockedBy: "dead", lockedAt: new Date().toISOString() }).run();
    expect(recoverStaleTasks(db, 0)).toBeGreaterThanOrEqual(1);

    recoverInterruptedApplies(db);
    // handleApply refuses unless status === "approved" — recovery left it needs_input
    expect(getApp(id).status).toBe("needs_input");
  });

  it("illegal transitions still throw (state machine intact)", () => {
    const id = seedApplying({ dryRun: true });
    expect(() => transitionApplication(db, id, "matched")).toThrow(InvalidTransitionError);
  });
});
