import { ObjectId, type Document } from "mongodb";
import { describe, expect, it } from "vitest";
import type { MongoDatabase } from "../../src/infrastructure/mongodb/database.js";
import type { AuthPrincipal } from "../../src/modules/identity/domain/identity.types.js";
import { JobCollaborationService } from "../../src/modules/operations/application/job-collaboration.service.js";
import { JobQueryService } from "../../src/modules/operations/application/job-query.service.js";

const platform = principal("PLATFORM", "PLATFORM_STAFF");

describe("Ek1 iş kuralları", () => {
  it("bakım tamamlandıktan sonra saha personeli değişikliğini reddeder", async () => {
    const database = databaseWithCollections({
      jobs: { findOne: async () => ({ status: "MAINTENANCE_DONE" }) },
    });
    await expect(new JobQueryService(database).assignFieldWorker(platform, {
      id: new ObjectId().toHexString(), fieldWorkerUserId: new ObjectId().toHexString(),
    })).rejects.toMatchObject({ code: "FIELD_WORKER_ASSIGNMENT_LOCKED" });
  });

  it("ek tedarik fiyatını CPO yanıtından gizleyip platforma gösterir", async () => {
    const jobId = new ObjectId();
    const cpoId = new ObjectId();
    const requestId = new ObjectId();
    const job = { _id: jobId, cpoTenantId: cpoId, contractorTenantId: new ObjectId() };
    const request = { _id: requestId, jobId, type: "FAN_REPLACEMENT", laborPrice: 8000, pricingRuleId: new ObjectId() };
    const database = databaseWithCollections({
      jobs: { findOne: async () => job },
      additionalRequests: { find: () => cursor([request]) },
    });
    const service = new JobCollaborationService(database);
    const cpoItems = await service.listRequests({ ...principal("CPO", "CPO_STAFF"), tenantId: cpoId.toHexString() }, jobId.toHexString());
    const platformItems = await service.listRequests(platform, jobId.toHexString());
    expect(cpoItems[0]).not.toHaveProperty("laborPrice");
    expect(platformItems[0]).toMatchObject({ laborPrice: 8000 });
  });

  it("mobil fotoğraf içeriğini metadata ile DB belgesine yazar", async () => {
    const jobId = new ObjectId();
    const tenantId = new ObjectId();
    const userId = new ObjectId();
    let inserted: Document | undefined;
    const database = databaseWithCollections({
      jobs: { findOne: async () => ({ _id: jobId, contractorTenantId: tenantId, fieldWorkerUserId: userId, workflowCycle: 1, status: "ASSIGNED" }) },
      jobMedia: {
        findOne: async () => null,
        countDocuments: async () => 0,
        insertOne: async (document: Document) => { inserted = document; return { insertedId: new ObjectId() }; },
      },
    });
    const field = { ...principal("CONTRACTOR", "FIELD_WORKER"), tenantId: tenantId.toHexString(), userId: userId.toHexString() };
    await new JobCollaborationService(database).addEvidence(field, {
      jobId: jobId.toHexString(), phase: "BEFORE", contentBase64: "dGVzdA==",
      mimeType: "image/jpeg", fileName: "before.jpg", description: "Test", clientOperationId: "offline-photo-1",
    });
    expect(inserted).toMatchObject({ contentBase64: "dGVzdA==", mimeType: "image/jpeg", fileName: "before.jpg" });
    expect(inserted).not.toHaveProperty("url");
  });
});

function principal(tenantType: AuthPrincipal["tenantType"], role: AuthPrincipal["role"]): AuthPrincipal {
  return {
    userId: new ObjectId().toHexString(), tenantId: new ObjectId().toHexString(), tenantKey: "test",
    tenantName: "Test", tenantType, name: "Test User", email: "test@example.test", role,
  };
}

function databaseWithCollections(collections: Record<string, Record<string, unknown>>): MongoDatabase {
  return { db: async () => ({ collection: (name: string) => collections[name] ?? {} }) } as unknown as MongoDatabase;
}

function cursor(items: Document[]) {
  let values = items;
  return {
    sort() { return this; },
    map(mapper: (item: Document) => Document) { values = values.map(mapper); return this; },
    async toArray() { return values; },
  };
}
