import { describe, expect, it } from "vitest";
import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../src/infrastructure/mongodb/database.js";
import type { AuthPrincipal } from "../../src/modules/identity/domain/identity.types.js";
import { JobCollaborationService } from "../../src/modules/operations/application/job-collaboration.service.js";
import { JobQueryService } from "../../src/modules/operations/application/job-query.service.js";

describe("Ek6 saha, indirme ve ödeme kuralları", () => {
  it("6 bakım öncesi fotoğrafı olmadan bakımı başlatmaz", async () => {
    const field = principal("CONTRACTOR", "FIELD_WORKER");
    const jobId = new ObjectId();
    const database = databaseWithCollections({
      jobs: { findOne: async () => ({
        _id: jobId, status: "ASSIGNED", contractorTenantId: new ObjectId(field.tenantId),
        fieldWorkerUserId: new ObjectId(field.userId), contractorAcceptedAt: new Date(), appointmentAt: new Date(Date.now() - 1000),
        workflowCycle: 1, evidencePolicy: { beforePhotoCount: 6 },
      }) },
      jobMedia: { countDocuments: async () => 5 },
    });
    await expect(new JobQueryService(database).changeStatus(field, { id: jobId.toHexString(), status: "IN_PROGRESS" }))
      .rejects.toMatchObject({ code: "BEFORE_EVIDENCE_INCOMPLETE" });
  });

  it("bakım başlamadan sonra veya markalı fotoğraf yükletmez", async () => {
    const field = principal("CONTRACTOR", "FIELD_WORKER");
    const jobId = new ObjectId();
    const database = databaseWithCollections({
      jobs: { findOne: async () => ({ _id: jobId, status: "ASSIGNED", contractorTenantId: new ObjectId(field.tenantId), fieldWorkerUserId: new ObjectId(field.userId) }) },
    });
    await expect(new JobCollaborationService(database).addEvidence(field, {
      jobId: jobId.toHexString(), phase: "AFTER", contentBase64: "dGVzdA==", mimeType: "image/jpeg", description: "Sonra",
    })).rejects.toMatchObject({ code: "MAINTENANCE_START_REQUIRED" });
  });

  it("indirilebilir tüm saha fotoğraflarını tek ZIP üretir", async () => {
    const platform = principal("PLATFORM", "PLATFORM_STAFF");
    const jobId = new ObjectId();
    const media = [{ _id: new ObjectId(), jobId, cycle: 1, phase: "BEFORE", mimeType: "image/jpeg", contentBase64: "dGVzdA==", fileName: "once.jpg" }];
    const database = databaseWithCollections({
      jobs: { findOne: async () => ({ _id: jobId, jobNumber: "BN-6001", workflowCycle: 1 }) },
      jobMedia: { find: () => ({ sort: () => ({ toArray: async () => media }) }) },
    });
    const file = await new JobCollaborationService(database).downloadAllEvidence(platform, jobId.toHexString());
    expect(file.mimeType).toBe("application/zip");
    expect(file.fileName).toBe("BN-6001-saha-fotograflari.zip");
    expect(file.content.readUInt32LE(0)).toBe(0x04034b50);
  });

  it("CPO ödemesini teknik servis ödemesinden önce kaydeder", async () => {
    const cpo = principal("CPO", "CPO_ADMIN");
    const jobId = new ObjectId();
    const walletId = new ObjectId();
    let jobUpdate: Document | undefined;
    const database = databaseWithCollections({
      jobs: {
        findOne: async () => ({ _id: jobId, jobNumber: "BN-6002", status: "CPO_APPROVAL", cpoTenantId: new ObjectId(cpo.tenantId), pricingSnapshot: { cpoPrice: 12500 } }),
        updateOne: async (_filter: Document, update: Document) => { jobUpdate = update; return { matchedCount: 1 }; },
      },
      wallets: { findOne: async () => ({ _id: walletId, balance: 20000 }), updateOne: async () => ({ matchedCount: 1 }) },
      walletTransactions: { updateOne: async () => ({ upsertedCount: 1 }) },
      jobEvents: { insertOne: async () => ({ insertedId: new ObjectId() }) },
    });
    const result = await new JobQueryService(database).payCpoInvoice(cpo, { id: jobId.toHexString() });
    expect(result.status).toBe("CPO_TO_PLATFORM_PAID");
    expect(jobUpdate?.$set).toMatchObject({ cpoPaymentAmount: 12500 });
    expect(jobUpdate?.$set.cpoToPlatformPaidAt).toBeInstanceOf(Date);
  });
});

function principal(tenantType: AuthPrincipal["tenantType"], role: AuthPrincipal["role"]): AuthPrincipal {
  return { userId: new ObjectId().toHexString(), tenantId: new ObjectId().toHexString(), tenantKey: "test", tenantName: "Test", tenantType, name: "Test", email: "test@example.test", role };
}

function databaseWithCollections(collections: Record<string, Record<string, unknown>>): MongoDatabase {
  return { db: async () => ({ collection: (name: string) => collections[name] ?? {} }) } as unknown as MongoDatabase;
}
