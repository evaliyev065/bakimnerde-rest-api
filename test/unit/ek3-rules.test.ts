import { ObjectId, type Document } from "mongodb";
import { describe, expect, it } from "vitest";
import type { MongoDatabase } from "../../src/infrastructure/mongodb/database.js";
import type { AuthPrincipal } from "../../src/modules/identity/domain/identity.types.js";
import { JobCollaborationService } from "../../src/modules/operations/application/job-collaboration.service.js";
import { JobQueryService } from "../../src/modules/operations/application/job-query.service.js";
import { NotificationService } from "../../src/modules/operations/application/notification.service.js";

describe("Ek3 bildirim ve cihaz kuralları", () => {
  it("iş mesajından ilgili kullanıcılar için kalıcı okunmamış bildirim üretir", async () => {
    const sender = principal("PLATFORM", "PLATFORM_STAFF");
    const jobId = new ObjectId();
    const recipientId = new ObjectId();
    const messageId = new ObjectId();
    const platformTenantId = new ObjectId(sender.tenantId);
    let insertedNotifications: Document[] = [];
    const collections: Record<string, unknown> = {
      jobs: { findOne: async () => ({ _id: jobId, jobNumber: "XYZ-101", cpoTenantId: new ObjectId(), contractorTenantId: new ObjectId(), fieldWorkerUserId: new ObjectId() }) },
      messages: { insertOne: async () => ({ insertedId: messageId }) },
      tenants: { find: () => cursor([{ _id: platformTenantId }]) },
      users: { find: () => cursor([{ _id: recipientId }]) },
      notifications: { insertMany: async (items: Document[]) => { insertedNotifications = items; return { insertedCount: items.length }; } },
    };
    const database = { db: async () => ({ collection: (name: string) => collections[name] }) } as unknown as MongoDatabase;

    await new JobCollaborationService(database).sendMessage(sender, { jobId: jobId.toHexString(), text: "Yeni saha mesajı" });

    expect(insertedNotifications).toHaveLength(1);
    expect(insertedNotifications[0]).toMatchObject({
      recipientUserId: recipientId,
      jobId,
      jobNumber: "XYZ-101",
      body: "XYZ-101 kodlu iş ile ilgili yeni mesajınız var.",
      readAt: null,
    });
  });

  it("bildirimi yalnız alıcı kullanıcı adına okundu işaretler", async () => {
    const user = principal("CONTRACTOR", "FIELD_WORKER");
    const notificationId = new ObjectId();
    let filter: Document = {};
    const database = { db: async () => ({ collection: () => ({
      updateOne: async (value: Document) => { filter = value; return { matchedCount: 1 }; },
    }) }) } as unknown as MongoDatabase;

    await new NotificationService(database).markRead(user, { id: notificationId.toHexString() });

    expect(filter._id).toEqual(notificationId);
    expect(filter.recipientUserId.toHexString()).toBe(user.userId);
  });

  it("taşeron rolünü cihaz bakım geçmişinden reddeder", async () => {
    const contractor = principal("CONTRACTOR", "CONTRACTOR_STAFF");
    const service = new JobQueryService({ db: async () => { throw new Error("DB çağrılmamalı"); } } as unknown as MongoDatabase);
    await expect(service.listChargePointMaintenance(contractor, {
      cpoTenantId: new ObjectId().toHexString(), externalId: "CP-001",
    })).rejects.toMatchObject({ code: "CHARGE_POINT_HISTORY_FORBIDDEN" });
  });
});

function principal(tenantType: AuthPrincipal["tenantType"], role: AuthPrincipal["role"]): AuthPrincipal {
  return {
    userId: new ObjectId().toHexString(), tenantId: new ObjectId().toHexString(), tenantKey: "test",
    tenantName: "Test", tenantType, name: "Test User", email: "test@example.test", role,
  };
}

function cursor(items: Document[]) {
  return {
    project() { return this; },
    async toArray() { return items; },
  };
}
