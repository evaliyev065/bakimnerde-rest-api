import { ObjectId } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import type { AuditDocument, AuthPrincipal } from "../domain/identity.types.js";

export class AuditService {
  public constructor(private readonly database: MongoDatabase) {}

  public async record(input: {
    principal: AuthPrincipal;
    action: string;
    resourceType: string;
    resourceId: string;
    requestId: string;
    ipAddress: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    const db = await this.database.db();
    const document: AuditDocument = {
      tenantId: new ObjectId(input.principal.tenantId),
      actorUserId: new ObjectId(input.principal.userId),
      actorRole: input.principal.role,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId,
      requestId: input.requestId,
      ipAddress: input.ipAddress,
      payload: input.payload ?? {},
      createdAt: new Date(),
    };
    await db.collection<AuditDocument>("auditLogs").insertOne(document);
  }

  public async list(principal: AuthPrincipal): Promise<unknown[]> {
    const db = await this.database.db();
    const filter = principal.tenantType === "PLATFORM"
      ? {}
      : { tenantId: new ObjectId(principal.tenantId) };
    return db.collection<AuditDocument>("auditLogs")
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(100)
      .map(({ _id, ...item }) => ({ id: _id.toHexString(), ...item }))
      .toArray();
  }
}
