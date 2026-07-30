import { ObjectId, type Document } from "mongodb";
import { describe, expect, it } from "vitest";
import type { MongoDatabase } from "../../src/infrastructure/mongodb/database.js";
import type { AuthPrincipal } from "../../src/modules/identity/domain/identity.types.js";
import { JobCollaborationService } from "../../src/modules/operations/application/job-collaboration.service.js";
import { JobQueryService } from "../../src/modules/operations/application/job-query.service.js";

describe("Ek5 ek tedarik akışı", () => {
  it("saha yönetiminin talebini fiyat olmadan yalnız ilk aşamaya kaydeder", async () => {
    const contractor = principal("CONTRACTOR", "CONTRACTOR_ADMIN");
    const jobId = new ObjectId();
    let inserted: Document | undefined;
    const database = databaseWithCollections({
      jobs: { findOne: async () => ({ _id: jobId, status: "IN_PROGRESS", contractorTenantId: new ObjectId(contractor.tenantId) }) },
      additionalRequests: { insertOne: async (value: Document) => { inserted = value; return { insertedId: new ObjectId() }; } },
    });

    await new JobCollaborationService(database).createRequest(contractor, {
      jobId: jobId.toHexString(), type: "FAN_REPLACEMENT", description: "Fan temini gerekiyor",
    });

    expect(inserted).toMatchObject({
      jobId, type: "FAN_REPLACEMENT", cpoPrice: null,
      status: "PENDING_PRICING", partSupplyStatus: "PENDING_PRICING",
    });
    expect(inserted?.statusHistory).toHaveLength(1);
  });

  it("fiyatlandırmayı Bakımnerde adına kaydedip talebi CPO'ya görünür yapar", async () => {
    const platform = principal("PLATFORM", "PLATFORM_STAFF");
    const jobId = new ObjectId();
    const requestId = new ObjectId();
    let update: Document | undefined;
    const database = databaseWithCollections({
      jobs: { findOne: async () => ({ _id: jobId, cpoTenantId: new ObjectId(), contractorTenantId: new ObjectId() }) },
      additionalRequests: {
        findOne: async () => ({ _id: requestId, jobId, partSupplyStatus: "PENDING_PRICING" }),
        updateOne: async (_filter: Document, value: Document) => { update = value; return { matchedCount: 1 }; },
      },
    });

    const result = await new JobCollaborationService(database).priceRequest(platform, {
      id: requestId.toHexString(), cpoPrice: 12_500,
    });

    expect(result.status).toBe("AWAITING_CPO_DEADLINE");
    expect(update?.$set).toMatchObject({ cpoPrice: 12_500, partSupplyStatus: "AWAITING_CPO_DEADLINE" });
    expect(update?.$set.cpoVisibleAt).toBeInstanceOf(Date);
  });

  it("CPO kesin tarihi verdiğinde bakım işini ek tedarik sürecine alır", async () => {
    const cpo = principal("CPO", "CPO_STAFF");
    const jobId = new ObjectId();
    const requestId = new ObjectId();
    let jobUpdate: Document | undefined;
    const database = databaseWithCollections({
      jobs: {
        findOne: async () => ({ _id: jobId, cpoTenantId: new ObjectId(cpo.tenantId), contractorTenantId: new ObjectId() }),
        updateOne: async (_filter: Document, value: Document) => { jobUpdate = value; return { matchedCount: 1 }; },
      },
      additionalRequests: {
        findOne: async () => ({ _id: requestId, jobId, cpoVisibleAt: new Date(), cpoPrice: 12_500, partSupplyStatus: "AWAITING_CPO_DEADLINE" }),
        updateOne: async () => ({ matchedCount: 1 }),
      },
    });

    await new JobCollaborationService(database).setRequestDeadline(cpo, {
      id: requestId.toHexString(), supplyDeadlineAt: new Date(Date.now() + 86_400_000).toISOString(),
    });

    expect(jobUpdate?.$set).toMatchObject({ status: "ADDITIONAL_SUPPLY" });
  });

  it("aynı manuel tedarik durumunu ikinci kez DB'ye yazmaz", async () => {
    const platform = principal("PLATFORM", "PLATFORM_STAFF");
    const jobId = new ObjectId();
    const requestId = new ObjectId();
    let updateCount = 0;
    const database = databaseWithCollections({
      jobs: { findOne: async () => ({ _id: jobId, cpoTenantId: new ObjectId(), contractorTenantId: new ObjectId() }) },
      additionalRequests: {
        findOne: async () => ({ _id: requestId, jobId, partSupplyStatus: "DELAYED", supplyDeadlineAt: new Date() }),
        updateOne: async () => { updateCount += 1; return { matchedCount: 1 }; },
      },
    });

    const result = await new JobCollaborationService(database).updateRequest(platform, {
      id: requestId.toHexString(), partSupplyStatus: "DELAYED",
    });

    expect(result.unchanged).toBe(true);
    expect(updateCount).toBe(0);
  });

  it("açık ek tedarik varken bakım tamamlandı durumunu reddeder", async () => {
    const field = principal("CONTRACTOR", "FIELD_WORKER");
    const jobId = new ObjectId();
    const database = databaseWithCollections({
      jobs: { findOne: async () => ({
        _id: jobId, status: "IN_PROGRESS", contractorTenantId: new ObjectId(field.tenantId), fieldWorkerUserId: new ObjectId(field.userId), workflowCycle: 1,
      }) },
      additionalRequests: { countDocuments: async () => 1 },
    });

    await expect(new JobQueryService(database).changeStatus(field, {
      id: jobId.toHexString(), status: "MAINTENANCE_DONE",
    })).rejects.toMatchObject({ code: "ADDITIONAL_SUPPLY_PENDING" });
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
