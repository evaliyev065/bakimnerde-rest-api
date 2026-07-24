import { MongoClient, ObjectId } from "mongodb";
import { hashPassword } from "../src/modules/identity/infrastructure/password.js";

const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const databaseName = process.env.MONGODB_DATABASE ?? "bakimnerde";
const client = new MongoClient(uri);
const db = client.db(databaseName);
const now = new Date();

const collections = [
  "tenants", "users", "contractorProfiles", "cpoProfiles", "manufacturerProfiles",
  "jobs", "jobEvents", "jobMedia", "additionalRequests", "pricingRules",
  "wallets", "walletTransactions", "conversations", "messages", "auditLogs",
] as const;

for (const name of collections) {
  if (!(await db.listCollections({ name }).hasNext())) await db.createCollection(name);
}

await Promise.all([
  db.collection("tenants").createIndex({ tenantKey: 1 }, { unique: true }),
  db.collection("users").createIndex({ emailNormalized: 1 }, { unique: true }),
  db.collection("users").createIndex({ tenantId: 1, status: 1 }),
  db.collection("contractorProfiles").createIndex({ tenantId: 1 }, { unique: true }),
  db.collection("cpoProfiles").createIndex({ tenantId: 1 }, { unique: true }),
  db.collection("manufacturerProfiles").createIndex({ tenantId: 1 }, { unique: true }),
  db.collection("jobs").createIndex({ jobNumber: 1 }, { unique: true }),
  db.collection("jobs").createIndex({ cpoTenantId: 1, status: 1, createdAt: -1 }),
  db.collection("jobs").createIndex({ contractorTenantId: 1, status: 1, appointmentAt: 1 }),
  db.collection("jobEvents").createIndex({ jobId: 1, createdAt: 1 }),
  db.collection("jobMedia").createIndex({ jobId: 1, phase: 1 }),
  db.collection("additionalRequests").createIndex({ jobId: 1, status: 1 }),
  db.collection("pricingRules").createIndex({ ownerTenantId: 1, counterpartyTenantId: 1, itemCode: 1 }, { unique: true }),
  db.collection("wallets").createIndex({ tenantId: 1 }, { unique: true }),
  db.collection("walletTransactions").createIndex({ walletId: 1, createdAt: -1 }),
  db.collection("conversations").createIndex({ jobId: 1 }, { unique: true }),
  db.collection("messages").createIndex({ conversationId: 1, createdAt: 1 }),
  db.collection("auditLogs").createIndex({ tenantId: 1, createdAt: -1 }),
  db.collection("auditLogs").createIndex({ createdAt: 1 }, { expireAfterSeconds: 63072000 }),
]);

const tenantSeeds = [
  { tenantKey: "bakimnerde", name: "Bakımnerde Merkez", type: "PLATFORM", email: "admin@bakimnerde.com", phone: "0850 000 00 00" },
  { tenantKey: "voltera", name: "Voltera Şarj Teknolojileri", type: "MANUFACTURER", email: "yonetici@voltera.test", phone: "0216 555 10 10" },
  { tenantKey: "voltgo", name: "VoltGo Enerji", type: "CPO", email: "operasyon@voltgo.test", phone: "0212 555 20 20" },
  { tenantKey: "marmara-teknik", name: "Marmara Teknik", type: "CONTRACTOR", email: "yonetici@marmarateknik.test", phone: "0532 555 30 30" },
] as const;

const tenantIds = new Map<string, ObjectId>();
for (const seed of tenantSeeds) {
  const existing = await db.collection("tenants").findOneAndUpdate(
    { tenantKey: seed.tenantKey },
    { $set: { name: seed.name, type: seed.type, status: "ACTIVE", contact: { email: seed.email, phone: seed.phone }, updatedAt: now }, $setOnInsert: { commercialPolicy: {}, createdAt: now } },
    { upsert: true, returnDocument: "after" },
  );
  if (existing?._id === undefined) throw new Error(`Tenant oluşturulamadı: ${seed.tenantKey}`);
  tenantIds.set(seed.tenantKey, existing._id);
}

