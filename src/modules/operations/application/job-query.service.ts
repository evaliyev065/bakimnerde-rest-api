import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal } from "../../identity/domain/identity.types.js";

const JOB_STATUSES = new Set(["WAITING", "ASSIGNED", "IN_PROGRESS", "ADDITIONAL_SUPPLY", "MAINTENANCE_DONE", "MAINTENANCE_APPROVED", "CPO_APPROVAL", "PAID", "CLOSED"]);

interface JobInput {
  id?: string;
  cpoTenantId: string;
  contractorTenantId?: string;
  stationName: string;
  city: string;
  district: string;
  maintenanceTarget?: "DEVICE" | "STATION";
  stationMaintenanceArea?: "GENERAL_COMPONENTS" | "GRID_CONNECTION";
  chargerExternalId?: string;
  status?: string;
  appointmentAt?: string;
  givenDurationAt?: string;
  comment?: string;
  cpoPrice?: number | null;
  contractorCost?: number | null;
}

interface StationInput {
  cpoTenantId?: string;
  name: string;
  city: string;
  district: string;
}

interface ChargePointInput {
  cpoTenantId?: string;
  stationId: string;
  externalId: string;
}

export class JobQueryService {
  public constructor(private readonly database: MongoDatabase) {}

  public async list(principal: AuthPrincipal): Promise<Document[]> {
    const db = await this.database.db();
    const match = this.jobMatch(principal);
    return db.collection("jobs").aggregate([
      { $match: match }, { $sort: { createdAt: -1 } },
      { $lookup: { from: "tenants", localField: "cpoTenantId", foreignField: "_id", as: "cpo" } },
      { $lookup: { from: "tenants", localField: "contractorTenantId", foreignField: "_id", as: "contractor" } },
      { $lookup: { from: "users", localField: "fieldWorkerUserId", foreignField: "_id", as: "fieldWorker" } },
      { $project: this.jobProjection(principal) },
    ]).toArray();
  }

  public async detail(principal: AuthPrincipal, idValue: string): Promise<Document> {
    const id = this.objectId(idValue);
    const db = await this.database.db();
    const rows = await db.collection("jobs").aggregate([
      { $match: { _id: id, ...this.jobMatch(principal) } },
      { $lookup: { from: "tenants", localField: "cpoTenantId", foreignField: "_id", as: "cpo" } },
      { $lookup: { from: "tenants", localField: "contractorTenantId", foreignField: "_id", as: "contractor" } },
      { $lookup: { from: "users", localField: "fieldWorkerUserId", foreignField: "_id", as: "fieldWorker" } },
      { $project: this.jobProjection(principal) },
      { $limit: 1 },
    ]).toArray();
    if (rows[0] === undefined) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    return rows[0];
  }

  public async summary(principal: AuthPrincipal): Promise<{ total: number; active: number; byStatus: Record<string, number> }> {
    const db = await this.database.db();
    const rows = await db.collection("jobs").aggregate<{ _id: string; count: number }>([
      { $match: this.jobMatch(principal) },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]).toArray();
    const byStatus = Object.fromEntries(rows.map((row) => [row._id, row.count]));
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    return { total, active: total - Number(byStatus.CLOSED ?? 0), byStatus };
  }

  public async listChargePoints(principal: AuthPrincipal): Promise<Document[]> {
    const db = await this.database.db();
    const match: Document = principal.tenantType === "CPO"
      ? { cpoTenantId: new ObjectId(principal.tenantId), active: { $ne: false } }
      : { active: { $ne: false } };
    if (principal.tenantType === "CONTRACTOR") {
      const cpoIds = await db.collection("jobs").distinct("cpoTenantId", this.jobMatch(principal));
      match.cpoTenantId = { $in: cpoIds };
    }
    const stored = await db.collection("chargePoints").aggregate([
      { $match: match }, { $sort: { externalId: 1 } },
      { $project: {
        id: { $toString: "$_id" }, _id: 0, externalId: 1, station: 1,
        stationId: { $cond: [{ $ifNull: ["$stationId", false] }, { $toString: "$stationId" }, null] },
        cpoTenantId: { $toString: "$cpoTenantId" },
      } },
    ]).toArray();
    const snapshots = await db.collection("jobs").aggregate([
      { $match: { ...this.jobMatch(principal), "charger.externalId": { $type: "string" } } },
      { $project: {
        id: { $concat: ["job-snapshot-", { $toString: "$_id" }] }, _id: 0,
        externalId: "$charger.externalId", station: 1,
        stationId: { $cond: [{ $ifNull: ["$stationId", false] }, { $toString: "$stationId" }, null] },
        cpoTenantId: { $toString: "$cpoTenantId" },
      } },
    ]).toArray();
    return [...new Map([...snapshots, ...stored].map((item) => [`${item.cpoTenantId}:${item.externalId}`, item])).values()]
      .sort((left, right) => String(left.externalId).localeCompare(String(right.externalId), "tr"));
  }

  public async listStations(principal: AuthPrincipal): Promise<Document[]> {
    if (principal.tenantType === "CONTRACTOR") {
      throw new AppError(403, "STATION_LIST_FORBIDDEN", "İstasyon listesini görüntüleme yetkiniz yok.", false);
    }
    const db = await this.database.db();
    const stationMatch: Document = principal.tenantType === "CPO"
      ? { cpoTenantId: new ObjectId(principal.tenantId), active: { $ne: false } }
      : { active: { $ne: false } };
    const [devices, jobStations, storedStations] = await Promise.all([
      this.listChargePoints(principal),
      db.collection("jobs").aggregate([
        { $match: this.jobMatch(principal) },
        { $project: {
          _id: 0, cpoTenantId: { $toString: "$cpoTenantId" },
          name: "$station.name", city: "$station.city", district: { $ifNull: ["$station.district", ""] },
        } },
      ]).toArray(),
      db.collection("stations").aggregate([
        { $match: stationMatch },
        { $project: {
          id: { $toString: "$_id" }, _id: 0, cpoTenantId: { $toString: "$cpoTenantId" },
          name: 1, city: 1, district: 1,
        } },
      ]).toArray(),
    ]);
    const stations = new Map<string, Document>();
    for (const row of storedStations) {
      const key = `${row.cpoTenantId}:${this.stationKey(String(row.name), String(row.city), String(row.district))}`;
      stations.set(key, { ...row, deviceCount: 0 });
    }
    for (const row of jobStations) {
      const key = `${row.cpoTenantId}:${this.stationKey(String(row.name), String(row.city), String(row.district))}`;
      if (!stations.has(key)) stations.set(key, { id: key, cpoTenantId: row.cpoTenantId, name: row.name, city: row.city, district: row.district, deviceCount: 0 });
    }
    for (const device of devices) {
      const station = device.station as Document | undefined;
      if (!station?.name) continue;
      const key = `${device.cpoTenantId}:${this.stationKey(String(station.name), String(station.city), String(station.district ?? ""))}`;
      const current = stations.get(key);
      stations.set(key, {
        id: current?.id ?? key,
        cpoTenantId: device.cpoTenantId,
        name: station.name,
        city: station.city,
        district: station.district ?? "",
        deviceCount: Number(current?.deviceCount ?? 0) + 1,
      });
    }
    return [...stations.values()].sort((left, right) =>
      `${left.city} ${left.district} ${left.name}`.localeCompare(`${right.city} ${right.district} ${right.name}`, "tr"));
  }

