import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal } from "../../identity/domain/identity.types.js";

const FIELD_REPORT_OPTIONS = {
  serviceType: new Set(["PREVENTIVE_MAINTENANCE", "FAULT_REPAIR", "INSTALLATION_CHECK"]),
  equipmentCondition: new Set(["OPERATIONAL", "LIMITED", "OUT_OF_SERVICE"]),
  faultCategory: new Set(["ELECTRICAL", "MECHANICAL", "COMMUNICATION", "SOFTWARE", "OTHER"]),
  actionTaken: new Set(["REPAIRED", "PART_REQUIRED", "MONITORING", "NO_FAULT"]),
  safetyResult: new Set(["SAFE", "ISOLATED", "ESCALATED"]),
};

const ADDITIONAL_SUPPLY_TYPES = new Set(["FAN_REPLACEMENT", "CABLE_REPLACEMENT", "CONNECTOR_REPLACEMENT", "OTHER_SUPPLY"]);
const MANUAL_SUPPLY_STATUSES = new Set(["DELAYED", "SUPPLIED"]);

interface FieldReportInput {
  jobId: string;
  serviceType: string;
  equipmentCondition: string;
  faultCategory: string;
  actionTaken: string;
  safetyResult: string;
  inputVoltage?: number | null;
  outputVoltage?: number | null;
  notes: string;
}

export class JobCollaborationService {
  public constructor(private readonly database: MongoDatabase) {}

  public async listEvidence(principal: AuthPrincipal, jobIdValue: string): Promise<Document[]> {
    const { db, jobId, job } = await this.authorizedJob(principal, jobIdValue);
    const cycle = Number(job.workflowCycle ?? 1);
    return db.collection("jobMedia").find({ jobId, cycle }).sort({ createdAt: 1 }).map(({ _id, contentBase64, mimeType, url, ...item }) => ({
      id: _id.toHexString(),
      ...item,
      mimeType: mimeType ?? null,
      downloadAvailable: Boolean(contentBase64 && mimeType),
      ...(principal.role === "FIELD_WORKER" && contentBase64 && mimeType
        ? { url: `data:${mimeType};base64,${contentBase64}` }
        : url ? { url } : {}),
    })).toArray();
  }

