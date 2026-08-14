import { Db, MongoClient } from "mongodb";
import type { AppConfig } from "../../config/env.js";

export class MongoDatabase {
  private readonly client: MongoClient;
  private connection: Promise<Db> | undefined;

  public constructor(private readonly config: AppConfig) {
    this.client = new MongoClient(config.mongodbUri);
  }

  public db(): Promise<Db> {
    this.connection ??= this.client.connect().then(async () => {
      const database = this.client.db(this.config.mongodbDatabase);
      await Promise.all([
        database.collection("notifications").createIndex({ recipientUserId: 1, readAt: 1, createdAt: -1 }),
        database.collection("notifications").createIndex({ jobId: 1, createdAt: -1 }),
        database.collection("jobs").createIndex({ cpoTenantId: 1, "charger.externalId": 1, createdAt: -1 }),
        database.collection("jobs").createIndex({ cpoTenantId: 1, maintenanceTarget: 1, "station.name": 1, "station.city": 1, "station.district": 1, createdAt: -1 }),
        database.collection("jobs").createIndex({ contractorTenantId: 1, fieldWorkerUserId: 1, status: 1 }),
        database.collection("jobs").createIndex({ cpoTenantId: 1, status: 1, givenDurationAt: 1 }),
        database.collection("stations").createIndex({ cpoTenantId: 1, normalizedKey: 1 }, { unique: true }),
        database.collection("chargePoints").createIndex({ cpoTenantId: 1, externalId: 1 }, { unique: true }),
        database.collection("chargePoints").createIndex({ cpoTenantId: 1, stationId: 1, active: 1 }),
        database.collection("additionalRequests").createIndex({ jobId: 1, partSupplyStatus: 1, createdAt: -1 }),
        database.collection("additionalRequests").createIndex({ jobId: 1, cpoVisibleAt: 1 }),
        database.collection("walletTransactions").createIndex(
          { jobId: 1, type: 1 },
          { unique: true, partialFilterExpression: { jobId: { $type: "objectId" }, type: { $type: "string" } } },
        ),
      ]);
      return database;
    });
    return this.connection;
  }

  public async ping(): Promise<void> {
    const database = await this.db();
    await database.command({ ping: 1 });
  }

  public async close(): Promise<void> {
    await this.client.close();
  }
}
