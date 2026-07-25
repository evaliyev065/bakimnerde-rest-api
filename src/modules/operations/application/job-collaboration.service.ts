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
    return db.collection("jobMedia").find({ jobId, cycle }).sort({ createdAt: 1 }).map(({ _id, ...item }) => ({ id: _id.toHexString(), ...item })).toArray();
  }

  public async addEvidence(principal: AuthPrincipal, input: { jobId: string; phase: "BEFORE" | "AFTER" | "BRANDED"; url: string; description: string }): Promise<{ id: string }> {
    if (principal.role !== "FIELD_WORKER") throw new AppError(403, "FIELD_WORKER_REQUIRED", "Bakım kanıtını yalnız saha ekibi yükleyebilir.", false);
    const url = input.url?.trim() ?? "";
    const validUrl = url.startsWith("/") || url.startsWith("https://") || /^data:image\/(jpeg|png|webp);base64,/i.test(url);
    if (!["BEFORE", "AFTER", "BRANDED"].includes(input.phase) || !validUrl || url.length > 850_000) {
      throw new AppError(400, "EVIDENCE_INPUT_INVALID", "Kanıt aşaması ve dosya adresi gereklidir.", false);
    }
    const { db, jobId, job } = await this.authorizedJob(principal, input.jobId);
    const cycle = Number(job.workflowCycle ?? 1);
    const count = await db.collection("jobMedia").countDocuments({ jobId, cycle, phase: input.phase });
    const limit = input.phase === "BRANDED" ? 1 : 6;
    if (count >= limit) throw new AppError(409, "EVIDENCE_LIMIT_REACHED", `Bu aşama için en fazla ${limit} görsel yüklenebilir.`, false);
    const result = await db.collection("jobMedia").insertOne({
      jobId, cycle, phase: input.phase, url, description: input.description?.trim().slice(0, 300) ?? "",
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
    return db.collection("additionalRequests").find({ jobId }).sort({ createdAt: -1 }).map(({ _id, ...item }) => ({ id: _id.toHexString(), ...item })).toArray();
  }

  public async createRequest(principal: AuthPrincipal, input: { jobId: string; type: string; description: string; laborPrice?: number }): Promise<{ id: string }> {
    if (principal.tenantType !== "CONTRACTOR") throw new AppError(403, "CONTRACTOR_REQUEST_REQUIRED", "Ek işlem talebini taşeron ekibi açabilir.", false);
    const { db, jobId } = await this.authorizedJob(principal, input.jobId);
    const now = new Date();
    const result = await db.collection("additionalRequests").insertOne({
      jobId, type: input.type.trim().toUpperCase(), description: input.description.trim(),
      laborPrice: Number(input.laborPrice ?? (input.type.toUpperCase().includes("FAN") ? 8000 : 0)),
      currency: "TRY", status: "PART_SUPPLY_WAITING", partSupplyStatus: "WAITING",
      createdByUserId: new ObjectId(principal.userId), createdAt: now, updatedAt: now,
    });
    return { id: result.insertedId.toHexString() };
  }

  public async updateRequest(principal: AuthPrincipal, input: { id: string; status: string; partSupplyStatus: string }): Promise<{ id: string }> {
    if (principal.tenantType !== "PLATFORM" && principal.tenantType !== "CPO") {
      throw new AppError(403, "REQUEST_UPDATE_FORBIDDEN", "Ek talebi yalnız Bakımnerde veya ilgili CPO güncelleyebilir.", false);
    }
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const request = await db.collection("additionalRequests").findOne({ _id: id });
    if (request === null) throw new AppError(404, "ADDITIONAL_REQUEST_NOT_FOUND", "Ek işlem talebi bulunamadı.", false);
    await this.authorizedJob(principal, request.jobId.toHexString());
    const suppliedNow = request.partSupplyStatus !== "SUPPLIED" && input.partSupplyStatus === "SUPPLIED";
    await db.collection("additionalRequests").updateOne({ _id: id }, { $set: {
      status: input.status, partSupplyStatus: input.partSupplyStatus,
      restartRequired: suppliedNow, updatedAt: new Date(),
    } });
    if (suppliedNow) {
      const now = new Date();
      await db.collection("jobs").updateOne({ _id: request.jobId }, {
        $inc: { workflowCycle: 1 },
        $set: {
          status: "ASSIGNED", assignmentAt: now, assignmentAcceptanceDeadlineAt: new Date(now.getTime() + 86400000),
          contractorAcceptedAt: null, appointmentAt: null, outageNotificationSentAt: null, updatedAt: now,
        },
      });
    }
    return { id: input.id };
  }

  public async listMessages(principal: AuthPrincipal, jobIdValue: string): Promise<Document[]> {
    const { db, jobId } = await this.authorizedJob(principal, jobIdValue);
    return db.collection("messages").aggregate([
      { $match: { jobId } }, { $sort: { createdAt: 1 } },
      { $lookup: { from: "users", localField: "senderUserId", foreignField: "_id", as: "sender" } },
      { $lookup: { from: "tenants", localField: "senderTenantId", foreignField: "_id", as: "tenant" } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, text: 1, createdAt: 1,
        senderName: { $first: "$sender.name" }, senderTenantName: { $first: "$tenant.name" },
        mine: { $eq: ["$senderUserId", new ObjectId(principal.userId)] },
      } },
    ]).toArray();
  }

  public async sendMessage(principal: AuthPrincipal, input: { jobId: string; text: string }): Promise<{ id: string }> {
    if (!input.text?.trim() || input.text.trim().length > 2000) throw new AppError(400, "MESSAGE_INVALID", "Mesaj 1-2000 karakter olmalıdır.", false);
    const { db, jobId } = await this.authorizedJob(principal, input.jobId);
    const result = await db.collection("messages").insertOne({
      jobId, text: input.text.trim(), senderUserId: new ObjectId(principal.userId),
      senderTenantId: new ObjectId(principal.tenantId), createdAt: new Date(),
    });
    return { id: result.insertedId.toHexString() };
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

  private objectId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new AppError(400, "IDENTIFIER_INVALID", "Geçersiz kayıt kimliği.", false);
    return new ObjectId(value);
  }
}
