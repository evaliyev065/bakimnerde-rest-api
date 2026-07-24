import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal } from "../../identity/domain/identity.types.js";

const JOB_STATUSES = new Set(["WAITING", "ASSIGNED", "IN_PROGRESS", "MAINTENANCE_DONE", "MAINTENANCE_APPROVED", "CPO_APPROVAL", "PAID", "CLOSED"]);

interface JobInput {
  id?: string;
  cpoTenantId: string;
  manufacturerTenantId: string;
  contractorTenantId?: string;
  stationName: string;
  city: string;
  chargerExternalId: string;
  chargerModel: string;
  status?: string;
  appointmentAt?: string;
  deadlineAt: string;
  cpoPrice: number;
  contractorCost: number;
}

export class JobQueryService {
  public constructor(private readonly database: MongoDatabase) {}

  public async list(principal: AuthPrincipal): Promise<Document[]> {
    const db = await this.database.db();
    const tenantId = new ObjectId(principal.tenantId);
    const match = principal.tenantType === "PLATFORM" ? {} :
      principal.tenantType === "MANUFACTURER" ? { manufacturerTenantId: tenantId } :
      principal.tenantType === "CPO" ? { cpoTenantId: tenantId } :
      { contractorTenantId: tenantId };
    const canSeeCommercials = principal.tenantType === "PLATFORM";
    return db.collection("jobs").aggregate([
      { $match: match }, { $sort: { createdAt: -1 } }, { $limit: 100 },
      { $lookup: { from: "tenants", localField: "cpoTenantId", foreignField: "_id", as: "cpo" } },
      { $lookup: { from: "tenants", localField: "manufacturerTenantId", foreignField: "_id", as: "manufacturer" } },
      { $lookup: { from: "tenants", localField: "contractorTenantId", foreignField: "_id", as: "contractor" } },
      { $project: {
        documentId: { $toString: "$_id" }, _id: 0, id: "$jobNumber", station: "$station.name", city: "$station.city",
        charger: "$charger.externalId", chargerModel: "$charger.model", status: 1, appointmentAt: 1,
        deadlineAt: "$publishDeadlineAt", cpoTenantId: { $toString: "$cpoTenantId" },
        manufacturerTenantId: { $toString: "$manufacturerTenantId" },
        contractorTenantId: { $cond: [{ $ifNull: ["$contractorTenantId", false] }, { $toString: "$contractorTenantId" }, null] },
        cpo: { $ifNull: [{ $first: "$cpo.name" }, "CPO Firma"] },
        manufacturer: { $ifNull: [{ $first: "$manufacturer.name" }, "Üretici Firma"] },
        contractor: canSeeCommercials ? { $ifNull: [{ $first: "$contractor.name" }, "Atanmadı"] } : { $literal: "Bakımnerde Saha Ağı" },
        amount: canSeeCommercials ? "$pricingSnapshot.cpoPrice" : { $literal: null },
        contractorCost: canSeeCommercials ? "$pricingSnapshot.contractorCost" : { $literal: null },
      } },
    ]).toArray();
  }

  public async create(principal: AuthPrincipal, input: JobInput): Promise<{ id: string; jobNumber: string }> {
    this.assertPlatform(principal);
    this.validate(input);
    const db = await this.database.db();
    const sequence = await db.collection<{ _id: string; value: number }>("counters").findOneAndUpdate(
      { _id: "jobNumber" }, { $inc: { value: 1 } }, { upsert: true, returnDocument: "after" },
    );
    const jobNumber = `BN-${String(Number(sequence?.value ?? 2500)).padStart(4, "0")}`;
    const now = new Date();
    const id = new ObjectId();
    await db.collection("jobs").insertOne({
      _id: id, jobNumber, cpoTenantId: this.objectId(input.cpoTenantId),
      manufacturerTenantId: this.objectId(input.manufacturerTenantId),
      contractorTenantId: input.contractorTenantId ? this.objectId(input.contractorTenantId) : null,
      station: { name: input.stationName.trim(), city: input.city.trim() },
      charger: { externalId: input.chargerExternalId.trim(), model: input.chargerModel.trim() },
      status: input.status ?? "WAITING", publishDeadlineAt: new Date(input.deadlineAt),
      appointmentAt: input.appointmentAt ? new Date(input.appointmentAt) : null,
      pricingSnapshot: { cpoPrice: Number(input.cpoPrice), contractorCost: Number(input.contractorCost), currency: "TRY" },
      evidencePolicy: { beforePhotoCount: 6, afterPhotoCount: 6, brandedPhotoCount: 1 },
      createdByTenantId: new ObjectId(principal.tenantId), createdAt: now, updatedAt: now,
    });
    await this.event(db, id, principal, "JOB_CREATED", input.status ?? "WAITING");
    return { id: id.toHexString(), jobNumber };
  }

