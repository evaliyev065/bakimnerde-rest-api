import type { NextFunction, Request, Response } from "express";
import { ObjectId, type Document } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../../src/config/env.js";
import type { MongoDatabase } from "../../src/infrastructure/mongodb/database.js";
import { CommerceService } from "../../src/modules/commerce/application/commerce.service.js";
import type { AuthPrincipal } from "../../src/modules/identity/domain/identity.types.js";
import { createToken } from "../../src/modules/identity/infrastructure/token.js";
import { authenticate } from "../../src/modules/identity/presentation/auth.middleware.js";
import { JobCollaborationService } from "../../src/modules/operations/application/job-collaboration.service.js";
import { JobQueryService } from "../../src/modules/operations/application/job-query.service.js";

describe("Ek7 iş, varlık ve süre kuralları", () => {
  it("işi yalnız CPO oluşturur; yorum ve verilen sürenin %75'i saklanır, cihaz modeli saklanmaz", async () => {
    const cpo = principal("CPO", "CPO_ADMIN");
    const stationId = new ObjectId();
    let insertedJob: Document | undefined;
    const collections: Collections = {
      counters: { findOneAndUpdate: async () => ({ value: 2701 }) },
      tenants: { find: () => cursor([{ _id: new ObjectId(cpo.tenantId), type: "CPO" }]) },
      chargePoints: { findOne: async () => ({
        externalId: "CP-007", stationId, station: { name: "Merkez", city: "İstanbul", district: "Kadıköy" },
      }) },
      jobs: { insertOne: async (value: Document) => { insertedJob = value; return { insertedId: value._id }; } },
      jobEvents: { insertOne: async () => ({ insertedId: new ObjectId() }) },
    };
    const givenDurationAt = new Date(Date.now() + 8 * 86400000).toISOString();
    await new JobQueryService(database(collections)).create(cpo, {
      cpoTenantId: cpo.tenantId, stationName: "istemci konumu", city: "Ankara", district: "Çankaya",
      maintenanceTarget: "DEVICE", chargerExternalId: "cp-007", givenDurationAt,
      appointmentAt: new Date(Date.now() + 2 * 86400000).toISOString(), comment: "Manuel iş yorumu",
    });

    expect(insertedJob?.charger).toEqual({ externalId: "CP-007" });
    expect(insertedJob).not.toHaveProperty("publishDeadlineAt");
    expect(insertedJob?.comment).toBe("Manuel iş yorumu");
    expect(insertedJob?.stationId).toEqual(stationId);
    const fullWindow = (insertedJob?.givenDurationAt as Date).getTime() - (insertedJob?.publishedAt as Date).getTime();
    const contractorWindow = (insertedJob?.contractorGivenDurationAt as Date).getTime() - (insertedJob?.publishedAt as Date).getTime();
    expect(contractorWindow / fullWindow).toBeCloseTo(0.75, 5);

    const platform = principal("PLATFORM", "PLATFORM_STAFF");
    await expect(new JobQueryService(database({})).create(platform, {
      cpoTenantId: cpo.tenantId, stationName: "Merkez", city: "İstanbul", district: "Kadıköy",
      maintenanceTarget: "STATION", stationMaintenanceArea: "GENERAL_COMPONENTS", givenDurationAt,
    })).rejects.toMatchObject({ code: "JOB_CREATE_CPO_REQUIRED" });
  });

  it("teknik servis projeksiyonunda yalnız kısaltılmış süreyi gösterir ve randevuyu bu süreyle sınırlar", async () => {
    const contractor = principal("CONTRACTOR", "CONTRACTOR_ADMIN");
    let pipeline: Document[] = [];
    const listDatabase = database({
      jobs: { aggregate: (value: Document[]) => { pipeline = value; return cursor([]); } },
    });
    await new JobQueryService(listDatabase).list(contractor);
    const project = pipeline.find((stage) => "$project" in stage)?.$project as Document;
    expect(project.givenDurationAt).toEqual({ $ifNull: ["$contractorGivenDurationAt", "$givenDurationAt"] });
    expect(project).not.toHaveProperty("contractorGivenDurationAt");
    expect(project).not.toHaveProperty("cpoReview");

    const jobId = new ObjectId();
    const job = {
      _id: jobId, status: "ASSIGNED", contractorTenantId: new ObjectId(contractor.tenantId),
      cpoTenantId: new ObjectId(), givenDurationAt: new Date(Date.now() + 8 * 86400000),
      contractorGivenDurationAt: new Date(Date.now() + 6 * 86400000),
    };
    const appointmentDatabase = database({
      jobs: { findOne: async () => job, updateOne: async () => ({ matchedCount: 1 }) },
      jobEvents: { insertOne: async () => ({ insertedId: new ObjectId() }) },
    });
    await expect(new JobQueryService(appointmentDatabase).updateAppointment(contractor, {
      id: jobId.toHexString(), appointmentAt: new Date(Date.now() + 7 * 86400000).toISOString(),
    })).rejects.toMatchObject({ code: "APPOINTMENT_AFTER_GIVEN_DURATION" });
  });

  it("atamada teknik servisin istasyon şehrine hizmet vermesini zorunlu tutar", async () => {
    const platform = principal("PLATFORM", "PLATFORM_STAFF");
    const jobId = new ObjectId();
    const contractorId = new ObjectId();
    let serviceRegions = ["Ankara"];
    let jobUpdate: Document | undefined;
    const collections: Collections = {
      jobs: {
        findOne: async () => ({
          _id: jobId, status: "WAITING", station: { city: "İstanbul" },
          contractorGivenDurationAt: new Date(Date.now() + 6 * 86400000),
        }),
        updateOne: async (_filter: Document, update: Document) => { jobUpdate = update; return { matchedCount: 1 }; },
      },
      tenants: { findOne: async () => ({ _id: contractorId, type: "CONTRACTOR", status: "ACTIVE", name: "Teknik" }) },
      contractorProfiles: { findOne: async () => ({ tenantId: contractorId, serviceRegions }) },
      jobEvents: { insertOne: async () => ({ insertedId: new ObjectId() }) },
    };
    const service = new JobQueryService(database(collections));
    const input = {
      id: jobId.toHexString(), contractorTenantId: contractorId.toHexString(),
      appointmentAt: new Date(Date.now() + 2 * 86400000).toISOString(), cpoPrice: 15000, contractorCost: 9000,
    };
    await expect(service.assignContractor(platform, input)).rejects.toMatchObject({ code: "CONTRACTOR_REGION_UNSUPPORTED" });
    serviceRegions = ["İstanbul"];
    await service.assignContractor(platform, input);
    expect(jobUpdate?.$set).toMatchObject({ contractorTenantId: contractorId, status: "ASSIGNED" });
    expect(jobUpdate?.$set.pricingSnapshot).toEqual({ cpoPrice: 15000, contractorCost: 9000, currency: "TRY" });
  });

  it("düzenlenen işte atanmış teknik servisin yeni istasyon bölgesini de doğrular", async () => {
    const platform = principal("PLATFORM", "PLATFORM_STAFF");
    const cpoId = new ObjectId();
    const contractorId = new ObjectId();
    const jobId = new ObjectId();
    const service = new JobQueryService(database({
      jobs: { findOne: async () => ({ _id: jobId, status: "ASSIGNED", contractorTenantId: contractorId }) },
      tenants: { find: () => cursor([
        { _id: cpoId, type: "CPO" },
        { _id: contractorId, type: "CONTRACTOR" },
      ]) },
      contractorProfiles: { findOne: async () => ({ tenantId: contractorId, serviceRegions: ["İstanbul"] }) },
    }));

    await expect(service.update(platform, {
      id: jobId.toHexString(), cpoTenantId: cpoId.toHexString(), stationName: "Başkent", city: "Ankara", district: "Çankaya",
      maintenanceTarget: "STATION", stationMaintenanceArea: "GENERAL_COMPONENTS",
      appointmentAt: new Date(Date.now() + 86400000).toISOString(), comment: "Konum değişikliği",
    })).rejects.toMatchObject({ code: "CONTRACTOR_REGION_UNSUPPORTED" });
  });

  it("istasyon ve cihazı yalnız yetkili firma için ekler, cihaz modelini kabul etmez", async () => {
    const cpo = principal("CPO", "CPO_ADMIN");
    const stationId = new ObjectId();
    let stationInsert: Document | undefined;
    let chargePointInsert: Document | undefined;
    const collections: Collections = {
      tenants: { findOne: async () => ({ _id: new ObjectId(cpo.tenantId), type: "CPO", status: "ACTIVE" }) },
      stations: {
        insertOne: async (value: Document) => { stationInsert = value; return { insertedId: stationId }; },
        findOne: async () => ({
          _id: stationId, cpoTenantId: new ObjectId(cpo.tenantId), name: "Merkez", city: "İstanbul", district: "Kadıköy",
        }),
      },
      chargePoints: { insertOne: async (value: Document) => { chargePointInsert = value; return { insertedId: new ObjectId() }; } },
    };
    const service = new JobQueryService(database(collections));
    await service.createStation(cpo, { name: "Merkez", city: "İstanbul", district: "Kadıköy" });
    await service.createChargePoint(cpo, { stationId: stationId.toHexString(), externalId: " cp-909 " });
    expect(stationInsert?.cpoTenantId.toHexString()).toBe(cpo.tenantId);
    expect(chargePointInsert).toMatchObject({ cpoTenantId: new ObjectId(cpo.tenantId), stationId, externalId: "CP-909" });
    expect(chargePointInsert).not.toHaveProperty("model");

    const contractor = principal("CONTRACTOR", "CONTRACTOR_ADMIN");
    await expect(service.createStation(contractor, { name: "X", city: "Y", district: "Z" }))
      .rejects.toMatchObject({ code: "ASSET_MANAGEMENT_FORBIDDEN" });
  });
});

