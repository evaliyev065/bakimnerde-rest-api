import type { ObjectId } from "mongodb";

export type TenantType = "PLATFORM" | "CPO" | "CONTRACTOR";
export type UserRole =
  | "PLATFORM_OWNER"
  | "PLATFORM_STAFF"
  | "CPO_ADMIN"
  | "CPO_STAFF"
  | "CONTRACTOR_ADMIN"
  | "CONTRACTOR_STAFF"
  | "FIELD_WORKER";

export interface TenantDocument {
  _id?: ObjectId;
  tenantKey: string;
  name: string;
  type: TenantType;
  immutable?: boolean;
  status: "ACTIVE" | "SUSPENDED";
  operationalStatus?: "ACTIVE" | "DEBT_BLOCKED";
  contact: { email: string; phone: string };
  commercialPolicy: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface UserDocument {
  _id?: ObjectId;
  tenantId: ObjectId;
  email: string;
  emailNormalized: string;
  name: string;
  phone?: string;
  passwordHash: string;
  role: UserRole;
  status: "ACTIVE" | "SUSPENDED";
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface AuthPrincipal {
  userId: string;
  tenantId: string;
  tenantKey: string;
  tenantName: string;
  tenantType: TenantType;
  name: string;
  email: string;
  role: UserRole;
}

export interface AuditDocument {
  tenantId: ObjectId;
  actorUserId: ObjectId;
  actorRole: UserRole;
  action: string;
  resourceType: string;
  resourceId: string;
  requestId: string;
  ipAddress: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}
