import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal, TenantDocument, UserDocument } from "../domain/identity.types.js";
import { hashPassword } from "../infrastructure/password.js";

const PHONE_PATTERN = /^[1-9]\d{9}$/;
const TAX_NUMBER_PATTERN = /^\d{10}$/;
const SPECIALTIES = new Set([
  "PERIODIC_MAINTENANCE",
  "ELECTRICAL",
  "ELECTRONICS",
  "MECHANICAL",
  "SOFTWARE",
  "CHARGER_INSTALLATION",
]);

export interface ContractorRegistrationInput {
  companyName: string;
  taxNumber: string;
  tradeRegistryNumber: string;
  companyEmail: string;
  companyPhone: string;
  website?: string;
  authorizedName: string;
  authorizedTitle: string;
  authorizedEmail: string;
  authorizedPhone: string;
  password: string;
  city: string;
  district: string;
  address: string;
  serviceRegions: string[];
  specialties: string[];
  availabilityDays: number[];
  agreementAccepted: boolean;
}

interface ContractorApplicationDocument extends Omit<ContractorRegistrationInput, "password" | "agreementAccepted"> {
  _id?: ObjectId;
  applicationNumber: string;
  authorizedEmailNormalized: string;
  passwordHash: string;
  agreementAccepted: true;
  agreementVersion: string;
  agreementAcceptedAt: Date;
  sourceDomain: string;
  status: "PENDING" | "APPROVING" | "APPROVED" | "REJECTED";
  rejectionReason?: string;
  tenantId?: ObjectId;
  reviewedByUserId?: ObjectId;
  reviewedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export class ContractorRegistrationService {
  public constructor(private readonly database: MongoDatabase) {}

  public async submit(input: ContractorRegistrationInput): Promise<{ id: string; applicationNumber: string; status: "PENDING" }> {
    this.validate(input);
    const db = await this.database.db();
    const emailNormalized = input.authorizedEmail.trim().toLocaleLowerCase("tr-TR");
    const existingUser = await db.collection<UserDocument>("users").findOne({ emailNormalized });
    if (existingUser !== null) {
      throw new AppError(409, "CONTRACTOR_EMAIL_EXISTS", "Bu e-posta adresiyle kayıtlı bir hesap zaten bulunuyor.", false);
    }
    const duplicate = await db.collection<ContractorApplicationDocument>("contractorApplications").findOne({
      $or: [
        { authorizedEmailNormalized: emailNormalized },
        { taxNumber: input.taxNumber.trim() },
      ],
      status: { $in: ["PENDING", "APPROVING", "APPROVED"] },
    });
    if (duplicate !== null) {
      throw new AppError(409, "CONTRACTOR_APPLICATION_EXISTS", "Bu e-posta veya vergi numarasıyla daha önce başvuru yapılmış.", false);
    }

    const now = new Date();
    const id = new ObjectId();
    const applicationNumber = `TR-${now.getFullYear()}-${id.toHexString().slice(-6).toUpperCase()}`;
    await db.collection<ContractorApplicationDocument>("contractorApplications").insertOne({
      _id: id,
      applicationNumber,
      companyName: input.companyName.trim(),
      taxNumber: input.taxNumber.trim(),
      tradeRegistryNumber: input.tradeRegistryNumber.trim(),
      companyEmail: input.companyEmail.trim(),
      companyPhone: input.companyPhone.trim(),
      website: input.website?.trim() ?? "",
      authorizedName: input.authorizedName.trim(),
      authorizedTitle: input.authorizedTitle.trim(),
      authorizedEmail: input.authorizedEmail.trim(),
      authorizedEmailNormalized: emailNormalized,
      authorizedPhone: input.authorizedPhone.trim(),
      passwordHash: hashPassword(input.password),
      city: input.city.trim(),
      district: input.district.trim(),
      address: input.address.trim(),
      serviceRegions: [...new Set(input.serviceRegions.map((item) => item.trim()).filter(Boolean))],
      specialties: [...new Set(input.specialties)],
      availabilityDays: [...new Set(input.availabilityDays)].sort(),
      agreementAccepted: true,
      agreementVersion: "2026-07-24",
      agreementAcceptedAt: now,
      sourceDomain: "contractor-registrations.bakimnerde.com",
      status: "PENDING",
      createdAt: now,
      updatedAt: now,
    });
    return { id: id.toHexString(), applicationNumber, status: "PENDING" };
  }

  public async list(principal: AuthPrincipal): Promise<Document[]> {
    this.assertPlatform(principal);
    const db = await this.database.db();
    return db.collection<ContractorApplicationDocument>("contractorApplications").aggregate([
      { $sort: { createdAt: -1 } },
      { $project: {
        id: { $toString: "$_id" },
        _id: 0,
        applicationNumber: 1,
        companyName: 1,
        taxNumber: 1,
        tradeRegistryNumber: 1,
        companyEmail: 1,
        companyPhone: 1,
        website: 1,
        authorizedName: 1,
        authorizedTitle: 1,
        authorizedEmail: 1,
        authorizedPhone: 1,
        city: 1,
        district: 1,
        address: 1,
        serviceRegions: 1,
        specialties: 1,
        availabilityDays: 1,
        agreementAccepted: 1,
        agreementVersion: 1,
        agreementAcceptedAt: 1,
        status: 1,
        rejectionReason: 1,
        tenantId: { $cond: [{ $ifNull: ["$tenantId", false] }, { $toString: "$tenantId" }, null] },
        reviewedAt: 1,
        createdAt: 1,
      } },
    ]).toArray();
  }

  public async approve(principal: AuthPrincipal, idValue: string): Promise<{ id: string; tenantId: string; tenantKey: string; status: "APPROVED" }> {
    this.assertPlatform(principal);
    const id = this.objectId(idValue);
    const db = await this.database.db();
    const claimed = await db.collection<ContractorApplicationDocument>("contractorApplications").findOneAndUpdate(
      { _id: id, status: "PENDING" },
      { $set: { status: "APPROVING", updatedAt: new Date() } },
      { returnDocument: "after" },
    );
    if (claimed === null) {
      throw new AppError(409, "CONTRACTOR_APPLICATION_NOT_PENDING", "Başvuru bulunamadı veya daha önce sonuçlandırılmış.", false);
    }

    const now = new Date();
    const tenantId = new ObjectId();
    const tenantKey = await this.availableTenantKey(claimed.companyName);
    try {
      await db.collection<TenantDocument>("tenants").insertOne({
        _id: tenantId,
        tenantKey,
        name: claimed.companyName,
        type: "CONTRACTOR",
        status: "ACTIVE",
        operationalStatus: "ACTIVE",
        contact: { email: claimed.companyEmail, phone: claimed.companyPhone },
        commercialPolicy: {},
        createdAt: now,
        updatedAt: now,
      });
      await db.collection<UserDocument>("users").insertOne({
        _id: new ObjectId(),
        tenantId,
        email: claimed.authorizedEmail,
        emailNormalized: claimed.authorizedEmailNormalized,
        name: claimed.authorizedName,
        phone: claimed.authorizedPhone,
        passwordHash: claimed.passwordHash,
        role: "CONTRACTOR_ADMIN",
        status: "ACTIVE",
        createdAt: now,
        updatedAt: now,
      });
      await db.collection("contractorProfiles").insertOne({
        tenantId,
        taxNumber: claimed.taxNumber,
        tradeRegistryNumber: claimed.tradeRegistryNumber,
        website: claimed.website,
        authorizedTitle: claimed.authorizedTitle,
        address: { city: claimed.city, district: claimed.district, line: claimed.address },
        serviceRegions: claimed.serviceRegions,
        activityAreas: claimed.specialties,
        specialties: claimed.specialties,
        availabilityDays: claimed.availabilityDays,
        contractApproval: {
          status: "APPROVED",
          applicationId: id,
          agreementVersion: claimed.agreementVersion,
          acceptedAt: claimed.agreementAcceptedAt,
          approvedAt: now,
          approvedByUserId: new ObjectId(principal.userId),
        },
        createdAt: now,
        updatedAt: now,
      });
      await db.collection("wallets").insertOne({
        tenantId,
        type: "CLOSED",
        currency: "TRY",
        balance: 0,
        blockedBalance: 0,
        creditLimit: 0,
        debtStatus: "CLEAR",
        createdAt: now,
        updatedAt: now,
      });
      await db.collection<ContractorApplicationDocument>("contractorApplications").updateOne({ _id: id }, { $set: {
        status: "APPROVED",
        tenantId,
        reviewedByUserId: new ObjectId(principal.userId),
        reviewedAt: now,
        updatedAt: now,
      } });
    } catch (error) {
      await Promise.all([
        db.collection("tenants").deleteOne({ _id: tenantId }),
        db.collection("users").deleteMany({ tenantId }),
        db.collection("contractorProfiles").deleteMany({ tenantId }),
        db.collection("wallets").deleteMany({ tenantId }),
        db.collection<ContractorApplicationDocument>("contractorApplications").updateOne(
          { _id: id, status: "APPROVING" },
          { $set: { status: "PENDING", updatedAt: new Date() } },
        ),
      ]);
      if (error instanceof Error && "code" in error && error.code === 11000) {
        throw new AppError(409, "CONTRACTOR_APPROVAL_CONFLICT", "Firma anahtarı veya yönetici e-postası başka bir kayıtta kullanılıyor.", false);
      }
      throw error;
    }
    return { id: idValue, tenantId: tenantId.toHexString(), tenantKey, status: "APPROVED" };
  }

  public async reject(principal: AuthPrincipal, idValue: string, reason: string): Promise<{ id: string; status: "REJECTED" }> {
    this.assertPlatform(principal);
    if (!reason?.trim()) throw new AppError(400, "REJECTION_REASON_REQUIRED", "Ret nedeni zorunludur.", false);
    const id = this.objectId(idValue);
    const now = new Date();
    const db = await this.database.db();
    const result = await db.collection<ContractorApplicationDocument>("contractorApplications").updateOne(
      { _id: id, status: "PENDING" },
      { $set: {
        status: "REJECTED",
        rejectionReason: reason.trim(),
        reviewedByUserId: new ObjectId(principal.userId),
        reviewedAt: now,
        updatedAt: now,
      } },
    );
    if (result.matchedCount === 0) {
      throw new AppError(409, "CONTRACTOR_APPLICATION_NOT_PENDING", "Başvuru bulunamadı veya daha önce sonuçlandırılmış.", false);
    }
    return { id: idValue, status: "REJECTED" };
  }

  private validate(input: ContractorRegistrationInput): void {
    const required = [
      input.companyName,
      input.taxNumber,
      input.tradeRegistryNumber,
      input.companyEmail,
      input.companyPhone,
      input.authorizedName,
      input.authorizedTitle,
      input.authorizedEmail,
      input.authorizedPhone,
      input.city,
      input.district,
      input.address,
    ];
    if (required.some((value) => !value?.trim())
      || !input.companyEmail.includes("@")
      || !input.authorizedEmail.includes("@")
      || !PHONE_PATTERN.test(input.companyPhone)
      || !PHONE_PATTERN.test(input.authorizedPhone)
      || !TAX_NUMBER_PATTERN.test(input.taxNumber)
      || input.password?.length < 8
      || !Array.isArray(input.serviceRegions)
      || input.serviceRegions.length === 0
      || !Array.isArray(input.specialties)
      || input.specialties.length === 0
      || input.specialties.some((item) => !SPECIALTIES.has(item))
      || !Array.isArray(input.availabilityDays)
      || input.availabilityDays.length === 0
      || input.availabilityDays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
      || input.agreementAccepted !== true) {
      throw new AppError(400, "CONTRACTOR_APPLICATION_INVALID", "Başvuru alanlarını, telefonları ve sözleşme onayını kontrol edin.", false);
    }
  }

  private async availableTenantKey(companyName: string): Promise<string> {
    const db = await this.database.db();
    const base = companyName
      .trim()
      .toLocaleLowerCase("tr-TR")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ı/g, "i")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "taseron";
    let candidate = base;
    let suffix = 1;
    while (await db.collection<TenantDocument>("tenants").findOne({ tenantKey: candidate })) {
      suffix += 1;
      candidate = `${base.slice(0, 35)}-${suffix}`;
    }
    return candidate;
  }

  private assertPlatform(principal: AuthPrincipal): void {
    if (principal.tenantType !== "PLATFORM" || !principal.role.startsWith("PLATFORM_")) {
      throw new AppError(403, "PLATFORM_ACCESS_REQUIRED", "Bu işlem yalnız Bakımnerde personeline açıktır.", false);
    }
  }

  private objectId(value: string): ObjectId {
    if (!ObjectId.isValid(value)) throw new AppError(400, "IDENTIFIER_INVALID", "Geçersiz kayıt kimliği.", false);
    return new ObjectId(value);
  }
}