describe("Ek7 son onay ve fiziksel teslim kuralları", () => {
  it("CPO puanı olmadan son onayı kabul etmez; puanı yalnız platform/CPO projeksiyonuna koyar", async () => {
    const cpo = principal("CPO", "CPO_ADMIN");
    const jobId = new ObjectId();
    let jobUpdate: Document | undefined;
    const collections: Collections = {
      jobs: {
        findOne: async () => ({ _id: jobId, status: "MAINTENANCE_APPROVED", cpoTenantId: new ObjectId(cpo.tenantId) }),
        updateOne: async (_filter: Document, update: Document) => { jobUpdate = update; return { matchedCount: 1 }; },
        aggregate: (pipeline: Document[]) => cursor([{ pipeline }]),
      },
      jobEvents: { insertOne: async () => ({ insertedId: new ObjectId() }) },
    };
    const service = new JobQueryService(database(collections));
    await expect(service.reviewByCpo(cpo, { id: jobId.toHexString(), rating: 0 }))
      .rejects.toMatchObject({ code: "CPO_REVIEW_INVALID" });
    await service.reviewByCpo(cpo, { id: jobId.toHexString(), rating: 5, feedback: "Harika" });
    expect(jobUpdate?.$set).toMatchObject({ status: "CPO_APPROVAL", cpoReview: { rating: 5, feedback: "Harika" } });
    await expect(service.changeStatus(cpo, { id: jobId.toHexString(), status: "CPO_APPROVAL" }))
      .rejects.toMatchObject({ code: "CPO_REVIEW_REQUIRED" });

    const contractor = principal("CONTRACTOR", "CONTRACTOR_STAFF");
    let contractorPipeline: Document[] = [];
    await new JobQueryService(database({ jobs: {
      aggregate: (pipeline: Document[]) => { contractorPipeline = pipeline; return cursor([]); },
    } })).list(contractor);
    const contractorProject = contractorPipeline.find((stage) => "$project" in stage)?.$project as Document;
    expect(contractorProject).not.toHaveProperty("cpoReview");
  });

  it("ek tedariki yalnız işe atanmış saha personelinin fiziksel onayıyla tamamlar", async () => {
    const field = principal("CONTRACTOR", "FIELD_WORKER");
    const jobId = new ObjectId();
    const requestId = new ObjectId();
    let requestFilter: Document | undefined;
    let requestUpdate: Document | undefined;
    let jobUpdate: Document | undefined;
    const request = { _id: requestId, jobId, partSupplyStatus: "AWAITING_FIELD_CONFIRMATION" };
    const collections: Collections = {
      additionalRequests: {
        findOne: async () => request,
        updateOne: async (filter: Document, update: Document) => {
          requestFilter = filter; requestUpdate = update; return { matchedCount: 1 };
        },
        countDocuments: async () => 0,
      },
      jobs: {
        findOne: async () => ({
          _id: jobId, contractorTenantId: new ObjectId(field.tenantId), fieldWorkerUserId: new ObjectId(field.userId),
          status: "ADDITIONAL_SUPPLY", maintenanceStartedAt: new Date(),
        }),
        updateOne: async (_filter: Document, update: Document) => { jobUpdate = update; return { matchedCount: 1 }; },
      },
    };
    const service = new JobCollaborationService(database(collections));
    await service.confirmRequestByField(field, { id: requestId.toHexString() });
    expect(requestFilter?.jobId).toEqual(jobId);
    expect(requestUpdate?.$set).toMatchObject({ status: "SUPPLIED", partSupplyStatus: "SUPPLIED" });
    expect(jobUpdate?.$set).toMatchObject({ status: "IN_PROGRESS" });

    const cpo = principal("CPO", "CPO_ADMIN");
    await expect(service.updateRequest(cpo, { id: requestId.toHexString(), partSupplyStatus: "SUPPLIED" }))
      .rejects.toMatchObject({ code: "ADDITIONAL_REQUEST_STATUS_INVALID" });

    const terminalService = new JobCollaborationService(database({
      additionalRequests: { findOne: async () => ({
        ...request, partSupplyStatus: "SUPPLIED", cpoVisibleAt: new Date(), supplyDeadlineAt: new Date(),
      }) },
      jobs: { findOne: async () => ({ _id: jobId, cpoTenantId: new ObjectId(cpo.tenantId) }) },
    }));
    await expect(terminalService.updateRequest(cpo, { id: requestId.toHexString(), partSupplyStatus: "DELAYED" }))
      .rejects.toMatchObject({ code: "ADDITIONAL_REQUEST_FIELD_CONTROLLED" });

    const otherField = { ...field, userId: new ObjectId().toHexString() };
    await expect(service.confirmRequestByField(otherField, { id: requestId.toHexString() }))
      .rejects.toMatchObject({ code: "FIELD_WORKER_NOT_ASSIGNED" });
  });

  it("bakım başlamadan ek tedarik talebi açılmasına izin vermez", async () => {
    const field = principal("CONTRACTOR", "FIELD_WORKER");
    const jobId = new ObjectId();
    const service = new JobCollaborationService(database({
      jobs: { findOne: async () => ({
        _id: jobId, status: "ASSIGNED", contractorTenantId: new ObjectId(field.tenantId),
        fieldWorkerUserId: new ObjectId(field.userId),
      }) },
    }));
    await expect(service.createRequest(field, {
      jobId: jobId.toHexString(), type: "OTHER_SUPPLY", description: "Başlangıç öncesi talep",
    })).rejects.toMatchObject({ code: "ADDITIONAL_SUPPLY_JOB_STATUS_INVALID" });
  });
});

