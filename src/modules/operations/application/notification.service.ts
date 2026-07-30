import { ObjectId, type Document } from "mongodb";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import { AppError } from "../../../shared/errors/app-error.js";
import type { AuthPrincipal } from "../../identity/domain/identity.types.js";

export interface NotificationListResult {
  items: Document[];
  unreadCount: number;
}

export class NotificationService {
  public constructor(private readonly database: MongoDatabase) {}

  public async list(principal: AuthPrincipal): Promise<NotificationListResult> {
    const db = await this.database.db();
    const recipientUserId = new ObjectId(principal.userId);
    const [items, unreadCount] = await Promise.all([
      db.collection("notifications").aggregate([
        { $match: { recipientUserId } },
        { $sort: { createdAt: -1 } },
        { $limit: 50 },
        { $project: {
          id: { $toString: "$_id" }, _id: 0, type: 1, title: 1, body: 1,
          jobId: { $toString: "$jobId" }, jobNumber: 1, createdAt: 1, readAt: 1,
        } },
      ]).toArray(),
      db.collection("notifications").countDocuments({ recipientUserId, readAt: null }),
    ]);
    return { items, unreadCount };
  }

  public async markRead(principal: AuthPrincipal, input: { id?: string }): Promise<{ id: string; read: true }> {
    if (!input.id || !ObjectId.isValid(input.id)) {
      throw new AppError(400, "NOTIFICATION_IDENTIFIER_INVALID", "Geçersiz bildirim kimliği.", false);
    }
    const result = await (await this.database.db()).collection("notifications").updateOne(
      { _id: new ObjectId(input.id), recipientUserId: new ObjectId(principal.userId) },
      { $set: { readAt: new Date() } },
    );
    if (result.matchedCount === 0) throw new AppError(404, "NOTIFICATION_NOT_FOUND", "Bildirim bulunamadı.", false);
    return { id: input.id, read: true };
  }
}
