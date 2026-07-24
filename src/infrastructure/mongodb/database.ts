import { Db, MongoClient } from "mongodb";
import type { AppConfig } from "../../config/env.js";

export class MongoDatabase {
  private readonly client: MongoClient;
  private connection: Promise<Db> | undefined;

  public constructor(private readonly config: AppConfig) {
    this.client = new MongoClient(config.mongodbUri);
  }

  public db(): Promise<Db> {
    this.connection ??= this.client.connect().then(() => this.client.db(this.config.mongodbDatabase));
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