describe("Ek7 cüzdan ve borç kuralları", () => {
  it("CPO ödemesini kredi limiti içinde negatif bakiyeyle yapar ve WALLET kaynağını kaydeder", async () => {
    const cpo = principal("CPO", "CPO_ADMIN");
    const jobId = new ObjectId();
    const walletId = new ObjectId();
    let walletFilter: Document | undefined;
    let walletUpdate: Document[] | undefined;
    let transactionUpdate: Document | undefined;
    const service = new JobQueryService(database({
      jobs: {
        findOne: async () => ({
          _id: jobId, jobNumber: "BN-2707", status: "CPO_APPROVAL", cpoTenantId: new ObjectId(cpo.tenantId),
          pricingSnapshot: { cpoPrice: 1200 },
        }),
        updateOne: async () => ({ matchedCount: 1 }),
      },
      wallets: {
        findOne: async () => ({ _id: walletId, balance: 500, creditLimit: 1000 }),
        updateOne: async (filter: Document, update: Document[]) => {
          walletFilter = filter; walletUpdate = update; return { matchedCount: 1 };
        },
      },
      walletTransactions: {
        updateOne: async (_filter: Document, update: Document) => { transactionUpdate = update; return { upsertedCount: 1 }; },
      },
      jobEvents: { insertOne: async () => ({ insertedId: new ObjectId() }) },
    }));
    await service.payCpoInvoice(cpo, { id: jobId.toHexString() });
    expect(walletFilter?.$or).toBeDefined();
    expect(walletUpdate?.[0]?.$set.appliedPaymentKeys).toEqual({
      $setUnion: [{ $ifNull: ["$appliedPaymentKeys", []] }, [`CPO_TO_PLATFORM:${jobId.toHexString()}`]],
    });
    expect(walletUpdate?.[1]?.$set.debtStatus).toBeDefined();
    expect(transactionUpdate?.$setOnInsert).toMatchObject({ walletId, paymentMethod: "WALLET", amount: -1200 });
  });

  it("eşzamanlı CPO ödeme tekrarlarında cüzdanı yalnız bir kez borçlandırır", async () => {
    const cpo = principal("CPO", "CPO_ADMIN");
    const jobId = new ObjectId();
    const walletId = new ObjectId();
    const job: Document = {
      _id: jobId, jobNumber: "BN-2710", status: "CPO_APPROVAL", cpoTenantId: new ObjectId(cpo.tenantId),
      pricingSnapshot: { cpoPrice: 1200 },
    };
    const wallet: Document = { _id: walletId, tenantId: job.cpoTenantId, balance: 500, creditLimit: 1000, appliedPaymentKeys: [] };
    let transactionCount = 0;
    let eventCount = 0;
    const jobs = {
      findOne: async () => ({ ...job }),
      updateOne: async (filter: Document, update: Document) => {
        if (update.$set?.cpoPaymentClaim) {
          if (job.cpoToPlatformPaidAt || job.cpoPaymentClaim) return { matchedCount: 0 };
          job.cpoPaymentClaim = update.$set.cpoPaymentClaim;
          return { matchedCount: 1 };
        }
        if (filter["cpoPaymentClaim.key"]) {
          if (job.cpoToPlatformPaidAt || (job.cpoPaymentClaim as Document | undefined)?.key !== filter["cpoPaymentClaim.key"]) return { matchedCount: 0 };
          Object.assign(job, update.$set);
          delete job.cpoPaymentClaim;
          return { matchedCount: 1 };
        }
        return { matchedCount: 1 };
      },
    };
    const wallets = {
      findOne: async () => ({ ...wallet, appliedPaymentKeys: [...wallet.appliedPaymentKeys as string[]] }),
      updateOne: async (_filter: Document, update: Document[]) => {
        const key = String(update[0]?.$set.appliedPaymentKeys.$setUnion[1][0]);
        const keys = wallet.appliedPaymentKeys as string[];
        if (!keys.includes(key)) {
          wallet.balance = Number(wallet.balance) - 1200;
          keys.push(key);
        }
        return { matchedCount: 1 };
      },
    };
    const service = new JobQueryService(database({
      jobs,
      wallets,
      walletTransactions: { updateOne: async () => { if (transactionCount === 0) transactionCount += 1; return { upsertedCount: transactionCount === 1 ? 1 : 0 }; } },
      jobEvents: { insertOne: async () => { eventCount += 1; return { insertedId: new ObjectId() }; } },
    }));

    await Promise.all([
      service.payCpoInvoice(cpo, { id: jobId.toHexString() }),
      service.payCpoInvoice(cpo, { id: jobId.toHexString() }),
    ]);
    expect(wallet.balance).toBe(-700);
    expect(wallet.appliedPaymentKeys).toEqual([`CPO_TO_PLATFORM:${jobId.toHexString()}`]);
    expect(transactionCount).toBe(1);
    expect(eventCount).toBe(1);
    expect(job.cpoToPlatformPaidAt).toBeInstanceOf(Date);
  });

  it("eşzamanlı teknik servis ödeme tekrarlarında cüzdanı yalnız bir kez alacaklandırır", async () => {
    const platform = principal("PLATFORM", "PLATFORM_OWNER");
    const jobId = new ObjectId();
    const contractorTenantId = new ObjectId();
    const walletId = new ObjectId();
    const job: Document = {
      _id: jobId, jobNumber: "BN-2711", status: "CPO_APPROVAL", cpoToPlatformPaidAt: new Date(),
      contractorTenantId, pricingSnapshot: { contractorCost: 750 },
    };
    const wallet: Document = { _id: walletId, tenantId: contractorTenantId, balance: 0, appliedPaymentKeys: [] };
    let transactionCount = 0;
    let eventCount = 0;
    const jobs = {
      findOne: async () => ({ ...job }),
      updateOne: async (filter: Document, update: Document) => {
        if (update.$set?.contractorPaymentClaim) {
          if (job.contractorPaidAt || job.contractorPaymentClaim) return { matchedCount: 0 };
          job.contractorPaymentClaim = update.$set.contractorPaymentClaim;
          return { matchedCount: 1 };
        }
        if (filter["contractorPaymentClaim.key"]) {
          if (job.contractorPaidAt || (job.contractorPaymentClaim as Document | undefined)?.key !== filter["contractorPaymentClaim.key"]) return { matchedCount: 0 };
          Object.assign(job, update.$set);
          delete job.contractorPaymentClaim;
          return { matchedCount: 1 };
        }
        return { matchedCount: 1 };
      },
    };
    const wallets = {
      findOne: async () => ({ ...wallet, appliedPaymentKeys: [...wallet.appliedPaymentKeys as string[]] }),
      updateOne: async (_filter: Document, update: Document | Document[]) => {
        if (!Array.isArray(update)) return { matchedCount: 1, upsertedCount: 0 };
        const key = String(update[0]?.$set.appliedPaymentKeys.$setUnion[1][0]);
        const keys = wallet.appliedPaymentKeys as string[];
        if (!keys.includes(key)) {
          wallet.balance = Number(wallet.balance) + 750;
          keys.push(key);
        }
        return { matchedCount: 1 };
      },
    };
    const service = new JobQueryService(database({
      jobs,
      wallets,
      walletTransactions: { updateOne: async () => { if (transactionCount === 0) transactionCount += 1; return { upsertedCount: transactionCount === 1 ? 1 : 0 }; } },
      jobEvents: { insertOne: async () => { eventCount += 1; return { insertedId: new ObjectId() }; } },
    }));

    await Promise.all([
      service.payContractor(platform, { id: jobId.toHexString() }),
      service.payContractor(platform, { id: jobId.toHexString() }),
    ]);
    expect(wallet.balance).toBe(750);
    expect(wallet.appliedPaymentKeys).toEqual([`PLATFORM_TO_CONTRACTOR:${jobId.toHexString()}`]);
    expect(transactionCount).toBe(1);
    expect(eventCount).toBe(1);
    expect(job.contractorPaidAt).toBeInstanceOf(Date);
  });

  it("platform düzeltmesinde ödeme yöntemini kaydeder ve varsayılanı MANUAL yapar", async () => {
    const platform = principal("PLATFORM", "PLATFORM_OWNER");
    const tenantId = new ObjectId();
    const walletId = new ObjectId();
    const transactions: Document[] = [];
    const service = new CommerceService(database({
      wallets: {
        findOne: async () => ({ _id: walletId, tenantId, balance: 1000, creditLimit: 5000, currency: "TRY" }),
        updateOne: async () => ({ matchedCount: 1 }),
      },
      tenants: { findOne: async () => ({ _id: tenantId, type: "CPO", operationalStatus: "ACTIVE" }), updateOne: async () => ({ matchedCount: 1 }) },
      walletTransactions: { insertOne: async (value: Document) => { transactions.push(value); return { insertedId: value._id }; } },
    }));
    await service.adjustWallet(platform, { tenantId: tenantId.toHexString(), amount: -100, description: "Kart tahsilatı", paymentMethod: "CREDIT_CARD" });
    await service.adjustWallet(platform, { tenantId: tenantId.toHexString(), amount: 100, description: "Manuel düzeltme" });
    expect(transactions.map((item) => item.paymentMethod)).toEqual(["CREDIT_CARD", "MANUAL"]);
  });

  it("CPO negatif bakiyesinin borçlanabilir tutarını hesaplar; limit altına düşünce hesabı bloke eder", async () => {
    const platform = principal("PLATFORM", "PLATFORM_OWNER");
    const tenantId = new ObjectId();
    const walletId = new ObjectId();
    let walletUpdate: Document[] | undefined;
    let tenantUpdate: Document | undefined;
    const service = new CommerceService(database({
      wallets: {
        findOne: async () => ({ _id: walletId, tenantId, balance: -120, creditLimit: 200 }),
        updateOne: async (_filter: Document, update: Document[]) => { walletUpdate = update; return { matchedCount: 1 }; },
      },
      tenants: {
        findOne: async () => ({ _id: tenantId, type: "CPO", status: "ACTIVE" }),
        updateOne: async (_filter: Document, update: Document) => { tenantUpdate = update; return { matchedCount: 1 }; },
      },
    }));
    const result = await service.updateCreditLimit(platform, { tenantId: tenantId.toHexString(), creditLimit: 100 });
    expect(result).toMatchObject({ creditLimit: 100, borrowableAmount: 0, debtStatus: "DEBT_LIMIT_EXCEEDED" });
    expect(walletUpdate?.[0]?.$set).toMatchObject({ creditLimit: 100 });
    expect(walletUpdate?.[1]?.$set.debtStatus).toBeDefined();
    expect(tenantUpdate?.$set).toMatchObject({ operationalStatus: "DEBT_BLOCKED" });
  });

  it("ödeme detayını yalnız kendi firması için yöntem ve güvenli kart özetiyle projekte eder", async () => {
    const cpo = principal("CPO", "CPO_STAFF");
    const transactionId = new ObjectId();
    let pipeline: Document[] = [];
    const service = new CommerceService(database({
      walletTransactions: {
        aggregate: (value: Document[]) => {
          pipeline = value;
          return cursor([{ id: transactionId.toHexString(), paymentMethod: "CREDIT_CARD", cardSummary: "**** 4242" }]);
        },
      },
    }));
    const detail = await service.walletTransactionDetail(cpo, transactionId.toHexString());
    const match = pipeline[0]?.$match as Document;
    const project = pipeline.find((stage) => "$project" in stage)?.$project as Document;
    expect(match._id).toEqual(transactionId);
    expect(match.tenantId.toHexString()).toBe(cpo.tenantId);
    expect(project).toHaveProperty("paymentMethod");
    expect(project).toHaveProperty("cardSummary");
    expect(project).not.toHaveProperty("cardNumber");
    expect(detail.paymentMethod).toBe("CREDIT_CARD");
  });

  it("borç limiti aşılmış CPO tokenını tüm korumalı rotalarda reddeder", async () => {
    const cpo = principal("CPO", "CPO_ADMIN");
    const secret = "ek7-test-secret-that-is-long-enough";
    const token = createToken(cpo, secret);
    const request = { header: () => `Bearer ${token}` } as unknown as Request;
    const response = { locals: {} } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    const config = { authTokenSecret: secret } as AppConfig;
    const authDatabase = database({
      tenants: { findOne: async () => ({ _id: new ObjectId(cpo.tenantId), status: "ACTIVE", operationalStatus: "DEBT_BLOCKED" }) },
      users: { findOne: async () => ({ _id: new ObjectId(cpo.userId), status: "ACTIVE" }) },
      wallets: { findOne: async () => ({ tenantId: new ObjectId(cpo.tenantId), balance: -120, creditLimit: 100 }) },
    });

    await authenticate(config, authDatabase)(request, response, next);
    const error = (next as unknown as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { code?: string };
    expect(error?.code).toBe("CPO_DEBT_BLOCKED");
    expect(response.locals).not.toHaveProperty("auth");
  });
});

type Collections = Record<string, Record<string, unknown>>;

function principal(tenantType: AuthPrincipal["tenantType"], role: AuthPrincipal["role"]): AuthPrincipal {
  return {
    userId: new ObjectId().toHexString(), tenantId: new ObjectId().toHexString(), tenantKey: "test", tenantName: "Test",
    tenantType, name: "Test User", email: "test@example.test", role,
  };
}

function database(collections: Collections): MongoDatabase {
  return { db: async () => ({ collection: (name: string) => collections[name] ?? {} }) } as unknown as MongoDatabase;
}

function cursor(items: Document[]) {
  return { project() { return this; }, sort() { return this; }, limit() { return this; }, async toArray() { return items; } };
}
