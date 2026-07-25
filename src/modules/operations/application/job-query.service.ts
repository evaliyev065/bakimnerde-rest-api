import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal } from "../../identity/domain/identity.types.js";

const JOB_STATUSES = new Set(["WAITING", "ASSIGNED", "IN_PROGRESS", "MAINTENANCE_DONE", "MAINTENANCE_APPROVED", "CPO_APPROVAL", "PAID", "CLOSED"]);

interface JobInput {
  id?: string;
  cpoTenantId: string;
  contractorTenantId?: string;
  stationName: string;
  city: string;
  district: string;
  chargerExternalId: string;
  chargerModel: string;
  status?: string;
  appointmentAt?: string;
  deadlineAt: string;
  cpoPrice?: number | null;
  contractorCost?: number | null;
}

export class JobQueryService {
  public constructor(private readonly database: MongoDatabase) {}

  public async list(principal: AuthPrincipal): Promise<Document[]> {
    const db = await this.database.db();
    const tenantId = new ObjectId(principal.tenantId);
    const match = principal.tenantType === "PLATFORM" ? {} :
      principal.tenantType === "CPO" ? { cpoTenantId: tenantId } :
      principal.role === "FIELD_WORKER"
        ? { contractorTenantId: tenantId, fieldWorkerUserId: new ObjectId(principal.userId) }
        : { contractorTenantId: tenantId };
    const amountPath = principal.tenantType === "CONTRACTOR"
      ? "$pricingSnapshot.contractorCost"
      : "$pricingSnapshot.cpoPrice";
    const assignedAmount = { $cond: [{ $gt: [{ $ifNull: [amountPath, 0] }, 0] }, amountPath, null] };
    return db.collection("jobs").aggregate([
      { $match: match }, { $sort: { createdAt: -1 } }, { $limit: 100 },
      { $lookup: { from: "tenants", localField: "cpoTenantId", foreignField: "_id", as: "cpo" } },
      { $lookup: { from: "tenants", localField: "contractorTenantId", foreignField: "_id", as: "contractor" } },
      { $lookup: { from: "users", localField: "fieldWorkerUserId", foreignField: "_id", as: "fieldWorker" } },
      { $project: {
        documentId: { $toString: "$_id" }, _id: 0, id: "$jobNumber", station: "$station.name", city: "$station.city",
        district: { $ifNull: ["$station.district", ""] },
        charger: "$charger.externalId", chargerModel: "$charger.model", status: 1, appointmentAt: 1,
        assignmentAcceptanceDeadlineAt: 1, contractorAcceptedAt: 1, outageNotificationSentAt: 1,
        workflowCycle: { $ifNull: ["$workflowCycle", 1] },
        deadlineAt: "$publishDeadlineAt", cpoTenantId: { $toString: "$cpoTenantId" },
        contractorTenantId: { $cond: [{ $ifNull: ["$contractorTenantId", false] }, { $toString: "$contractorTenantId" }, null] },
        fieldWorkerUserId: { $cond: [{ $ifNull: ["$fieldWorkerUserId", false] }, { $toString: "$fieldWorkerUserId" }, null] },
        fieldWorkerName: { $ifNull: [{ $first: "$fieldWorker.name" }, null] },
        fieldWorkerPhone: { $ifNull: [{ $first: "$fieldWorker.phone" }, null] },
        cpo: { $ifNull: [{ $first: "$cpo.name" }, "CPO Firma"] },
        contractor: principal.tenantType === "PLATFORM"
          ? { $ifNull: [{ $first: "$contractor.name" }, "Atanmadı"] }
          : { $literal: "Bakımnerde Saha Ağı" },
        amount: assignedAmount,
        contractorCost: principal.tenantType === "PLATFORM"
          ? { $cond: [{ $gt: [{ $ifNull: ["$pricingSnapshot.contractorCost", 0] }, 0] }, "$pricingSnapshot.contractorCost", null] }
          : { $literal: null },
      } },
    ]).toArray();
  }

