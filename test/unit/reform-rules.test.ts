import type { Document } from "mongodb";
import { describe, expect, it } from "vitest";
import type { MongoDatabase } from "../../src/infrastructure/mongodb/database.js";
import { ContractorRegistrationService } from "../../src/modules/identity/application/contractor-registration.service.js";
import type { AuthPrincipal } from "../../src/modules/identity/domain/identity.types.js";
import { JobQueryService } from "../../src/modules/operations/application/job-query.service.js";

const principal = (tenantType: AuthPrincipal["tenantType"]): AuthPrincipal => ({
  userId: "000000000000000000000001",
  tenantId: "000000000000000000000002",
  tenantKey: tenantType.toLocaleLowerCase("en-US"),
  tenantName: tenantType,
  tenantType,
  name: "Test User",
  email: "test@bakimnerde.test",
  role: tenantType === "PLATFORM" ? "PLATFORM_STAFF" : tenantType === "CPO" ? "CPO_STAFF" : "CONTRACTOR_STAFF",
});

describe("reform kuralları", () => {
  it("taşeron ekranındaki iş tutarını taşeron maliyetinden üretir", async () => {
    let pipeline: Document[] = [];
    const database = {
      db: async () => ({
        collection: () => ({
          aggregate: (value: Document[]) => {
            pipeline = value;
            return { toArray: async () => [] };
          },
        }),
      }),
    } as unknown as MongoDatabase;

    await new JobQueryService(database).list(principal("CONTRACTOR"));

    const project = pipeline.find((stage) => "$project" in stage)?.$project as Document;
    expect(project.amount).toEqual({
      $cond: [
        { $gt: [{ $ifNull: ["$pricingSnapshot.contractorCost", 0] }, 0] },
        "$pricingSnapshot.contractorCost",
        null,
      ],
    });
  });

  it("saha personeline yalnız kendi kullanıcı kimliğine atanmış işleri listeler", async () => {
    let pipeline: Document[] = [];
    const database = {
      db: async () => ({
        collection: () => ({
          aggregate: (value: Document[]) => {
            pipeline = value;
            return { toArray: async () => [] };
          },
        }),
      }),
    } as unknown as MongoDatabase;
    const fieldPrincipal: AuthPrincipal = {
      ...principal("CONTRACTOR"),
      userId: "000000000000000000000007",
      role: "FIELD_WORKER",
    };

    await new JobQueryService(database).list(fieldPrincipal);

    const match = pipeline[0]?.$match as Document;
    expect(match.contractorTenantId.toHexString()).toBe(fieldPrincipal.tenantId);
    expect(match.fieldWorkerUserId.toHexString()).toBe(fieldPrincipal.userId);
  });

  it("başında sıfır olan telefonu public taşeron başvurusunda reddeder", async () => {
    const database = { db: async () => { throw new Error("Veritabanına ulaşılmamalı."); } } as unknown as MongoDatabase;
    const service = new ContractorRegistrationService(database);

    await expect(service.submit({
      companyName: "Test Teknik",
      taxNumber: "1234567890",
      tradeRegistryNumber: "12345",
      companyEmail: "firma@test.test",
      companyPhone: "0532111222",
      authorizedName: "Test Yetkili",
      authorizedTitle: "Operasyon müdürü",
      authorizedEmail: "yetkili@test.test",
      authorizedPhone: "5321112222",
      password: "Test!2026",
      city: "İstanbul",
      district: "Kadıköy",
      address: "Test adresi",
      serviceRegions: ["İstanbul"],
      specialties: ["ELECTRICAL"],
      availabilityDays: [1, 2, 3],
      agreementAccepted: true,
    })).rejects.toMatchObject({ code: "CONTRACTOR_APPLICATION_INVALID" });
  });
});
