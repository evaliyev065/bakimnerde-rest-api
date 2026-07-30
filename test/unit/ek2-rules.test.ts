import { ObjectId, type Document } from "mongodb";
import { describe, expect, it } from "vitest";
import type { MongoDatabase } from "../../src/infrastructure/mongodb/database.js";
import { CommerceService } from "../../src/modules/commerce/application/commerce.service.js";
import type { AuthPrincipal } from "../../src/modules/identity/domain/identity.types.js";
import { JobCollaborationService } from "../../src/modules/operations/application/job-collaboration.service.js";

describe("Ek2 rol ve medya kuralları", () => {
  it("CPO ve taşeron yönetimine yalnız kendi cüzdanını listeler", async () => {
    const captured: Document[][] = [];
    const database = { db: async () => ({ collection: () => ({ aggregate: (pipeline: Document[]) => {
      captured.push(pipeline);
      return { toArray: async () => [] };
    } }) }) } as unknown as MongoDatabase;
    const cpo = principal("CPO", "CPO_ADMIN");
    const service = new CommerceService(database);

    await service.listWallets(cpo);
    await service.listWalletTransactions(cpo);

    expect(captured[0]?.[0]?.$match.tenantId.toHexString()).toBe(cpo.tenantId);
    expect(captured[1]?.[0]?.$match.tenantId.toHexString()).toBe(cpo.tenantId);
  });

  it("CPO hesabını saha iş sohbetinden reddeder", async () => {
    const service = new JobCollaborationService({ db: async () => { throw new Error("DB çağrılmamalı"); } } as unknown as MongoDatabase);
    const cpo = principal("CPO", "CPO_STAFF");
    await expect(service.listMessages(cpo, new ObjectId().toHexString())).rejects.toMatchObject({ code: "JOB_CHAT_CPO_FORBIDDEN" });
    await expect(service.sendMessage(cpo, { jobId: new ObjectId().toHexString(), text: "Test" })).rejects.toMatchObject({ code: "JOB_CHAT_CPO_FORBIDDEN" });
  });

  it("DB fotoğrafını diğer yetkili roller için dosya olarak indirir", async () => {
    const jobId = new ObjectId();
    const evidenceId = new ObjectId();
    const cpo = principal("CPO", "CPO_STAFF");
    const database = { db: async () => ({ collection: (name: string) => name === "jobMedia" ? {
      findOne: async () => ({
        _id: evidenceId, jobId, contentBase64: "dGVzdA==", mimeType: "image/jpeg", fileName: "before.jpg",
      }),
    } : {
      findOne: async () => ({ _id: jobId, cpoTenantId: new ObjectId(cpo.tenantId), contractorTenantId: new ObjectId() }),
    } }) } as unknown as MongoDatabase;

    const file = await new JobCollaborationService(database).downloadEvidence(cpo, evidenceId.toHexString());

    expect(file.mimeType).toBe("image/jpeg");
    expect(file.fileName).toBe("before.jpg");
    expect(file.content.toString("utf8")).toBe("test");
  });
});

function principal(tenantType: AuthPrincipal["tenantType"], role: AuthPrincipal["role"]): AuthPrincipal {
  return {
    userId: new ObjectId().toHexString(), tenantId: new ObjectId().toHexString(), tenantKey: "test",
    tenantName: "Test", tenantType, name: "Test User", email: "test@example.test", role,
  };
}