  public async listFieldWorkers(principal: AuthPrincipal): Promise<Document[]> {
    const contractorRoles = ["CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"];
    if (principal.tenantType !== "PLATFORM" && (principal.tenantType !== "CONTRACTOR" || !contractorRoles.includes(principal.role))) {
      throw new AppError(403, "FIELD_WORKER_LIST_FORBIDDEN", "Saha personeli listesini görüntüleme yetkiniz yok.", false);
    }
    const db = await this.database.db();
    const match: Document = { role: "FIELD_WORKER", status: "ACTIVE" };
    if (principal.tenantType === "CONTRACTOR") match.tenantId = new ObjectId(principal.tenantId);
    return db.collection("users").aggregate([
      { $match: match }, { $sort: { name: 1 } },
      { $lookup: { from: "tenants", localField: "tenantId", foreignField: "_id", as: "tenant" } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, tenantId: { $toString: "$tenantId" },
        tenantName: { $ifNull: [{ $first: "$tenant.name" }, "Taşeron firma"] },
        name: 1, email: 1, phone: 1,
      } },
    ]).toArray();
  }

  public async assignFieldWorker(
    principal: AuthPrincipal,
    input: { id: string; fieldWorkerUserId: string },
  ): Promise<{ id: string; fieldWorkerUserId: string }> {
    const id = this.objectId(input.id);
    const fieldWorkerUserId = this.objectId(input.fieldWorkerUserId);
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (!job.contractorTenantId) throw new AppError(409, "CONTRACTOR_NOT_ASSIGNED", "Önce işe taşeron firma atayın.", false);
    const contractorCanAssign = principal.tenantType === "CONTRACTOR"
      && ["CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"].includes(principal.role)
      && job.contractorTenantId.equals(new ObjectId(principal.tenantId));
    if (principal.tenantType !== "PLATFORM" && !contractorCanAssign) {
      throw new AppError(403, "FIELD_WORKER_ASSIGN_FORBIDDEN", "Bu işe saha personeli atama yetkiniz yok.", false);
    }
    const fieldWorker = await db.collection("users").findOne({
      _id: fieldWorkerUserId,
      tenantId: job.contractorTenantId,
      role: "FIELD_WORKER",
      status: "ACTIVE",
    });
    if (fieldWorker === null) {
      throw new AppError(400, "FIELD_WORKER_INVALID", "Seçilen saha personeli bu taşeron firmaya ait aktif bir saha hesabı değil.", false);
    }
    const now = new Date();
    await db.collection("jobs").updateOne({ _id: id }, { $set: {
      fieldWorkerUserId,
      fieldWorkerAssignedAt: now,
      fieldWorkerAssignedByUserId: new ObjectId(principal.userId),
      updatedAt: now,
    } });
    await this.event(db, id, principal, "FIELD_WORKER_ASSIGNED", String(job.status), fieldWorker.name);
    return { id: input.id, fieldWorkerUserId: input.fieldWorkerUserId };
  }

  public async create(principal: AuthPrincipal, input: JobInput): Promise<{ id: string; jobNumber: string }> {
    this.validate(input);
    const db = await this.database.db();
    const sequence = await db.collection<{ _id: string; value: number }>("counters").findOneAndUpdate(
      { _id: "jobNumber" }, { $inc: { value: 1 } }, { upsert: true, returnDocument: "after" },
    );
    const jobNumber = `BN-${String(Number(sequence?.value ?? 2500)).padStart(4, "0")}`;
    const now = new Date();
    const id = new ObjectId();
    if (principal.tenantType === "CONTRACTOR") throw new AppError(403, "JOB_CREATE_FORBIDDEN", "Taşeron firma iş yayınlayamaz.", false);
    const cpoTenantId = principal.tenantType === "CPO" ? new ObjectId(principal.tenantId) : this.objectId(input.cpoTenantId);
    const contractorTenantId = principal.tenantType === "PLATFORM" && input.contractorTenantId ? this.objectId(input.contractorTenantId) : null;
    await this.assertTenantTypes(db, cpoTenantId, contractorTenantId);
    const initialStatus = contractorTenantId ? "ASSIGNED" : "WAITING";
    await db.collection("jobs").insertOne({
      _id: id, jobNumber, cpoTenantId, contractorTenantId,
      station: { name: input.stationName.trim(), city: input.city.trim(), district: input.district.trim() },
      charger: { externalId: input.chargerExternalId.trim(), model: input.chargerModel.trim() },
      status: initialStatus, publishedAt: now, publishDeadlineAt: new Date(now.getTime() + 14 * 86400000),
      assignmentAt: contractorTenantId ? now : null,
      assignmentAcceptanceDeadlineAt: contractorTenantId ? new Date(now.getTime() + 86400000) : null,
      appointmentAt: input.appointmentAt ? new Date(input.appointmentAt) : null,
      pricingSnapshot: {
        cpoPrice: principal.tenantType === "PLATFORM" && input.cpoPrice !== null && input.cpoPrice !== undefined ? Number(input.cpoPrice) : null,
        contractorCost: principal.tenantType === "PLATFORM" && input.contractorCost !== null && input.contractorCost !== undefined ? Number(input.contractorCost) : null,
        currency: "TRY",
      },
      evidencePolicy: { beforePhotoCount: 6, afterPhotoCount: 6, brandedPhotoCount: 1 },
      workflowCycle: 1,
      createdByTenantId: new ObjectId(principal.tenantId), createdAt: now, updatedAt: now,
    });
    await this.event(db, id, principal, "JOB_CREATED", initialStatus);
    return { id: id.toHexString(), jobNumber };
  }

  public async update(principal: AuthPrincipal, input: JobInput): Promise<{ id: string }> {
    this.assertPlatform(principal);
    this.validate(input);
    const id = this.objectId(input.id ?? "");
    const db = await this.database.db();
    const current = await db.collection("jobs").findOne({ _id: id });
    if (current === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    const cpoTenantId = this.objectId(input.cpoTenantId);
    const contractorTenantId = input.contractorTenantId ? this.objectId(input.contractorTenantId) : null;
    await this.assertTenantTypes(db, cpoTenantId, contractorTenantId);
    const contractorChanged = String(current.contractorTenantId ?? "") !== String(contractorTenantId ?? "");
    const assignment = contractorChanged ? (contractorTenantId ? {
      status: "ASSIGNED", assignmentAt: new Date(), assignmentAcceptanceDeadlineAt: new Date(Date.now() + 86400000),
      contractorAcceptedAt: null, outageNotificationSentAt: null, fieldWorkerUserId: null,
      fieldWorkerAssignedAt: null, fieldWorkerAssignedByUserId: null,
    } : {
      status: "WAITING", assignmentAt: null, assignmentAcceptanceDeadlineAt: null,
      contractorAcceptedAt: null, outageNotificationSentAt: null, fieldWorkerUserId: null,
      fieldWorkerAssignedAt: null, fieldWorkerAssignedByUserId: null,
    }) : {};
    const result = await db.collection("jobs").updateOne({ _id: id }, { $set: {
      cpoTenantId,
      contractorTenantId,
      station: { name: input.stationName.trim(), city: input.city.trim(), district: input.district.trim() },
      charger: { externalId: input.chargerExternalId.trim(), model: input.chargerModel.trim() },
      publishDeadlineAt: new Date(input.deadlineAt), appointmentAt: input.appointmentAt ? new Date(input.appointmentAt) : null,
      pricingSnapshot: {
        cpoPrice: input.cpoPrice === null || input.cpoPrice === undefined ? null : Number(input.cpoPrice),
        contractorCost: input.contractorCost === null || input.contractorCost === undefined ? null : Number(input.contractorCost),
        currency: "TRY",
      },
      ...assignment, updatedAt: new Date(),
    } });
    if (result.matchedCount === 0) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    await this.event(db, id, principal, "JOB_UPDATED", null);
    return { id: id.toHexString() };
  }

  public async changeStatus(principal: AuthPrincipal, input: { id: string; status: string; note?: string }): Promise<{ id: string; status: string }> {
    if (!JOB_STATUSES.has(input.status)) throw new AppError(400, "JOB_STATUS_INVALID", "Geçersiz iş durumu.", false);
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (principal.tenantType === "CPO") {
      if (!job.cpoTenantId.equals(new ObjectId(principal.tenantId)) || input.status !== "CPO_APPROVAL" || job.status !== "MAINTENANCE_APPROVED") {
        throw new AppError(403, "JOB_STATUS_FORBIDDEN", "CPO yalnız kendi işinde CPO onayı verebilir.", false);
      }
    } else if (principal.tenantType === "CONTRACTOR") {
      if (!job.contractorTenantId?.equals(new ObjectId(principal.tenantId)) || !["FIELD_WORKER", "CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"].includes(principal.role)
        || !["IN_PROGRESS", "MAINTENANCE_DONE"].includes(input.status)) {
        throw new AppError(403, "JOB_STATUS_FORBIDDEN", "Bu iş durumunu değiştirme yetkiniz yok.", false);
      }
      if (principal.role === "FIELD_WORKER" && !job.fieldWorkerUserId?.equals(new ObjectId(principal.userId))) {
        throw new AppError(403, "FIELD_WORKER_NOT_ASSIGNED", "Bu iş size atanmadı.", false);
      }
      if (input.status === "IN_PROGRESS" && (job.status !== "ASSIGNED" || !job.contractorAcceptedAt || !job.appointmentAt || job.appointmentAt > new Date())) {
        throw new AppError(409, "APPOINTMENT_NOT_READY", "İş ancak onaylanan randevu zamanı geldiğinde başlatılabilir.", false);
      }
      if (input.status === "MAINTENANCE_DONE") {
        if (job.status !== "IN_PROGRESS") throw new AppError(409, "JOB_TRANSITION_INVALID", "Bakım tamamlanmadan önce işlem başlatılmalıdır.", false);
        const cycle = Number(job.workflowCycle ?? 1);
        const counts = await db.collection("jobMedia").aggregate<{ _id: string; count: number }>([
          { $match: { jobId: id, cycle } }, { $group: { _id: "$phase", count: { $sum: 1 } } },
        ]).toArray();
        const evidence = Object.fromEntries(counts.map((item) => [item._id, item.count]));
        if (evidence.BEFORE !== 6 || evidence.AFTER !== 6 || evidence.BRANDED !== 1) {
          throw new AppError(409, "EVIDENCE_INCOMPLETE", "Bakımı tamamlamak için 6 önce, 6 sonra ve 1 Bakımnerde tişörtlü fotoğraf gereklidir.", false);
        }
        const report = await db.collection("jobFieldReports").findOne({ jobId: id, cycle, completed: true });
        if (report === null) {
          throw new AppError(409, "FIELD_REPORT_INCOMPLETE", "Bakımı tamamlamak için saha işlem formunu eksiksiz kaydedin.", false);
        }
      }
    } else {
      const allowedPlatformTransition =
        (job.status === "MAINTENANCE_DONE" && input.status === "MAINTENANCE_APPROVED")
        || (job.status === "CPO_APPROVAL" && input.status === "PAID")
        || (job.status === "PAID" && input.status === "CLOSED");
      if (!allowedPlatformTransition) {
        throw new AppError(409, "JOB_TRANSITION_INVALID", "Seçilen durum mevcut iş aşamasından sonra gelemez.", false);
      }
    }
    const result = await db.collection("jobs").updateOne({ _id: id }, { $set: { status: input.status, updatedAt: new Date() } });
    if (result.matchedCount === 0) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (input.status === "PAID" && job.contractorTenantId) {
      const amount = Number(job.pricingSnapshot?.contractorCost ?? 0);
      const now = new Date();
      await db.collection("wallets").updateOne(
        { tenantId: job.contractorTenantId },
        { $inc: { balance: amount }, $set: { updatedAt: now }, $setOnInsert: { type: "CLOSED", currency: "TRY", blockedBalance: 0, createdAt: now } },
        { upsert: true },
      );
      await db.collection("walletTransactions").insertOne({
        tenantId: job.contractorTenantId, jobId: id, type: "EARNING", amount, currency: "TRY",
        description: `${job.jobNumber} hakedişi`, createdByUserId: new ObjectId(principal.userId), createdAt: now,
      });
    }
    await this.event(db, id, principal, "JOB_STATUS_CHANGED", input.status, input.note);
    return { id: input.id, status: input.status };
  }

  public async acceptAssignment(principal: AuthPrincipal, input: { id: string; appointmentAt: string }): Promise<{ id: string; appointmentAt: Date }> {
    if (principal.tenantType !== "CONTRACTOR" || !["CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"].includes(principal.role)) {
      throw new AppError(403, "ASSIGNMENT_ACCEPT_FORBIDDEN", "Atamayı yalnız taşeron yönetim ekibi onaylayabilir.", false);
    }
    const id = this.objectId(input.id);
    const appointmentAt = new Date(input.appointmentAt);
    if (Number.isNaN(appointmentAt.getTime()) || appointmentAt <= new Date()) {
      throw new AppError(400, "APPOINTMENT_INVALID", "Gelecekte geçerli bir randevu tarihi seçin.", false);
    }
    const db = await this.database.db();
    const now = new Date();
    const result = await db.collection("jobs").updateOne({
      _id: id, contractorTenantId: new ObjectId(principal.tenantId), status: "ASSIGNED",
      assignmentAcceptanceDeadlineAt: { $gte: now },
    }, { $set: { contractorAcceptedAt: now, appointmentAt, outageNotificationSentAt: now, updatedAt: now } });
    if (result.matchedCount === 0) throw new AppError(409, "ASSIGNMENT_ACCEPTANCE_EXPIRED", "Atama bulunamadı veya bir günlük onay süresi doldu.", false);
    await this.event(db, id, principal, "ASSIGNMENT_ACCEPTED", "ASSIGNED", `Randevu: ${appointmentAt.toISOString()}`);
    return { id: input.id, appointmentAt };
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
      db.collection("jobFieldReports").deleteMany({ jobId: id }),
      db.collection("additionalRequests").deleteMany({ jobId: id }),
      db.collection("messages").deleteMany({ jobId: id }),
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
    if (!input.stationName?.trim() || !input.city?.trim() || !input.district?.trim() || !input.chargerExternalId?.trim()
      || !input.chargerModel?.trim() || (input.cpoTenantId && !ObjectId.isValid(input.cpoTenantId))
      || (input.cpoPrice !== null && input.cpoPrice !== undefined && (!Number.isFinite(Number(input.cpoPrice)) || Number(input.cpoPrice) <= 0))
      || (input.contractorCost !== null && input.contractorCost !== undefined && (!Number.isFinite(Number(input.contractorCost)) || Number(input.contractorCost) <= 0))) {
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

  private async assertTenantTypes(
    db: Awaited<ReturnType<MongoDatabase["db"]>>,
    cpoTenantId: ObjectId,
    contractorTenantId: ObjectId | null,
  ): Promise<void> {
    const ids = contractorTenantId ? [cpoTenantId, contractorTenantId] : [cpoTenantId];
    const tenants = await db.collection("tenants").find({ _id: { $in: ids }, status: "ACTIVE" }).project({ _id: 1, type: 1 }).toArray();
    const cpo = tenants.find((item) => item._id.equals(cpoTenantId));
    const contractor = contractorTenantId ? tenants.find((item) => item._id.equals(contractorTenantId)) : null;
    if (cpo?.type !== "CPO" || (contractorTenantId && contractor?.type !== "CONTRACTOR")) {
      throw new AppError(400, "JOB_PARTIES_INVALID", "CPO ve taşeron firma seçimlerini kontrol edin.", false);
    }
  }
}
