import { ObjectId, type Document } from "mongodb";
import { describe, expect, it } from "vitest";
import type { MongoDatabase } from "../../src/infrastructure/mongodb/database.js";
import type { AuthPrincipal } from "../../src/modules/identity/domain/identity.types.js";
import { JobQueryService } from "../../src/modules/operations/application/job-query.service.js";

describe("Ek4 istasyon ve bakım hedefi kuralları", () => {
  it("mevcut cihaz seçildiğinde gönderilen farklı konum yerine cihazın kayıtlı istasyonunu kullanır", async () => {
    const cpo = principal("CPO", "CPO_STAFF");
    let insertedJob: Document | undefined;
    const storedStation = { name: "Kayıtlı İstasyon", city: "İstanbul", district: "Kadıköy" };
    const collections: Record<string, Record<string, unknown>> = {
      counters: { findOneAndUpdate: async () => ({ value: 2601 }) },
      tenants: { find: () => cursor([{ _id: new ObjectId(cpo.tenantId), type: "CPO" }]) },
      chargePoints: { findOne: async () => ({ externalId: "CP-001", station: storedStation }) },
      jobs: { insertOne: async (value: Document) => { insertedJob = value; return { insertedId: value._id }; } },
      jobEvents: { insertOne: async () => ({ insertedId: new ObjectId() }) },
    };
    await new JobQueryService(database(collections)).create(cpo, {
      cpoTenantId: cpo.tenantId, stationName: "Yanlış İstasyon", city: "Ankara", district: "Çankaya",
      maintenanceTarget: "DEVICE", chargerExternalId: "CP-001", givenDurationAt: futureDate(),
    });
    expect(insertedJob?.station).toEqual(storedStation);
    expect(insertedJob?.charger).toEqual({ externalId: "CP-001" });
  });

  it("istasyon bakımını cihaz olmadan ayrı hedef ve alanla kaydeder", async () => {
    const cpo = principal("CPO", "CPO_STAFF");
    let insertedJob: Document | undefined;
    const collections: Record<string, Record<string, unknown>> = {
      counters: { findOneAndUpdate: async () => ({ value: 2602 }) },
      tenants: { find: () => cursor([{ _id: new ObjectId(cpo.tenantId), type: "CPO" }]) },
      jobs: { insertOne: async (value: Document) => { insertedJob = value; return { insertedId: value._id }; } },
      jobEvents: { insertOne: async () => ({ insertedId: new ObjectId() }) },
    };
    await new JobQueryService(database(collections)).create(cpo, {
      cpoTenantId: cpo.tenantId, stationName: "Merkez", city: "Bursa", district: "Nilüfer",
      maintenanceTarget: "STATION", stationMaintenanceArea: "GRID_CONNECTION", givenDurationAt: futureDate(),
    });
    expect(insertedJob).toMatchObject({ maintenanceTarget: "STATION", stationMaintenanceArea: "GRID_CONNECTION", charger: null });
  });

  it("taşeron rolünü istasyon bakım geçmişinden reddeder", async () => {
    const contractor = principal("CONTRACTOR", "CONTRACTOR_STAFF");
    const service = new JobQueryService({ db: async () => { throw new Error("DB çağrılmamalı"); } } as unknown as MongoDatabase);
    await expect(service.listStationMaintenance(contractor, {
      cpoTenantId: new ObjectId().toHexString(), stationName: "Merkez", city: "Bursa", district: "Nilüfer",
    })).rejects.toMatchObject({ code: "STATION_HISTORY_FORBIDDEN" });
  });
});

function principal(tenantType: AuthPrincipal["tenantType"], role: AuthPrincipal["role"]): AuthPrincipal {
  return { userId: new ObjectId().toHexString(), tenantId: new ObjectId().toHexString(), tenantKey: "test", tenantName: "Test", tenantType, name: "Test User", email: "test@example.test", role };
}
function database(collections: Record<string, Record<string, unknown>>): MongoDatabase {
  return { db: async () => ({ collection: (name: string) => collections[name] ?? {} }) } as unknown as MongoDatabase;
}
function cursor(items: Document[]) { return { project() { return this; }, async toArray() { return items; } }; }
function futureDate(): string { return new Date(Date.now() + 7 * 86400000).toISOString(); }