  public async createStation(principal: AuthPrincipal, input: StationInput): Promise<{ id: string }> {
    this.assertAssetManager(principal);
    const name = input.name?.trim();
    const city = input.city?.trim();
    const district = input.district?.trim();
    if (!name || !city || !district || name.length > 240 || city.length > 100 || district.length > 100) {
      throw new AppError(400, "STATION_INPUT_INVALID", "İstasyon adı ve konum bilgilerini kontrol edin.", false);
    }
    const cpoTenantId = principal.tenantType === "CPO"
      ? new ObjectId(principal.tenantId)
      : this.objectId(input.cpoTenantId ?? "");
    const db = await this.database.db();
    await this.assertCpoTenant(db, cpoTenantId);
    const normalizedKey = this.stationKey(name, city, district);
    const now = new Date();
    try {
      const result = await db.collection("stations").insertOne({
        cpoTenantId, normalizedKey, name, city, district, active: true,
        createdByUserId: new ObjectId(principal.userId), createdAt: now, updatedAt: now,
      });
      return { id: result.insertedId.toHexString() };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 11000) {
        throw new AppError(409, "STATION_ALREADY_EXISTS", "Bu CPO için aynı istasyon zaten kayıtlı.", false);
      }
      throw error;
    }
  }

  public async createChargePoint(principal: AuthPrincipal, input: ChargePointInput): Promise<{ id: string }> {
    this.assertAssetManager(principal);
    const externalId = input.externalId?.trim().toUpperCase();
    if (!externalId || externalId.length > 160 || !input.stationId?.trim()) {
      throw new AppError(400, "CHARGE_POINT_INPUT_INVALID", "İstasyon ve cihaz kodunu kontrol edin.", false);
    }
    const db = await this.database.db();
    let station: Document | null = null;
    if (ObjectId.isValid(input.stationId)) {
      station = await db.collection("stations").findOne({ _id: new ObjectId(input.stationId), active: { $ne: false } });
    }
    if (station === null) {
      const legacy = (await this.listStations(principal)).find((item) => item.id === input.stationId);
      if (legacy) {
        const cpoTenantId = this.objectId(String(legacy.cpoTenantId));
        const normalizedKey = this.stationKey(String(legacy.name), String(legacy.city), String(legacy.district));
        station = await db.collection("stations").findOneAndUpdate(
          { cpoTenantId, normalizedKey },
          { $set: {
            cpoTenantId, normalizedKey, name: legacy.name, city: legacy.city, district: legacy.district,
            active: true, updatedAt: new Date(),
          }, $setOnInsert: { createdByUserId: new ObjectId(principal.userId), createdAt: new Date() } },
          { upsert: true, returnDocument: "after" },
        );
      }
    }
    if (station === null || station._id === undefined) {
      throw new AppError(404, "STATION_NOT_FOUND", "Cihazın bağlanacağı istasyon bulunamadı.", false);
    }
    const cpoTenantId = station.cpoTenantId as ObjectId;
    if (principal.tenantType === "CPO" && !cpoTenantId.equals(new ObjectId(principal.tenantId))) {
      throw new AppError(403, "STATION_ACCESS_FORBIDDEN", "Bu istasyon firmanıza ait değil.", false);
    }
    if (principal.tenantType === "PLATFORM" && input.cpoTenantId && !cpoTenantId.equals(this.objectId(input.cpoTenantId))) {
      throw new AppError(400, "STATION_CPO_MISMATCH", "İstasyon ve CPO firması eşleşmiyor.", false);
    }
    const now = new Date();
    try {
      const result = await db.collection("chargePoints").insertOne({
        cpoTenantId, stationId: station._id, externalId,
        station: { name: station.name, city: station.city, district: station.district },
        active: true, createdByUserId: new ObjectId(principal.userId), createdAt: now, updatedAt: now,
      });
      return { id: result.insertedId.toHexString() };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === 11000) {
        throw new AppError(409, "CHARGE_POINT_ALREADY_EXISTS", "Bu CPO için cihaz kodu zaten kayıtlı.", false);
      }
      throw error;
    }
  }

  public async listChargePointMaintenance(
    principal: AuthPrincipal,
    input: { cpoTenantId?: string; externalId?: string },
  ): Promise<Document[]> {
    if (principal.tenantType === "CONTRACTOR") {
      throw new AppError(403, "CHARGE_POINT_HISTORY_FORBIDDEN", "Cihaz bakım kayıtlarını görüntüleme yetkiniz yok.", false);
    }
    if (!input.cpoTenantId || !ObjectId.isValid(input.cpoTenantId) || !input.externalId?.trim()) {
      throw new AppError(400, "CHARGE_POINT_IDENTIFIER_INVALID", "Cihaz bilgilerini kontrol edin.", false);
    }
    if (principal.tenantType === "CPO" && principal.tenantId !== input.cpoTenantId) {
      throw new AppError(403, "CHARGE_POINT_HISTORY_FORBIDDEN", "Bu cihaz firmanıza ait değil.", false);
    }
    const db = await this.database.db();
    return db.collection("jobs").aggregate([
      { $match: {
        cpoTenantId: new ObjectId(input.cpoTenantId),
        "charger.externalId": input.externalId.trim(),
        maintenanceTarget: { $ne: "STATION" },
      } },
      { $sort: { createdAt: -1 } },
      { $limit: 100 },
      { $lookup: { from: "tenants", localField: "contractorTenantId", foreignField: "_id", as: "contractor" } },
      { $lookup: { from: "users", localField: "fieldWorkerUserId", foreignField: "_id", as: "fieldWorker" } },
      { $project: {
        documentId: { $toString: "$_id" }, _id: 0, id: "$jobNumber", status: 1,
        maintenanceTarget: { $ifNull: ["$maintenanceTarget", "DEVICE"] },
        station: "$station.name", city: "$station.city", district: "$station.district",
        appointmentAt: 1, maintenanceStartedAt: 1, createdAt: 1, updatedAt: 1,
        contractor: { $ifNull: [{ $first: "$contractor.name" }, "Atanmadı"] },
        fieldWorkerName: { $ifNull: [{ $first: "$fieldWorker.name" }, null] },
      } },
    ]).toArray();
  }

  public async listStationMaintenance(
    principal: AuthPrincipal,
    input: { cpoTenantId?: string; stationName?: string; city?: string; district?: string },
  ): Promise<Document[]> {
    if (principal.tenantType === "CONTRACTOR") {
      throw new AppError(403, "STATION_HISTORY_FORBIDDEN", "İstasyon bakım kayıtlarını görüntüleme yetkiniz yok.", false);
    }
    if (!input.cpoTenantId || !ObjectId.isValid(input.cpoTenantId) || !input.stationName?.trim() || !input.city?.trim() || !input.district?.trim()) {
      throw new AppError(400, "STATION_IDENTIFIER_INVALID", "İstasyon bilgilerini kontrol edin.", false);
    }
    if (principal.tenantType === "CPO" && principal.tenantId !== input.cpoTenantId) {
      throw new AppError(403, "STATION_HISTORY_FORBIDDEN", "Bu istasyon firmanıza ait değil.", false);
    }
    const db = await this.database.db();
    return db.collection("jobs").aggregate([
      { $match: {
        cpoTenantId: new ObjectId(input.cpoTenantId), maintenanceTarget: "STATION",
        "station.name": input.stationName.trim(), "station.city": input.city.trim(), "station.district": input.district.trim(),
      } },
      { $sort: { createdAt: -1 } }, { $limit: 100 },
      { $lookup: { from: "tenants", localField: "contractorTenantId", foreignField: "_id", as: "contractor" } },
      { $lookup: { from: "users", localField: "fieldWorkerUserId", foreignField: "_id", as: "fieldWorker" } },
      { $project: {
        documentId: { $toString: "$_id" }, _id: 0, id: "$jobNumber", status: 1,
        maintenanceTarget: { $literal: "STATION" }, stationMaintenanceArea: 1,
        station: "$station.name", city: "$station.city", district: "$station.district",
        appointmentAt: 1, maintenanceStartedAt: 1, createdAt: 1, updatedAt: 1,
        contractor: { $ifNull: [{ $first: "$contractor.name" }, "Atanmadı"] },
        fieldWorkerName: { $ifNull: [{ $first: "$fieldWorker.name" }, null] },
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
    if (job && ["MAINTENANCE_DONE", "MAINTENANCE_APPROVED", "CPO_APPROVAL", "PAID", "CLOSED"].includes(String(job.status))) {
      throw new AppError(409, "FIELD_WORKER_ASSIGNMENT_LOCKED", "Bakım tamamlandıktan sonra saha personeli değiştirilemez.", false);
    }
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
    if (principal.tenantType !== "CPO" || !["CPO_ADMIN", "CPO_STAFF"].includes(principal.role)) {
      throw new AppError(403, "JOB_CREATE_CPO_REQUIRED", "Bakım işini yalnız CPO yönetim hesapları oluşturabilir.", false);
    }
    this.validate(input);
    const db = await this.database.db();
    const sequence = await db.collection<{ _id: string; value: number }>("counters").findOneAndUpdate(
      { _id: "jobNumber" }, { $inc: { value: 1 } }, { upsert: true, returnDocument: "after" },
    );
    const jobNumber = `BN-${String(Number(sequence?.value ?? 2500)).padStart(4, "0")}`;
    const now = new Date();
    const id = new ObjectId();
    const cpoTenantId = new ObjectId(principal.tenantId);
    await this.assertTenantTypes(db, cpoTenantId, null);
    const givenDurationAt = this.futureDate(input.givenDurationAt, "GIVEN_DURATION_INVALID", "Gelecekte geçerli bir verilen süre seçin.");
    const contractorGivenDurationAt = this.contractorDeadline(now, givenDurationAt);
    const appointmentAt = this.optionalFutureDate(input.appointmentAt, "APPOINTMENT_INVALID", "Gelecekte geçerli bir randevu tarihi seçin.");
    if (appointmentAt && appointmentAt > givenDurationAt) {
      throw new AppError(400, "APPOINTMENT_AFTER_GIVEN_DURATION", "Randevu verilen sürenin dışında olamaz.", false);
    }
    const maintenanceTarget = this.maintenanceTarget(input);
    const asset = maintenanceTarget === "DEVICE" ? await this.resolveChargePoint(db, cpoTenantId, input) : null;
    const station = asset?.station ?? { name: input.stationName.trim(), city: input.city.trim(), district: input.district.trim() };
    const initialStatus = "WAITING";
    await db.collection("jobs").insertOne({
      _id: id, jobNumber, cpoTenantId, contractorTenantId: null, stationId: asset?.stationId ?? null,
      maintenanceTarget,
      stationMaintenanceArea: maintenanceTarget === "STATION" ? input.stationMaintenanceArea : null,
      station,
      charger: asset ? { externalId: asset.externalId } : null,
      status: initialStatus, publishedAt: now, givenDurationAt, contractorGivenDurationAt,
      assignmentAt: null, assignmentAcceptanceDeadlineAt: null,
      appointmentAt, comment: input.comment?.trim() ?? "",
      pricingSnapshot: {
        cpoPrice: null,
        contractorCost: null,
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
    if (current.maintenanceStartedAt || !["WAITING", "ASSIGNED"].includes(String(current.status))) {
      throw new AppError(409, "JOB_UPDATE_LOCKED", "Bakım başladıktan sonra işin temel parametreleri değiştirilemez.", false);
    }
    const cpoTenantId = this.objectId(input.cpoTenantId);
    const contractorTenantId = current.contractorTenantId as ObjectId | null ?? null;
    await this.assertTenantTypes(db, cpoTenantId, contractorTenantId);
    const appointmentAt = this.optionalFutureDate(input.appointmentAt, "APPOINTMENT_INVALID", "Gelecekte geçerli bir randevu tarihi seçin.");
    if (appointmentAt && current.givenDurationAt && appointmentAt > current.givenDurationAt) {
      throw new AppError(400, "APPOINTMENT_AFTER_GIVEN_DURATION", "Randevu verilen sürenin dışında olamaz.", false);
    }
    const maintenanceTarget = this.maintenanceTarget(input);
    const asset = maintenanceTarget === "DEVICE" ? await this.resolveChargePoint(db, cpoTenantId, input) : null;
    const station = asset?.station ?? { name: input.stationName.trim(), city: input.city.trim(), district: input.district.trim() };
    if (contractorTenantId) {
      const profile = await db.collection("contractorProfiles").findOne({ tenantId: contractorTenantId });
      const serviceRegions = Array.isArray(profile?.serviceRegions) ? profile.serviceRegions.map((item) => this.regionKey(String(item))) : [];
      if (!serviceRegions.includes(this.regionKey(String(station.city ?? "")))) {
        throw new AppError(409, "CONTRACTOR_REGION_UNSUPPORTED", "Atanmış teknik servis seçilen istasyon bölgesinde hizmet vermiyor; önce uygun bir atama yapın.", false);
      }
    }
    const result = await db.collection("jobs").updateOne({ _id: id }, { $set: {
      cpoTenantId,
      stationId: asset?.stationId ?? null,
      maintenanceTarget,
      stationMaintenanceArea: maintenanceTarget === "STATION" ? input.stationMaintenanceArea : null,
      station,
      charger: asset ? { externalId: asset.externalId } : null,
      appointmentAt, comment: input.comment?.trim() ?? "",
      pricingSnapshot: {
        cpoPrice: input.cpoPrice === null || input.cpoPrice === undefined ? null : Number(input.cpoPrice),
        contractorCost: input.contractorCost === null || input.contractorCost === undefined ? null : Number(input.contractorCost),
        currency: "TRY",
      },
      updatedAt: new Date(),
    }, $unset: { publishDeadlineAt: "" } });
    if (result.matchedCount === 0) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    await this.event(db, id, principal, "JOB_UPDATED", null);
    return { id: id.toHexString() };
  }

  public async assignContractor(
    principal: AuthPrincipal,
    input: { id: string; contractorTenantId: string; appointmentAt: string; cpoPrice: number; contractorCost: number },
  ): Promise<{ id: string; contractorTenantId: string; appointmentAt: Date }> {
    this.assertPlatform(principal);
    const id = this.objectId(input.id);
    const contractorTenantId = this.objectId(input.contractorTenantId);
    const appointmentAt = this.futureDate(input.appointmentAt, "APPOINTMENT_INVALID", "Gelecekte geçerli bir randevu tarihi seçin.");
    const cpoPrice = Number(input.cpoPrice);
    const contractorCost = Number(input.contractorCost);
    if (!Number.isFinite(cpoPrice) || cpoPrice <= 0 || !Number.isFinite(contractorCost) || contractorCost <= 0) {
      throw new AppError(400, "JOB_PRICING_INVALID", "CPO fiyatı ve teknik servis maliyeti sıfırdan büyük olmalıdır.", false);
    }
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (!['WAITING', 'ASSIGNED'].includes(String(job.status)) || job.maintenanceStartedAt) {
      throw new AppError(409, "JOB_ASSIGNMENT_LOCKED", "Başlamış veya tamamlanmış işin teknik servisi değiştirilemez.", false);
    }
    if (!(job.contractorGivenDurationAt instanceof Date) || job.contractorGivenDurationAt <= new Date()) {
      throw new AppError(409, "GIVEN_DURATION_REQUIRED", "CPO tarafından belirlenen geçerli süre olmadan atama yapılamaz.", false);
    }
    if (appointmentAt > job.contractorGivenDurationAt) {
      throw new AppError(400, "APPOINTMENT_AFTER_GIVEN_DURATION", "Randevu teknik servise gösterilen sürenin dışında olamaz.", false);
    }
    const contractor = await db.collection("tenants").findOne({ _id: contractorTenantId, type: "CONTRACTOR", status: "ACTIVE" });
    if (contractor === null) throw new AppError(400, "CONTRACTOR_INVALID", "Aktif bir teknik servis seçin.", false);
    const profile = await db.collection("contractorProfiles").findOne({ tenantId: contractorTenantId });
    const serviceRegions = Array.isArray(profile?.serviceRegions) ? profile.serviceRegions.map((item) => this.regionKey(String(item))) : [];
    if (!serviceRegions.includes(this.regionKey(String(job.station?.city ?? "")))) {
      throw new AppError(409, "CONTRACTOR_REGION_UNSUPPORTED", "Seçilen teknik servis istasyonun bulunduğu bölgede hizmet vermiyor.", false);
    }
    const now = new Date();
    await db.collection("jobs").updateOne({ _id: id }, { $set: {
      contractorTenantId, appointmentAt,
      pricingSnapshot: { cpoPrice, contractorCost, currency: "TRY" },
      status: "ASSIGNED", assignmentAt: now, assignmentAcceptanceDeadlineAt: new Date(now.getTime() + 86400000),
      contractorAcceptedAt: null, outageNotificationSentAt: null, fieldWorkerUserId: null,
      fieldWorkerAssignedAt: null, fieldWorkerAssignedByUserId: null, updatedAt: now,
    } });
    await this.event(db, id, principal, "CONTRACTOR_ASSIGNED", "ASSIGNED", String(contractor.name ?? ""));
    return { id: input.id, contractorTenantId: input.contractorTenantId, appointmentAt };
  }

  public async updateAppointment(
    principal: AuthPrincipal,
    input: { id: string; appointmentAt: string },
  ): Promise<{ id: string; appointmentAt: Date }> {
    const managerRoles = ["PLATFORM_OWNER", "PLATFORM_STAFF", "CPO_ADMIN", "CPO_STAFF", "CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"];
    if (!managerRoles.includes(principal.role)) {
      throw new AppError(403, "APPOINTMENT_UPDATE_FORBIDDEN", "Randevuyu yalnız yönetici hesapları değiştirebilir.", false);
    }
    const id = this.objectId(input.id);
    const appointmentAt = this.futureDate(input.appointmentAt, "APPOINTMENT_INVALID", "Gelecekte geçerli bir randevu tarihi seçin.");
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (job.maintenanceStartedAt || !["WAITING", "ASSIGNED"].includes(String(job.status))) {
      throw new AppError(409, "APPOINTMENT_UPDATE_LOCKED", "Bakım başladıktan sonra randevu değiştirilemez.", false);
    }
    const tenantId = new ObjectId(principal.tenantId);
    const ownsJob = principal.tenantType === "PLATFORM"
      || (principal.tenantType === "CPO" && job.cpoTenantId?.equals(tenantId))
      || (principal.tenantType === "CONTRACTOR" && job.contractorTenantId?.equals(tenantId));
    if (!ownsJob) throw new AppError(403, "JOB_ACCESS_FORBIDDEN", "Bu işe erişim yetkiniz yok.", false);
    const limit = principal.tenantType === "CONTRACTOR" ? job.contractorGivenDurationAt : job.givenDurationAt;
    if (!(limit instanceof Date) || appointmentAt > limit) {
      throw new AppError(400, "APPOINTMENT_AFTER_GIVEN_DURATION", "Randevu rolünüze tanımlanan verilen sürenin dışında olamaz.", false);
    }
    await db.collection("jobs").updateOne({ _id: id }, { $set: { appointmentAt, updatedAt: new Date() } });
    await this.event(db, id, principal, "JOB_APPOINTMENT_UPDATED", String(job.status), appointmentAt.toISOString());
    return { id: input.id, appointmentAt };
  }

  public async updateGivenDuration(
    principal: AuthPrincipal,
    input: { id: string; givenDurationAt: string },
  ): Promise<{ id: string; givenDurationAt: Date }> {
    if (principal.tenantType !== "CPO" || !["CPO_ADMIN", "CPO_STAFF"].includes(principal.role)) {
      throw new AppError(403, "GIVEN_DURATION_UPDATE_FORBIDDEN", "Verilen süreyi yalnız ilgili CPO değiştirebilir.", false);
    }
    const id = this.objectId(input.id);
    const givenDurationAt = this.futureDate(input.givenDurationAt, "GIVEN_DURATION_INVALID", "Gelecekte geçerli bir verilen süre seçin.");
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id, cpoTenantId: new ObjectId(principal.tenantId) });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (job.contractorTenantId || job.maintenanceStartedAt || job.status !== "WAITING") {
      throw new AppError(409, "GIVEN_DURATION_UPDATE_LOCKED", "Teknik servis atandıktan sonra verilen süre değiştirilemez.", false);
    }
    const anchor = job.publishedAt instanceof Date ? job.publishedAt : job.createdAt instanceof Date ? job.createdAt : new Date();
    if (givenDurationAt <= anchor) throw new AppError(400, "GIVEN_DURATION_INVALID", "Verilen süre iş başlangıcından sonra olmalıdır.", false);
    if (job.appointmentAt && job.appointmentAt > givenDurationAt) {
      throw new AppError(409, "APPOINTMENT_AFTER_GIVEN_DURATION", "Önce randevuyu verilen süre içine alın.", false);
    }
    await db.collection("jobs").updateOne({ _id: id }, { $set: {
      givenDurationAt, contractorGivenDurationAt: this.contractorDeadline(anchor, givenDurationAt), updatedAt: new Date(),
    } });
    await this.event(db, id, principal, "JOB_GIVEN_DURATION_UPDATED", String(job.status), givenDurationAt.toISOString());
    return { id: input.id, givenDurationAt };
  }

  public async reviewByCpo(
    principal: AuthPrincipal,
    input: { id: string; rating: number; feedback?: string },
  ): Promise<{ id: string; status: "CPO_APPROVAL"; rating: number }> {
    if (principal.tenantType !== "CPO" || !["CPO_ADMIN", "CPO_STAFF"].includes(principal.role)) {
      throw new AppError(403, "CPO_REVIEW_FORBIDDEN", "İşi yalnız ilgili CPO puanlayabilir.", false);
    }
    const rating = Number(input.rating);
    const feedback = input.feedback?.trim() ?? "";
    if (!Number.isInteger(rating) || rating < 1 || rating > 5 || feedback.length > 2000) {
      throw new AppError(400, "CPO_REVIEW_INVALID", "Puan 1-5 arasında tam sayı olmalı; geri bildirim 2000 karakteri aşmamalıdır.", false);
    }
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id, cpoTenantId: new ObjectId(principal.tenantId) });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (job.status === "CPO_APPROVAL" && job.cpoReview?.rating === rating) {
      return { id: input.id, status: "CPO_APPROVAL", rating };
    }
    if (job.status !== "MAINTENANCE_APPROVED") {
      throw new AppError(409, "CPO_REVIEW_NOT_READY", "Bakımnerde onayı tamamlanmadan iş puanlanamaz.", false);
    }
    const now = new Date();
    await db.collection("jobs").updateOne({ _id: id, status: "MAINTENANCE_APPROVED" }, { $set: {
      status: "CPO_APPROVAL", cpoApprovedAt: now,
      cpoReview: { rating, feedback, ratedByUserId: new ObjectId(principal.userId), ratedAt: now },
      updatedAt: now,
    } });
    await this.event(db, id, principal, "JOB_CPO_REVIEWED", "CPO_APPROVAL", `Puan: ${rating}`);
    return { id: input.id, status: "CPO_APPROVAL", rating };
  }

  public async changeStatus(principal: AuthPrincipal, input: { id: string; status: string; note?: string; clientOperationId?: string }): Promise<{ id: string; status: string }> {
    if (!JOB_STATUSES.has(input.status)) throw new AppError(400, "JOB_STATUS_INVALID", "Geçersiz iş durumu.", false);
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id });
    if (input.clientOperationId && job?.lastClientOperationId === input.clientOperationId && job.status === input.status) {
      return { id: input.id, status: input.status };
    }
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (principal.tenantType === "CPO") {
      throw new AppError(409, "CPO_REVIEW_REQUIRED", "CPO onayı için 1-5 yıldız puanlama zorunludur.", false);
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
      if (input.status === "IN_PROGRESS") {
        const cycle = Number(job.workflowCycle ?? 1);
        const beforeCount = await db.collection("jobMedia").countDocuments({ jobId: id, cycle, phase: "BEFORE" });
        if (beforeCount !== Number(job.evidencePolicy?.beforePhotoCount ?? 6)) {
          throw new AppError(409, "BEFORE_EVIDENCE_INCOMPLETE", "Bakıma başlamak için 6 bakım öncesi fotoğrafını yükleyin.", false);
        }
      }
      if (input.status === "MAINTENANCE_DONE") {
        if (job.status !== "IN_PROGRESS") throw new AppError(409, "JOB_TRANSITION_INVALID", "Bakım tamamlanmadan önce işlem başlatılmalıdır.", false);
        const unresolvedSupplyCount = await db.collection("additionalRequests").countDocuments({ jobId: id, partSupplyStatus: { $ne: "SUPPLIED" } });
        if (unresolvedSupplyCount > 0) {
          throw new AppError(409, "ADDITIONAL_SUPPLY_PENDING", "Ek tedarik gereksinimi tamamlanmadan bakım işi tamamlanamaz.", false);
        }
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
        || (job.status === "PAID" && input.status === "CLOSED");
      if (!allowedPlatformTransition) {
        throw new AppError(409, "JOB_TRANSITION_INVALID", "Seçilen durum mevcut iş aşamasından sonra gelemez.", false);
      }
    }
    const now = new Date();
    const statusFields: Document = { status: input.status, updatedAt: now };
    if (input.clientOperationId) statusFields.lastClientOperationId = input.clientOperationId;
    if (input.status === "IN_PROGRESS") {
      statusFields.maintenanceStartedAt = now;
      statusFields.maintenanceStartedByUserId = new ObjectId(principal.userId);
    }
    if (input.status === "MAINTENANCE_DONE") statusFields.maintenanceCompletedAt = now;
    if (input.status === "MAINTENANCE_APPROVED") statusFields.platformApprovedAt = now;
    if (input.status === "CLOSED") statusFields.closedAt = now;
    const result = await db.collection("jobs").updateOne({ _id: id }, { $set: statusFields });
    if (result.matchedCount === 0) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    await this.event(db, id, principal, "JOB_STATUS_CHANGED", input.status, input.note);
    return { id: input.id, status: input.status };
  }

  public async payCpoInvoice(principal: AuthPrincipal, input: { id: string }): Promise<{ id: string; status: "CPO_TO_PLATFORM_PAID" }> {
    if (principal.tenantType !== "CPO" || !["CPO_ADMIN", "CPO_STAFF"].includes(principal.role)) {
      throw new AppError(403, "CPO_PAYMENT_FORBIDDEN", "Bakımnerde ücretini yalnız ilgili CPO ödeyebilir.", false);
    }
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id, cpoTenantId: new ObjectId(principal.tenantId) });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (job.cpoToPlatformPaidAt) return { id: input.id, status: "CPO_TO_PLATFORM_PAID" };
    if (job.status !== "CPO_APPROVAL") throw new AppError(409, "CPO_PAYMENT_NOT_READY", "CPO onayı tamamlanmadan ödeme yapılamaz.", false);
    const quotedAmount = Number(job.pricingSnapshot?.cpoPrice ?? 0);
    if (quotedAmount <= 0) throw new AppError(409, "CPO_PRICE_REQUIRED", "Bakımnerde ücreti belirlenmeden ödeme yapılamaz.", false);
    const paymentKey = `CPO_TO_PLATFORM:${id.toHexString()}`;
    let amount = quotedAmount;
    const existingClaim = job.cpoPaymentClaim as Document | undefined;
    if (existingClaim?.key === paymentKey) {
      amount = Number(existingClaim.amount);
    } else {
      const claimedAt = new Date();
      const claimResult = await db.collection("jobs").updateOne({
        _id: id,
        cpoTenantId: new ObjectId(principal.tenantId),
        status: "CPO_APPROVAL",
        cpoToPlatformPaidAt: { $exists: false },
        cpoPaymentClaim: { $exists: false },
        "pricingSnapshot.cpoPrice": quotedAmount,
      }, { $set: {
        cpoPaymentClaim: { key: paymentKey, amount: quotedAmount, tenantId: job.cpoTenantId, state: "PROCESSING", claimedAt },
        updatedAt: claimedAt,
      } });
      if (claimResult.matchedCount === 0) {
        const latestJob = await db.collection("jobs").findOne({ _id: id, cpoTenantId: new ObjectId(principal.tenantId) });
        if (latestJob?.cpoToPlatformPaidAt) return { id: input.id, status: "CPO_TO_PLATFORM_PAID" };
        const latestClaim = latestJob?.cpoPaymentClaim as Document | undefined;
        if (latestClaim?.key !== paymentKey || Number(latestClaim.amount) <= 0) {
          throw new AppError(409, "CPO_PAYMENT_STATE_CHANGED", "Ödeme bilgileri değişti; işi yenileyip tekrar deneyin.", true);
        }
        amount = Number(latestClaim.amount);
      }
    }
    const wallet = await db.collection("wallets").findOne({ tenantId: job.cpoTenantId });
    if (wallet === null) throw new AppError(404, "WALLET_NOT_FOUND", "CPO cüzdanı bulunamadı.", false);
    const now = new Date();
    const walletUpdate = await db.collection("wallets").updateOne(
      { _id: wallet._id, $or: [
        { appliedPaymentKeys: paymentKey },
        { $expr: { $gte: [
          { $subtract: [{ $ifNull: ["$balance", 0] }, amount] },
          { $multiply: [-1, { $ifNull: ["$creditLimit", 0] }] },
        ] } },
      ] },
      [
        { $set: {
          balance: { $cond: [
            { $in: [paymentKey, { $ifNull: ["$appliedPaymentKeys", []] }] },
            { $ifNull: ["$balance", 0] },
            { $subtract: [{ $ifNull: ["$balance", 0] }, amount] },
          ] },
          appliedPaymentKeys: { $setUnion: [{ $ifNull: ["$appliedPaymentKeys", []] }, [paymentKey]] },
          updatedAt: now,
        } },
        { $set: { debtStatus: { $cond: [{ $lt: ["$balance", 0] }, "IN_DEBT", "CLEAR"] } } },
      ],
    );
    if (walletUpdate.matchedCount === 0) {
      throw new AppError(409, "CPO_CREDIT_LIMIT_EXCEEDED", "CPO bakiyesi ve borçlanma limiti bu ödeme için yetersiz.", false);
    }
    await db.collection("walletTransactions").updateOne(
      { jobId: id, type: "CPO_TO_PLATFORM_PAYMENT" },
      { $setOnInsert: {
        walletId: wallet._id, tenantId: job.cpoTenantId, jobId: id, type: "CPO_TO_PLATFORM_PAYMENT", paymentMethod: "WALLET",
        paymentKey, amount: -amount, direction: "DEBIT", currency: "TRY", description: `${job.jobNumber} Bakımnerde ödemesi`,
        createdByUserId: new ObjectId(principal.userId), createdAt: now,
      } },
      { upsert: true },
    );
    const finalized = await db.collection("jobs").updateOne(
      { _id: id, "cpoPaymentClaim.key": paymentKey, cpoToPlatformPaidAt: { $exists: false } },
      { $set: { cpoToPlatformPaidAt: now, cpoPaymentAmount: amount, cpoPaymentMethod: "WALLET", updatedAt: now }, $unset: { cpoPaymentClaim: "" } },
    );
    if (finalized.matchedCount === 0) {
      const latestJob = await db.collection("jobs").findOne({ _id: id });
      if (latestJob?.cpoToPlatformPaidAt) return { id: input.id, status: "CPO_TO_PLATFORM_PAID" };
      throw new AppError(409, "CPO_PAYMENT_FINALIZE_FAILED", "Ödeme kaydedildi ancak iş durumu tamamlanamadı; işlemi tekrar deneyin.", true);
    }
    await this.event(db, id, principal, "CPO_TO_PLATFORM_PAID", String(job.status));
    return { id: input.id, status: "CPO_TO_PLATFORM_PAID" };
  }

  public async payContractor(principal: AuthPrincipal, input: { id: string }): Promise<{ id: string; status: "PAID" }> {
    this.assertPlatform(principal);
    const id = this.objectId(input.id);
    const db = await this.database.db();
    const job = await db.collection("jobs").findOne({ _id: id });
    if (job === null) throw new AppError(404, "JOB_NOT_FOUND", "İş bulunamadı.", false);
    if (job.contractorPaidAt && job.status === "PAID") return { id: input.id, status: "PAID" };
    if (job.status !== "CPO_APPROVAL" || !job.cpoToPlatformPaidAt) {
      throw new AppError(409, "CONTRACTOR_PAYMENT_NOT_READY", "CPO ödemesi alınmadan teknik servis ödemesi yapılamaz.", false);
    }
    if (!job.contractorTenantId) throw new AppError(409, "CONTRACTOR_REQUIRED", "İşe atanmış teknik servis bulunamadı.", false);
    const quotedAmount = Number(job.pricingSnapshot?.contractorCost ?? 0);
    if (quotedAmount <= 0) throw new AppError(409, "CONTRACTOR_PRICE_REQUIRED", "Teknik servis ücreti belirlenmeden ödeme yapılamaz.", false);
    const paymentKey = `PLATFORM_TO_CONTRACTOR:${id.toHexString()}`;
    let amount = quotedAmount;
    let contractorTenantId = job.contractorTenantId as ObjectId;
    const existingClaim = job.contractorPaymentClaim as Document | undefined;
    if (existingClaim?.key === paymentKey) {
      amount = Number(existingClaim.amount);
      contractorTenantId = existingClaim.tenantId as ObjectId;
    } else {
      const claimedAt = new Date();
      const claimResult = await db.collection("jobs").updateOne({
        _id: id,
        status: "CPO_APPROVAL",
        cpoToPlatformPaidAt: { $type: "date" },
        contractorPaidAt: { $exists: false },
        contractorPaymentClaim: { $exists: false },
        contractorTenantId,
        "pricingSnapshot.contractorCost": quotedAmount,
      }, { $set: {
        contractorPaymentClaim: { key: paymentKey, amount: quotedAmount, tenantId: contractorTenantId, state: "PROCESSING", claimedAt },
        updatedAt: claimedAt,
      } });
      if (claimResult.matchedCount === 0) {
        const latestJob = await db.collection("jobs").findOne({ _id: id });
        if (latestJob?.contractorPaidAt && latestJob.status === "PAID") return { id: input.id, status: "PAID" };
        const latestClaim = latestJob?.contractorPaymentClaim as Document | undefined;
        if (latestClaim?.key !== paymentKey || Number(latestClaim.amount) <= 0 || !(latestClaim.tenantId instanceof ObjectId)) {
          throw new AppError(409, "CONTRACTOR_PAYMENT_STATE_CHANGED", "Teknik servis ödeme bilgileri değişti; işi yenileyip tekrar deneyin.", true);
        }
        amount = Number(latestClaim.amount);
        contractorTenantId = latestClaim.tenantId;
      }
    }
    const now = new Date();
    await db.collection("wallets").updateOne(
      { tenantId: contractorTenantId },
      { $setOnInsert: { tenantId: contractorTenantId, type: "CLOSED", currency: "TRY", balance: 0, blockedBalance: 0, creditLimit: 0, debtStatus: "CLEAR", createdAt: now, updatedAt: now } },
      { upsert: true },
    );
    const wallet = await db.collection("wallets").findOne({ tenantId: contractorTenantId });
    if (wallet === null) throw new AppError(404, "WALLET_NOT_FOUND", "Teknik servis cüzdanı bulunamadı.", true);
    const walletUpdate = await db.collection("wallets").updateOne(
      { _id: wallet._id },
      [
        { $set: {
          balance: { $cond: [
            { $in: [paymentKey, { $ifNull: ["$appliedPaymentKeys", []] }] },
            { $ifNull: ["$balance", 0] },
            { $add: [{ $ifNull: ["$balance", 0] }, amount] },
          ] },
          appliedPaymentKeys: { $setUnion: [{ $ifNull: ["$appliedPaymentKeys", []] }, [paymentKey]] },
          updatedAt: now,
        } },
      ],
    );
    if (walletUpdate.matchedCount === 0) throw new AppError(409, "CONTRACTOR_WALLET_UPDATE_FAILED", "Teknik servis cüzdanı güncellenemedi.", true);
    await db.collection("walletTransactions").updateOne(
      { jobId: id, type: "PLATFORM_TO_CONTRACTOR_PAYMENT" },
      { $setOnInsert: { walletId: wallet._id, tenantId: contractorTenantId, jobId: id, type: "PLATFORM_TO_CONTRACTOR_PAYMENT", paymentMethod: "WALLET", paymentKey, amount, direction: "CREDIT", currency: "TRY", description: `${job.jobNumber} teknik servis ödemesi`, createdByUserId: new ObjectId(principal.userId), createdAt: now } },
      { upsert: true },
    );
    const finalized = await db.collection("jobs").updateOne(
      { _id: id, "contractorPaymentClaim.key": paymentKey, contractorPaidAt: { $exists: false } },
      { $set: { status: "PAID", contractorPaidAt: now, contractorPaymentAmount: amount, updatedAt: now }, $unset: { contractorPaymentClaim: "" } },
    );
    if (finalized.matchedCount === 0) {
      const latestJob = await db.collection("jobs").findOne({ _id: id });
      if (latestJob?.contractorPaidAt && latestJob.status === "PAID") return { id: input.id, status: "PAID" };
      throw new AppError(409, "CONTRACTOR_PAYMENT_FINALIZE_FAILED", "Ödeme kaydedildi ancak iş durumu tamamlanamadı; işlemi tekrar deneyin.", true);
    }
    await this.event(db, id, principal, "PLATFORM_TO_CONTRACTOR_PAID", "PAID");
    return { id: input.id, status: "PAID" };
  }

  public async acceptAssignment(principal: AuthPrincipal, input: { id: string; appointmentAt: string }): Promise<{ id: string; appointmentAt: Date }> {
    if (principal.tenantType !== "CONTRACTOR" || !["CONTRACTOR_ADMIN", "CONTRACTOR_STAFF"].includes(principal.role)) {
      throw new AppError(403, "ASSIGNMENT_ACCEPT_FORBIDDEN", "Atamayı yalnız taşeron yönetim ekibi onaylayabilir.", false);
    }
    const id = this.objectId(input.id);
    const appointmentAt = this.futureDate(input.appointmentAt, "APPOINTMENT_INVALID", "Gelecekte geçerli bir randevu tarihi seçin.");
    const db = await this.database.db();
    const now = new Date();
    const job = await db.collection("jobs").findOne({
      _id: id, contractorTenantId: new ObjectId(principal.tenantId), status: "ASSIGNED",
      assignmentAcceptanceDeadlineAt: { $gte: now },
    });
    if (job === null) throw new AppError(409, "ASSIGNMENT_ACCEPTANCE_EXPIRED", "Atama bulunamadı veya bir günlük onay süresi doldu.", false);
    if (!(job.contractorGivenDurationAt instanceof Date) || appointmentAt > job.contractorGivenDurationAt) {
      throw new AppError(400, "APPOINTMENT_AFTER_GIVEN_DURATION", "Randevu teknik servise gösterilen sürenin dışında olamaz.", false);
    }
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

  private jobProjection(principal: AuthPrincipal): Document {
    const amountPath = principal.tenantType === "CONTRACTOR"
      ? "$pricingSnapshot.contractorCost"
      : "$pricingSnapshot.cpoPrice";
    return {
      documentId: { $toString: "$_id" }, _id: 0, id: "$jobNumber", station: "$station.name", city: "$station.city",
      district: { $ifNull: ["$station.district", ""] },
      maintenanceTarget: { $ifNull: ["$maintenanceTarget", "DEVICE"] },
      stationMaintenanceArea: { $ifNull: ["$stationMaintenanceArea", null] },
      charger: "$charger.externalId", status: 1, appointmentAt: 1, comment: { $ifNull: ["$comment", ""] },
      givenDurationAt: principal.tenantType === "CONTRACTOR"
        ? { $ifNull: ["$contractorGivenDurationAt", "$givenDurationAt"] }
        : "$givenDurationAt",
      ...(principal.tenantType === "CONTRACTOR" ? {} : { contractorGivenDurationAt: 1 }),
      assignmentAcceptanceDeadlineAt: 1, contractorAcceptedAt: 1, outageNotificationSentAt: 1,
      assignmentAt: 1, fieldWorkerAssignedAt: 1, maintenanceStartedAt: 1, maintenanceCompletedAt: 1,
      platformApprovedAt: 1, cpoApprovedAt: 1, cpoToPlatformPaidAt: 1, cpoPaymentMethod: 1, contractorPaidAt: 1, closedAt: 1,
      ...(principal.tenantType === "CONTRACTOR" ? {} : { cpoReview: 1 }),
      maintenanceStartedByUserId: { $cond: [{ $ifNull: ["$maintenanceStartedByUserId", false] }, { $toString: "$maintenanceStartedByUserId" }, null] },
      workflowCycle: { $ifNull: ["$workflowCycle", 1] },
      cpoTenantId: { $toString: "$cpoTenantId" },
      contractorTenantId: { $cond: [{ $ifNull: ["$contractorTenantId", false] }, { $toString: "$contractorTenantId" }, null] },
      fieldWorkerUserId: { $cond: [{ $ifNull: ["$fieldWorkerUserId", false] }, { $toString: "$fieldWorkerUserId" }, null] },
      fieldWorkerName: { $ifNull: [{ $first: "$fieldWorker.name" }, null] },
      fieldWorkerPhone: { $ifNull: [{ $first: "$fieldWorker.phone" }, null] },
      cpo: { $ifNull: [{ $first: "$cpo.name" }, "Wattarya"] },
      contractor: principal.tenantType === "PLATFORM"
        ? { $ifNull: [{ $first: "$contractor.name" }, "Atanmadı"] }
        : { $literal: "WattaryaTeknik" },
      amount: { $cond: [{ $gt: [{ $ifNull: [amountPath, 0] }, 0] }, amountPath, null] },
      contractorCost: principal.tenantType === "PLATFORM"
        ? { $cond: [{ $gt: [{ $ifNull: ["$pricingSnapshot.contractorCost", 0] }, 0] }, "$pricingSnapshot.contractorCost", null] }
        : { $literal: null },
    };
  }

  private validate(input: JobInput): void {
    const maintenanceTarget = this.maintenanceTarget(input);
    const deviceInvalid = maintenanceTarget === "DEVICE" && !input.chargerExternalId?.trim();
    const stationInvalid = maintenanceTarget === "STATION" && !["GENERAL_COMPONENTS", "GRID_CONNECTION"].includes(input.stationMaintenanceArea ?? "");
    if (!input.stationName?.trim() || !input.city?.trim() || !input.district?.trim() || deviceInvalid || stationInvalid
      || (input.comment !== undefined && input.comment.trim().length > 2000)
      || (input.cpoTenantId && !ObjectId.isValid(input.cpoTenantId))
      || (input.cpoPrice !== null && input.cpoPrice !== undefined && (!Number.isFinite(Number(input.cpoPrice)) || Number(input.cpoPrice) <= 0))
      || (input.contractorCost !== null && input.contractorCost !== undefined && (!Number.isFinite(Number(input.contractorCost)) || Number(input.contractorCost) <= 0))) {
      throw new AppError(400, "JOB_INPUT_INVALID", "İş, firma, cihaz, tarih ve fiyat alanlarını kontrol edin.", false);
    }
  }

  private maintenanceTarget(input: JobInput): "DEVICE" | "STATION" {
    if (input.maintenanceTarget === undefined || input.maintenanceTarget === "DEVICE") return "DEVICE";
    if (input.maintenanceTarget === "STATION") return "STATION";
    throw new AppError(400, "MAINTENANCE_TARGET_INVALID", "Bakım hedefini kontrol edin.", false);
  }

  private objectId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new AppError(400, "IDENTIFIER_INVALID", "Geçersiz kayıt kimliği.", false);
    return new ObjectId(value);
  }

  private assertPlatform(principal: AuthPrincipal): void {
    if (principal.tenantType !== "PLATFORM") throw new AppError(403, "PLATFORM_ACCESS_REQUIRED", "Bu işlem yalnız Bakımnerde personeline açıktır.", false);
  }

  private assertAssetManager(principal: AuthPrincipal): void {
    const allowed = principal.tenantType === "PLATFORM"
      ? ["PLATFORM_OWNER", "PLATFORM_STAFF"].includes(principal.role)
      : principal.tenantType === "CPO" && ["CPO_ADMIN", "CPO_STAFF"].includes(principal.role);
    if (!allowed) throw new AppError(403, "ASSET_MANAGEMENT_FORBIDDEN", "İstasyon ve cihaz yönetimi yalnız Bakımnerde ve CPO yönetimine açıktır.", false);
  }

  private jobMatch(principal: AuthPrincipal): Document {
    const tenantId = new ObjectId(principal.tenantId);
    if (principal.tenantType === "PLATFORM") return {};
    if (principal.tenantType === "CPO") return { cpoTenantId: tenantId };
    return principal.role === "FIELD_WORKER"
      ? { contractorTenantId: tenantId, fieldWorkerUserId: new ObjectId(principal.userId) }
      : { contractorTenantId: tenantId };
  }

  private async resolveChargePoint(
    db: Awaited<ReturnType<MongoDatabase["db"]>>,
    cpoTenantId: ObjectId,
    input: JobInput,
  ): Promise<{ externalId: string; stationId: ObjectId | null; station: { name: string; city: string; district: string } }> {
    const externalId = input.chargerExternalId!.trim().toUpperCase();
    const existing = await db.collection("chargePoints").findOne({ cpoTenantId, externalId });
    if (existing) {
      return {
        externalId: String(existing.externalId),
        stationId: existing.stationId instanceof ObjectId ? existing.stationId : null,
        station: {
          name: String(existing.station?.name ?? ""),
          city: String(existing.station?.city ?? ""),
          district: String(existing.station?.district ?? ""),
        },
      };
    }
    throw new AppError(404, "CHARGE_POINT_NOT_FOUND", "Cihaz kodu bulunamadı; önce Cihazlar ve İstasyonlar ekranından ekleyin.", false);
  }

  private futureDate(value: string | undefined, code: string, message: string): Date {
    const date = new Date(value ?? "");
    if (Number.isNaN(date.getTime()) || date <= new Date()) throw new AppError(400, code, message, false);
    return date;
  }

  private optionalFutureDate(value: string | undefined, code: string, message: string): Date | null {
    return value ? this.futureDate(value, code, message) : null;
  }

  private contractorDeadline(anchor: Date, givenDurationAt: Date): Date {
    return new Date(anchor.getTime() + Math.floor((givenDurationAt.getTime() - anchor.getTime()) * 0.75));
  }

  private stationKey(name: string, city: string, district: string): string {
    return [name, city, district].map((value) => value.trim().replace(/\s+/g, " ").toLocaleUpperCase("tr-TR")).join("|");
  }

  private regionKey(value: string): string {
    return value.trim().replace(/\s+/g, " ").toLocaleUpperCase("tr-TR");
  }

  private async assertCpoTenant(db: Awaited<ReturnType<MongoDatabase["db"]>>, id: ObjectId): Promise<void> {
    const tenant = await db.collection("tenants").findOne({ _id: id, type: "CPO", status: "ACTIVE" });
    if (tenant === null) throw new AppError(400, "CPO_TENANT_INVALID", "Aktif bir CPO firması seçin.", false);
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