  public async downloadEvidence(principal: AuthPrincipal, evidenceIdValue: string): Promise<{ content: Buffer; mimeType: string; fileName: string }> {
    const evidenceId = this.objectId(evidenceIdValue);
    const db = await this.database.db();
    const evidence = await db.collection("jobMedia").findOne({ _id: evidenceId });
    if (evidence === null) throw new AppError(404, "JOB_EVIDENCE_NOT_FOUND", "Bakım fotoğrafı bulunamadı.", false);
    await this.authorizedJob(principal, evidence.jobId.toHexString());
    const mimeType = String(evidence.mimeType ?? "");
    const contentBase64 = String(evidence.contentBase64 ?? "");
    if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType) || !contentBase64) {
      throw new AppError(409, "JOB_EVIDENCE_DOWNLOAD_UNAVAILABLE", "Bu eski fotoğraf kaydı DB indirmesi için uygun değil.", false);
    }
    const extension = mimeType === "image/png" ? "png" : mimeType === "image/webp" ? "webp" : "jpg";
    const suppliedName = String(evidence.fileName ?? "").trim().slice(0, 180);
    return {
      content: Buffer.from(contentBase64, "base64"),
      mimeType,
      fileName: suppliedName || `bakim-fotografi-${evidenceId.toHexString()}.${extension}`,
    };
  }

  public async addEvidence(principal: AuthPrincipal, input: { jobId: string; phase: "BEFORE" | "AFTER" | "BRANDED"; contentBase64?: string; mimeType?: string; fileName?: string; url?: string; description: string; clientOperationId?: string }): Promise<{ id: string }> {
    if (principal.role !== "FIELD_WORKER") throw new AppError(403, "FIELD_WORKER_REQUIRED", "Bakım kanıtını yalnız saha ekibi yükleyebilir.", false);
    const url = input.url?.trim() ?? "";
    const mimeType = input.mimeType?.trim().toLocaleLowerCase("en-US") ?? "";
    const contentBase64 = input.contentBase64?.replace(/\s/g, "") ?? "";
    const binarySize = contentBase64 ? Buffer.byteLength(contentBase64, "base64") : 0;
    const validUrl = url.startsWith("/") || url.startsWith("https://") || /^data:image\/(jpeg|png|webp);base64,/i.test(url);
    const validContent = ["image/jpeg", "image/png", "image/webp"].includes(mimeType)
      && /^[a-z0-9+/]+={0,2}$/i.test(contentBase64) && binarySize > 0 && binarySize <= 800_000;
    if (!["BEFORE", "AFTER", "BRANDED"].includes(input.phase) || (!validContent && !validUrl) || url.length > 850_000) {
      throw new AppError(400, "EVIDENCE_INPUT_INVALID", "Kanıt aşaması ve dosya adresi gereklidir.", false);
    }
    const { db, jobId, job } = await this.authorizedJob(principal, input.jobId);
    if (input.clientOperationId) {
      const existing = await db.collection("jobMedia").findOne({ clientOperationId: input.clientOperationId, uploadedByUserId: new ObjectId(principal.userId) });
      if (existing?._id) return { id: existing._id.toHexString() };
    }
    const cycle = Number(job.workflowCycle ?? 1);
    const count = await db.collection("jobMedia").countDocuments({ jobId, cycle, phase: input.phase });
    const limit = input.phase === "BRANDED" ? 1 : 6;
    if (count >= limit) throw new AppError(409, "EVIDENCE_LIMIT_REACHED", `Bu aşama için en fazla ${limit} görsel yüklenebilir.`, false);
    const result = await db.collection("jobMedia").insertOne({
      jobId, cycle, phase: input.phase,
      ...(validContent ? { contentBase64, mimeType, fileName: input.fileName?.trim().slice(0, 200) ?? "photo.jpg", sizeBytes: binarySize } : { url }),
      description: input.description?.trim().slice(0, 300) ?? "", ...(input.clientOperationId ? { clientOperationId: input.clientOperationId } : {}),
      uploadedByUserId: new ObjectId(principal.userId), uploadedByTenantId: new ObjectId(principal.tenantId), createdAt: new Date(),
    });
    return { id: result.insertedId.toHexString() };
  }

  public async getFieldReport(principal: AuthPrincipal, jobIdValue: string): Promise<Document | null> {
    const { db, jobId, job } = await this.authorizedJob(principal, jobIdValue);
    const cycle = Number(job.workflowCycle ?? 1);
    const report = await db.collection("jobFieldReports").findOne({ jobId, cycle });
    if (report === null) return null;
    const { _id, ...data } = report;
    return { id: _id.toHexString(), ...data };
  }

  public async saveFieldReport(principal: AuthPrincipal, input: FieldReportInput): Promise<{ id: string; completed: true }> {
    if (principal.role !== "FIELD_WORKER") {
      throw new AppError(403, "FIELD_WORKER_REQUIRED", "Saha işlem formunu yalnız atanmış saha personeli kaydedebilir.", false);
    }
    this.validateFieldReport(input);
    const { db, jobId, job } = await this.authorizedJob(principal, input.jobId);
    if (!["ASSIGNED", "IN_PROGRESS"].includes(String(job.status))) {
      throw new AppError(409, "FIELD_REPORT_STATUS_INVALID", "Saha formu yalnız atanmış veya işlemdeki iş için kaydedilebilir.", false);
    }
    const cycle = Number(job.workflowCycle ?? 1);
    const now = new Date();
    const result = await db.collection("jobFieldReports").findOneAndUpdate(
      { jobId, cycle },
      {
        $set: {
          serviceType: input.serviceType,
          equipmentCondition: input.equipmentCondition,
          faultCategory: input.faultCategory,
          actionTaken: input.actionTaken,
          safetyResult: input.safetyResult,
          measurements: {
            inputVoltage: input.inputVoltage === null || input.inputVoltage === undefined ? null : Number(input.inputVoltage),
            outputVoltage: input.outputVoltage === null || input.outputVoltage === undefined ? null : Number(input.outputVoltage),
          },
          notes: input.notes.trim(),
          completed: true,
          completedByUserId: new ObjectId(principal.userId),
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      { upsert: true, returnDocument: "after" },
    );
    if (result?._id === undefined) throw new AppError(500, "FIELD_REPORT_SAVE_FAILED", "Saha formu kaydedilemedi.", true);
    return { id: result._id.toHexString(), completed: true };
  }

  public async listRequests(principal: AuthPrincipal, jobIdValue: string): Promise<Document[]> {
    const { db, jobId } = await this.authorizedJob(principal, jobIdValue);
    const match: Document = { jobId };
    if (principal.tenantType === "CPO") match.cpoVisibleAt = { $type: "date" };
    return db.collection("additionalRequests").find(match).sort({ createdAt: -1 }).map(({
      _id, laborPrice, cpoPrice, pricingRuleId, createdByUserId, pricedByUserId, ...item
    }) => ({
      id: _id.toHexString(), ...item,
      ...(principal.tenantType === "PLATFORM" ? {
        cpoPrice: cpoPrice ?? laborPrice ?? null,
        laborPrice: cpoPrice ?? laborPrice ?? null,
        pricingRuleId: pricingRuleId ?? null,
      } : {}),
      ...(principal.tenantType === "CPO" ? { cpoPrice: cpoPrice ?? laborPrice ?? null } : {}),
    })).toArray();
  }

  public async createRequest(principal: AuthPrincipal, input: { jobId: string; type: string; description: string; clientOperationId?: string }): Promise<{ id: string }> {
    const fieldManagement = ["CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"].includes(principal.role);
    if (principal.tenantType !== "CONTRACTOR" || (principal.role !== "FIELD_WORKER" && !fieldManagement)) {
      throw new AppError(403, "FIELD_TEAM_REQUIRED", "Ek tedarik talebini yalnız saha personeli veya saha yönetimi açabilir.", false);
    }
    const type = input.type?.trim().toUpperCase() ?? "";
    if (!ADDITIONAL_SUPPLY_TYPES.has(type) || !input.description?.trim() || input.description.trim().length > 1000) {
      throw new AppError(400, "ADDITIONAL_SUPPLY_INVALID", "Ek tedarik türünü ve açıklamasını kontrol edin.", false);
    }
    const { db, jobId, job } = await this.authorizedJob(principal, input.jobId);
    if (!["ASSIGNED", "IN_PROGRESS", "ADDITIONAL_SUPPLY"].includes(String(job.status))) {
      throw new AppError(409, "ADDITIONAL_SUPPLY_JOB_STATUS_INVALID", "Bu iş aşamasında yeni ek tedarik talebi açılamaz.", false);
    }
    if (input.clientOperationId) {
      const existing = await db.collection("additionalRequests").findOne({ clientOperationId: input.clientOperationId, createdByUserId: new ObjectId(principal.userId) });
      if (existing?._id) return { id: existing._id.toHexString() };
    }
    const now = new Date();
    const result = await db.collection("additionalRequests").insertOne({
      jobId, type, description: input.description.trim(),
      cpoPrice: null, currency: "TRY", status: "PENDING_PRICING", partSupplyStatus: "PENDING_PRICING",
      statusHistory: [{ status: "PENDING_PRICING", note: "Bakımnerde fiyatlandırması bekleniyor.", actorUserId: new ObjectId(principal.userId), createdAt: now }],
      createdByUserId: new ObjectId(principal.userId), ...(input.clientOperationId ? { clientOperationId: input.clientOperationId } : {}), createdAt: now, updatedAt: now,
    });
    return { id: result.insertedId.toHexString() };
  }

  public async priceRequest(principal: AuthPrincipal, input: { id: string; cpoPrice: number; note?: string }): Promise<{ id: string; status: string }> {
    if (principal.tenantType !== "PLATFORM") {
      throw new AppError(403, "ADDITIONAL_REQUEST_PRICING_FORBIDDEN", "Ek tedarik fiyatlandırmasını yalnız Bakımnerde yapabilir.", false);
    }
    const cpoPrice = Number(input.cpoPrice);
    if (!Number.isFinite(cpoPrice) || cpoPrice <= 0) {
      throw new AppError(400, "ADDITIONAL_REQUEST_PRICE_INVALID", "CPO için geçerli bir ek tedarik ücreti girin.", false);
    }
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const request = await db.collection("additionalRequests").findOne({ _id: id });
    if (request === null) throw new AppError(404, "ADDITIONAL_REQUEST_NOT_FOUND", "Ek tedarik talebi bulunamadı.", false);
    await this.authorizedJob(principal, request.jobId.toHexString());
    if (["SUPPLY_IN_PROGRESS", "DELAYED", "SUPPLIED"].includes(String(request.partSupplyStatus))) {
      throw new AppError(409, "ADDITIONAL_REQUEST_ALREADY_STARTED", "Tedarik süreci başladıktan sonra talep yeniden fiyatlandırılamaz.", false);
    }
    const now = new Date();
    const update: Document = { $set: {
      cpoPrice, currency: "TRY", status: "AWAITING_CPO_DEADLINE", partSupplyStatus: "AWAITING_CPO_DEADLINE",
      pricingNote: input.note?.trim().slice(0, 1000) ?? "", pricedByUserId: new ObjectId(principal.userId),
      pricedAt: now, cpoVisibleAt: now, updatedAt: now,
    } };
    if (request.partSupplyStatus !== "AWAITING_CPO_DEADLINE") {
      update.$push = { statusHistory: { status: "AWAITING_CPO_DEADLINE", note: "CPO kesin tedarik tarihi bekleniyor.", actorUserId: new ObjectId(principal.userId), createdAt: now } };
    }
    await db.collection("additionalRequests").updateOne({ _id: id }, update);
    return { id: input.id, status: "AWAITING_CPO_DEADLINE" };
  }

  public async setRequestDeadline(principal: AuthPrincipal, input: { id: string; supplyDeadlineAt: string; note?: string }): Promise<{ id: string; status: string }> {
    if (principal.tenantType !== "CPO") {
      throw new AppError(403, "ADDITIONAL_REQUEST_DEADLINE_FORBIDDEN", "Kesin tedarik tarihini yalnız ilgili CPO bildirebilir.", false);
    }
    const supplyDeadlineAt = new Date(input.supplyDeadlineAt);
    if (Number.isNaN(supplyDeadlineAt.getTime()) || supplyDeadlineAt <= new Date()) {
      throw new AppError(400, "ADDITIONAL_REQUEST_DEADLINE_INVALID", "Gelecekte geçerli bir kesin tedarik tarihi girin.", false);
    }
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const request = await db.collection("additionalRequests").findOne({ _id: id });
    if (request === null) throw new AppError(404, "ADDITIONAL_REQUEST_NOT_FOUND", "Ek tedarik talebi bulunamadı.", false);
    const { jobId } = await this.authorizedJob(principal, request.jobId.toHexString());
    if (!request.cpoVisibleAt || Number(request.cpoPrice ?? request.laborPrice ?? 0) <= 0) {
      throw new AppError(409, "ADDITIONAL_REQUEST_NOT_PRICED", "Bakımnerde fiyatlandırması tamamlanmadan kesin tarih verilemez.", false);
    }
    if (request.partSupplyStatus === "SUPPLIED") {
      throw new AppError(409, "ADDITIONAL_REQUEST_ALREADY_SUPPLIED", "Temin edilmiş talep için tarih değiştirilemez.", false);
    }
    const now = new Date();
    const update: Document = { $set: {
      supplyDeadlineAt, deadlineNote: input.note?.trim().slice(0, 1000) ?? "", status: "SUPPLY_IN_PROGRESS",
      partSupplyStatus: "SUPPLY_IN_PROGRESS", deadlineProvidedByUserId: new ObjectId(principal.userId), deadlineProvidedAt: now, updatedAt: now,
    } };
    if (request.partSupplyStatus !== "SUPPLY_IN_PROGRESS") {
      update.$push = { statusHistory: { status: "SUPPLY_IN_PROGRESS", note: input.note?.trim().slice(0, 1000) || "Kesin tedarik tarihi CPO tarafından bildirildi.", actorUserId: new ObjectId(principal.userId), createdAt: now } };
    }
    await Promise.all([
      db.collection("additionalRequests").updateOne({ _id: id }, update),
      db.collection("jobs").updateOne({ _id: jobId }, { $set: { status: "ADDITIONAL_SUPPLY", additionalSupplyStartedAt: now, updatedAt: now } }),
    ]);
    return { id: input.id, status: "SUPPLY_IN_PROGRESS" };
  }

  public async updateRequest(principal: AuthPrincipal, input: { id: string; partSupplyStatus: string; note?: string }): Promise<{ id: string; status: string; unchanged?: true }> {
    if (principal.tenantType !== "PLATFORM" && principal.tenantType !== "CPO") {
      throw new AppError(403, "REQUEST_UPDATE_FORBIDDEN", "Ek talebi yalnız Bakımnerde veya ilgili CPO güncelleyebilir.", false);
    }
    const partSupplyStatus = input.partSupplyStatus?.trim().toUpperCase() ?? "";
    if (!MANUAL_SUPPLY_STATUSES.has(partSupplyStatus)) {
      throw new AppError(400, "ADDITIONAL_REQUEST_STATUS_INVALID", "Geçerli bir ek tedarik durumu seçin.", false);
    }
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const request = await db.collection("additionalRequests").findOne({ _id: id });
    if (request === null) throw new AppError(404, "ADDITIONAL_REQUEST_NOT_FOUND", "Ek işlem talebi bulunamadı.", false);
    await this.authorizedJob(principal, request.jobId.toHexString());
    if (principal.tenantType === "CPO" && !request.cpoVisibleAt) {
      throw new AppError(403, "ADDITIONAL_REQUEST_NOT_ASSIGNED_TO_CPO", "Bu ek tedarik talebi henüz CPO'ya aktarılmadı.", false);
    }
    if (request.partSupplyStatus === partSupplyStatus) return { id: input.id, status: partSupplyStatus, unchanged: true };
    if (!request.supplyDeadlineAt) {
      throw new AppError(409, "ADDITIONAL_REQUEST_DEADLINE_REQUIRED", "Manuel durum girmeden önce CPO kesin tedarik tarihini bildirmelidir.", false);
    }
    const suppliedNow = partSupplyStatus === "SUPPLIED";
    const now = new Date();
    const statusUpdate: Document = {
      $set: {
        status: partSupplyStatus, partSupplyStatus, restartRequired: suppliedNow,
        ...(suppliedNow ? { suppliedAt: now } : {}), updatedAt: now,
      },
      $push: { statusHistory: { status: partSupplyStatus, note: input.note?.trim().slice(0, 1000) ?? "", actorUserId: new ObjectId(principal.userId), createdAt: now } },
    };
    await db.collection("additionalRequests").updateOne({ _id: id, partSupplyStatus: { $ne: partSupplyStatus } }, statusUpdate);
    if (suppliedNow) {
      const unresolvedCount = await db.collection("additionalRequests").countDocuments({
        jobId: request.jobId, _id: { $ne: id }, partSupplyStatus: { $ne: "SUPPLIED" },
      });
      if (unresolvedCount === 0) {
        await db.collection("jobs").updateOne({ _id: request.jobId }, {
          $inc: { workflowCycle: 1 },
          $set: {
            status: "ASSIGNED", assignmentAt: now, assignmentAcceptanceDeadlineAt: new Date(now.getTime() + 86400000),
            contractorAcceptedAt: null, appointmentAt: null, outageNotificationSentAt: null, updatedAt: now,
          },
        });
      }
    }
    return { id: input.id, status: partSupplyStatus };
  }

  public async listMessages(principal: AuthPrincipal, jobIdValue: string): Promise<Document[]> {
    this.assertChatParticipant(principal);
    const { db, jobId } = await this.authorizedJob(principal, jobIdValue);
    return db.collection("messages").aggregate([
      { $match: { jobId } }, { $sort: { createdAt: 1 } },
      { $lookup: { from: "users", localField: "senderUserId", foreignField: "_id", as: "sender" } },
      { $lookup: { from: "tenants", localField: "senderTenantId", foreignField: "_id", as: "tenant" } },
      { $match: { "tenant.type": { $ne: "CPO" } } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, text: 1, createdAt: 1,
        senderName: { $first: "$sender.name" }, senderTenantName: { $first: "$tenant.name" },
        mine: { $eq: ["$senderUserId", new ObjectId(principal.userId)] },
      } },
    ]).toArray();
  }

  public async sendMessage(principal: AuthPrincipal, input: { jobId: string; text: string; clientOperationId?: string }): Promise<{ id: string }> {
    this.assertChatParticipant(principal);
    if (!input.text?.trim() || input.text.trim().length > 2000) throw new AppError(400, "MESSAGE_INVALID", "Mesaj 1-2000 karakter olmalıdır.", false);
    const { db, jobId, job } = await this.authorizedJob(principal, input.jobId);
    if (input.clientOperationId) {
      const existing = await db.collection("messages").findOne({ clientOperationId: input.clientOperationId, senderUserId: new ObjectId(principal.userId) });
      if (existing?._id) return { id: existing._id.toHexString() };
    }
    const result = await db.collection("messages").insertOne({
      jobId, text: input.text.trim(), senderUserId: new ObjectId(principal.userId),
      senderTenantId: new ObjectId(principal.tenantId), ...(input.clientOperationId ? { clientOperationId: input.clientOperationId } : {}), createdAt: new Date(),
    });
    await this.notifyJobParticipants(db, job, jobId, result.insertedId, principal);
    return { id: result.insertedId.toHexString() };
  }

  private async notifyJobParticipants(
    db: Awaited<ReturnType<MongoDatabase["db"]>>,
    job: Document,
    jobId: ObjectId,
    sourceMessageId: ObjectId,
    principal: AuthPrincipal,
  ): Promise<void> {
    const platformTenants = await db.collection("tenants")
      .find({ type: "PLATFORM", status: "ACTIVE" })
      .project({ _id: 1 })
      .toArray();
    const participantFilters: Document[] = [{
      tenantId: { $in: platformTenants.map((tenant) => tenant._id) },
      role: { $in: ["PLATFORM_OWNER", "PLATFORM_STAFF"] },
    }];
    if (job.contractorTenantId) {
      participantFilters.push({
        tenantId: job.contractorTenantId,
        role: { $in: ["CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"] },
      });
    }
    if (job.fieldWorkerUserId) participantFilters.push({ _id: job.fieldWorkerUserId, role: "FIELD_WORKER" });
    const users = await db.collection("users").find({
      status: "ACTIVE",
      _id: { $ne: new ObjectId(principal.userId) },
      $or: participantFilters,
    }).project({ _id: 1 }).toArray();
    if (users.length === 0) return;
    const createdAt = new Date();
    const jobNumber = String(job.jobNumber ?? jobId.toHexString());
    await db.collection("notifications").insertMany(users.map((user) => ({
      recipientUserId: user._id,
      type: "JOB_MESSAGE",
      title: "Yeni iş mesajı",
      body: `${jobNumber} kodlu iş ile ilgili yeni mesajınız var.`,
      jobId,
      jobNumber,
      sourceMessageId,
      readAt: null,
      createdAt,
    })));
  }

  private async authorizedJob(principal: AuthPrincipal, jobIdValue: string) {
    const jobId = this.objectId(jobIdValue);
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: jobId });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    const tenantId = new ObjectId(principal.tenantId);
    const allowed = principal.tenantType === "PLATFORM"
      || (principal.tenantType === "CPO" && job.cpoTenantId.equals(tenantId))
      || (principal.tenantType === "CONTRACTOR" && job.contractorTenantId?.equals(tenantId));
    if (!allowed) throw new AppError(403, "JOB_ACCESS_FORBIDDEN", "Bu işe erişim yetkiniz yok.", false);
    if (principal.role === "FIELD_WORKER" && !job.fieldWorkerUserId?.equals(new ObjectId(principal.userId))) {
      throw new AppError(403, "FIELD_WORKER_NOT_ASSIGNED", "Bu iş size atanmadı.", false);
    }
    return { db, jobId, job };
  }

  private validateFieldReport(input: FieldReportInput): void {
    const voltageValues = [input.inputVoltage, input.outputVoltage].filter((value) => value !== null && value !== undefined);
    const invalidVoltage = voltageValues.some((value) => !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 1000);
    if (!FIELD_REPORT_OPTIONS.serviceType.has(input.serviceType)
      || !FIELD_REPORT_OPTIONS.equipmentCondition.has(input.equipmentCondition)
      || !FIELD_REPORT_OPTIONS.faultCategory.has(input.faultCategory)
      || !FIELD_REPORT_OPTIONS.actionTaken.has(input.actionTaken)
      || !FIELD_REPORT_OPTIONS.safetyResult.has(input.safetyResult)
      || !input.notes?.trim()
      || input.notes.trim().length > 2000
      || invalidVoltage) {
      throw new AppError(400, "FIELD_REPORT_INVALID", "Saha formundaki seçim, ölçüm ve açıklama alanlarını kontrol edin.", false);
    }
  }

  private assertChatParticipant(principal: AuthPrincipal): void {
    if (principal.tenantType === "CPO") {
      throw new AppError(403, "JOB_CHAT_CPO_FORBIDDEN", "Saha iş sohbeti yalnız Bakımnerde ve taşeron ekibine açıktır.", false);
    }
  }

  private objectId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new AppError(400, "IDENTIFIER_INVALID", "Geçersiz kayıt kimliği.", false);
    return new ObjectId(value);
  }
}