const password = process.env.DB_SEED_PASSWORD ?? "Bakimnerde!2026";
const users = [
  { tenantKey: "bakimnerde", email: "admin@bakimnerde.com", name: "Elif Arslan", role: "PLATFORM_ADMIN" },
  { tenantKey: "voltera", email: "yonetici@voltera.test", name: "Mert Yalçın", role: "MANUFACTURER_ADMIN" },
  { tenantKey: "voltgo", email: "operasyon@voltgo.test", name: "Melis Demir", role: "CPO_ADMIN" },
  { tenantKey: "marmara-teknik", email: "yonetici@marmarateknik.test", name: "Burak Yılmaz", role: "CONTRACTOR_ADMIN" },
] as const;

for (const user of users) {
  await db.collection("users").updateOne(
    { emailNormalized: user.email.toLocaleLowerCase("tr-TR") },
    { $set: { tenantId: tenantIds.get(user.tenantKey), email: user.email, name: user.name, role: user.role, status: "ACTIVE", updatedAt: now }, $setOnInsert: { passwordHash: hashPassword(password), createdAt: now } },
    { upsert: true },
  );
}

const platformId = tenantIds.get("bakimnerde")!;
const manufacturerId = tenantIds.get("voltera")!;
const cpoId = tenantIds.get("voltgo")!;
const contractorId = tenantIds.get("marmara-teknik")!;

await db.collection("manufacturerProfiles").updateOne({ tenantId: manufacturerId }, { $set: { tenantId: manufacturerId, brands: ["Voltera"], deviceModels: ["VX-180", "VX-360"], privatePolicy: { warrantyLaborApproval: true }, updatedAt: now } }, { upsert: true });
await db.collection("cpoProfiles").updateOne({ tenantId: cpoId }, { $set: { tenantId: cpoId, agreementType: "JOB_BASED", stationCount: 184, privatePolicy: { paymentTermDays: 14 }, updatedAt: now } }, { upsert: true });
await db.collection("contractorProfiles").updateOne({ tenantId: contractorId }, { $set: { tenantId: contractorId, serviceRegions: ["İstanbul", "Bursa", "Kocaeli"], availabilityDays: [1, 2, 3, 4, 5, 6], maintenanceBaseCost: 6500, contractApproval: { status: "APPROVED", approvedAt: now }, privatePolicy: { paymentTermDays: 7 }, updatedAt: now } }, { upsert: true });
await db.collection("wallets").updateOne({ tenantId: contractorId }, { $set: { tenantId: contractorId, type: "CLOSED", currency: "TRY", balance: 128400, blockedBalance: 17600, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
await db.collection("wallets").updateOne({ tenantId: cpoId }, { $set: { tenantId: cpoId, type: "CLOSED", currency: "TRY", balance: 420000, blockedBalance: 0, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });

await db.collection("jobs").updateOne({ jobNumber: "BN-2481" }, { $set: {
  jobNumber: "BN-2481", cpoTenantId: cpoId, manufacturerTenantId: manufacturerId, contractorTenantId: contractorId,
  station: { name: "İstanbul Havalimanı P3", city: "İstanbul" }, charger: { externalId: "TR-VGE-3482", model: "VX-180" },
  status: "ASSIGNED", publishDeadlineAt: new Date(now.getTime() + 8 * 86400000), appointmentAt: new Date(now.getTime() + 2 * 86400000),
  pricingSnapshot: { cpoPrice: 14800, contractorCost: 6500, currency: "TRY" }, evidencePolicy: { beforePhotoCount: 6, afterPhotoCount: 6, brandedPhotoCount: 1 },
  createdByTenantId: cpoId, updatedAt: now,
}, $setOnInsert: { _id: new ObjectId(), createdAt: now } }, { upsert: true });

await db.collection("pricingRules").updateOne(
  { ownerTenantId: platformId, counterpartyTenantId: contractorId, itemCode: "FAN-REPLACEMENT-LABOR" },
  { $set: { ownerTenantId: platformId, counterpartyTenantId: contractorId, itemCode: "FAN-REPLACEMENT-LABOR", itemName: "Fan değişimi işçiliği", cost: 5200, salePrice: 8000, currency: "TRY", visibleToCounterparty: false, active: true, updatedAt: now }, $setOnInsert: { createdAt: now } },
  { upsert: true },
);

console.log(`MongoDB hazır: ${databaseName}`);
console.log(`Test hesapları parolası: ${password}`);
for (const user of users) console.log(`${user.role}: ${user.email}`);
await client.close();