  public async update(principal: AuthPrincipal, input: JobInput): Promise<{ id: string }> {
    this.assertPlatform(principal);
    this.validate(input);
    const id = this.objectId(input.id ?? "");
    const db = await this.database.db();
    const result = await db.collection("jobs").updateOne({ _id: id }, { $set: {
      cpoTenantId: this.objectId(input.cpoTenantId), manufacturerTenantId: this.objectId(input.manufacturerTenantId),
      contractorTenantId: input.contractorTenantId ? this.objectId(input.contractorTenantId) : null,
      station: { name: input.stationName.trim(), city: input.city.trim() },
      charger: { externalId: input.chargerExternalId.trim(), model: input.chargerModel.trim() },
      publishDeadlineAt: new Date(input.deadlineAt), appointmentAt: input.appointmentAt ? new Date(input.appointmentAt) : null,
      pricingSnapshot: { cpoPrice: Number(input.cpoPrice), contractorCost: Number(input.contractorCost), currency: "TRY" },
      updatedAt: new Date(),
    } });
    if (result.matchedCount === 0) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    await this.event(db, id, principal, "JOB_UPDATED", null);
    return { id: id.toHexString() };
  }

  public async changeStatus(principal: AuthPrincipal, input: { id: string; status: string; note?: string }): Promise<{ id: string; status: string }> {
    this.assertPlatform(principal);
    if (!JOB_STATUSES.has(input.status)) throw new AppError(400, "JOB_STATUS_INVALID", "Geçersiz iş durumu.", false);
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const result = await db.collection("jobs").updateOne({ _id: id }, { $set: { status: input.status, updatedAt: new Date() } });
    if (result.matchedCount === 0) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    await this.event(db, id, principal, "JOB_STATUS_CHANGED", input.status, input.note);
    return { id: input.id, status: input.status };
  }

  public async delete(principal: AuthPrincipal, idValue: string): Promise<{ id: string; deleted: true }> {
    this.assertPlatform(principal);
    const id = this.objectId(idValue);
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (!["WAITING", "ASSIGNED"].includes(String(job.status))) {
      throw new AppError(409, "JOB_DELETE_NOT_ALLOWED", "İşleme başlanmış iş silinemez.", false);
    }
    await Promise.all([
      db.collection("jobs").deleteOne({ _id: id }),
      db.collection("jobEvents").deleteMany({ jobId: id }),
      db.collection("jobMedia").deleteMany({ jobId: id }),
      db.collection("additionalRequests").deleteMany({ jobId: id }),
    ]);
    return { id: idValue, deleted: true };
  }

  private async event(db: Awaited<ReturnType<MongoDatabase["db"]>>, jobId: ObjectId, principal: AuthPrincipal, eventType: string, status: string | null, note?: string): Promise<void> {
    await db.collection("jobEvents").insertOne({
      jobId, eventType, status, note: note ?? "", actorUserId: new ObjectId(principal.userId),
      actorTenantId: new ObjectId(principal.tenantId), createdAt: new Date(),
    });
  }

  private validate(input: JobInput): void {
    if (!input.stationName?.trim() || !input.city?.trim() || !input.chargerExternalId?.trim()
      || !input.chargerModel?.trim() || !input.deadlineAt || !ObjectId.isValid(input.cpoTenantId)
      || !ObjectId.isValid(input.manufacturerTenantId) || !Number.isFinite(Number(input.cpoPrice))
      || !Number.isFinite(Number(input.contractorCost))) {
      throw new AppError(400, "JOB_INPUT_INVALID", "İş, firma, cihaz, tarih ve fiyat alanlarını kontrol edin.", false);
    }
  }

  private objectId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new AppError(400, "IDENTIFIER_INVALID", "Geçersiz kayıt kimliği.", false);
    return new ObjectId(value);
  }

  private assertPlatform(principal: AuthPrincipal): void {
    if (principal.tenantType !== "PLATFORM") throw new AppError(403, "PLATFORM_ACCESS_REQUIRED", "Bu işlem yalnız Bakımnerde personeline açıktır.", false);
  }
}
