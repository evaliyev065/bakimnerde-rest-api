import { MongoClient, ObjectId } from "mongodb";
import { hashPassword } from "../src/modules/identity/infrastructure/password.js";

const uri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017";
const databaseName = process.env.MONGODB_DATABASE ?? "bakimnerde";
const client = new MongoClient(uri);
const db = client.db(databaseName);
const now = new Date();

const collections = [
  "tenants", "users", "contractorProfiles", "cpoProfiles", "jobs", "jobEvents", "jobMedia",
  "additionalRequests", "pricingRules", "wallets", "walletTransactions", "messages", "auditLogs", "counters",
  "contractorApplications",
] as const;
for (const name of collections) if (!(await db.listCollections({ name }).hasNext())) await db.createCollection(name);

await Promise.all([
  db.collection("tenants").createIndex({ tenantKey: 1 }, { unique: true }),
  db.collection("users").createIndex({ emailNormalized: 1 }, { unique: true }),
  db.collection("users").createIndex({ tenantId: 1, role: 1, status: 1 }),
  db.collection("contractorProfiles").createIndex({ tenantId: 1 }, { unique: true }),
  db.collection("cpoProfiles").createIndex({ tenantId: 1 }, { unique: true }),
  db.collection("jobs").createIndex({ jobNumber: 1 }, { unique: true }),
  db.collection("jobs").createIndex({ cpoTenantId: 1, status: 1, createdAt: -1 }),
  db.collection("jobs").createIndex({ contractorTenantId: 1, status: 1, appointmentAt: 1 }),
  db.collection("jobEvents").createIndex({ jobId: 1, createdAt: 1 }),
  db.collection("jobMedia").createIndex({ jobId: 1, cycle: 1, phase: 1, createdAt: 1 }),
  db.collection("additionalRequests").createIndex({ jobId: 1, status: 1 }),
  db.collection("pricingRules").createIndex({ ownerTenantId: 1, counterpartyTenantId: 1, itemCode: 1 }, { unique: true }),
  db.collection("wallets").createIndex({ tenantId: 1 }, { unique: true }),
  db.collection("walletTransactions").createIndex({ walletId: 1, createdAt: -1 }),
  db.collection("messages").createIndex({ jobId: 1, createdAt: 1 }),
  db.collection("auditLogs").createIndex({ tenantId: 1, createdAt: -1 }),
  db.collection("auditLogs").createIndex({ createdAt: 1 }, { expireAfterSeconds: 63072000 }),
  db.collection("contractorApplications").createIndex({ applicationNumber: 1 }, { unique: true }),
  db.collection("contractorApplications").createIndex({ status: 1, createdAt: -1 }),
  db.collection("contractorApplications").createIndex({ authorizedEmailNormalized: 1, status: 1 }),
]);

// Eski üretici rolü ve verileri yeni iş modelinde yoktur.
const oldManufacturers = await db.collection("tenants").find({ type: "MANUFACTURER" }).project<{ _id: ObjectId }>({ _id: 1 }).toArray();
const oldManufacturerIds = oldManufacturers.map(item => item._id);
if (oldManufacturerIds.length > 0) {
  await Promise.all([
    db.collection("users").deleteMany({ tenantId: { $in: oldManufacturerIds } }),
    db.collection("jobs").updateMany({ manufacturerTenantId: { $in: oldManufacturerIds } }, { $unset: { manufacturerTenantId: "" } }),
    db.collection("tenants").deleteMany({ _id: { $in: oldManufacturerIds } }),
  ]);
}
if (await db.listCollections({ name: "manufacturerProfiles" }).hasNext()) await db.collection("manufacturerProfiles").drop();

const tenantSeeds = [
  { tenantKey: "bakimnerde", name: "Bakımnerde", type: "PLATFORM", email: "admin@bakimnerde.com", phone: "8500000000", immutable: true },
  { tenantKey: "voltgo", name: "VoltGo Enerji", type: "CPO", email: "operasyon@voltgo.test", phone: "5325552020", immutable: false },
  { tenantKey: "marmara-teknik", name: "Marmara Teknik", type: "CONTRACTOR", email: "yonetici@marmarateknik.test", phone: "5325553030", immutable: false },
] as const;
const tenantIds = new Map<string, ObjectId>();
for (const seed of tenantSeeds) {
  const existing = await db.collection("tenants").findOneAndUpdate(
    { tenantKey: seed.tenantKey },
    { $set: { name: seed.name, type: seed.type, immutable: seed.immutable, status: "ACTIVE", contact: { email: seed.email, phone: seed.phone }, updatedAt: now }, $setOnInsert: { commercialPolicy: {}, createdAt: now } },
    { upsert: true, returnDocument: "after" },
  );
  if (existing?._id === undefined) throw new Error(`Tenant oluşturulamadı: ${seed.tenantKey}`);
  tenantIds.set(seed.tenantKey, existing._id);
}

const password = process.env.DB_SEED_PASSWORD ?? "Bakimnerde!2026";
const users = [
  { tenantKey: "bakimnerde", email: "admin@bakimnerde.com", name: "Bakımnerde Ana Hesap", role: "PLATFORM_OWNER", phone: "8500000001" },
  { tenantKey: "bakimnerde", email: "personel@bakimnerde.com", name: "Elif Arslan", role: "PLATFORM_STAFF", phone: "5320000001" },
  { tenantKey: "voltgo", email: "operasyon@voltgo.test", name: "Melis Demir", role: "CPO_ADMIN", phone: "5321110001" },
  { tenantKey: "voltgo", email: "personel@voltgo.test", name: "Cem Koç", role: "CPO_STAFF", phone: "5321110002" },
  { tenantKey: "marmara-teknik", email: "yonetici@marmarateknik.test", name: "Burak Yılmaz", role: "CONTRACTOR_ADMIN", phone: "5322220001" },
  { tenantKey: "marmara-teknik", email: "operasyon@marmarateknik.test", name: "Seda Özkan", role: "CONTRACTOR_STAFF", phone: "5322220002" },
  { tenantKey: "marmara-teknik", email: "saha@marmarateknik.test", name: "Ahmet Kaya", role: "FIELD_WORKER", phone: "5322220003" },
] as const;
for (const user of users) {
  await db.collection("users").updateOne(
    { emailNormalized: user.email.toLocaleLowerCase("tr-TR") },
    { $set: { tenantId: tenantIds.get(user.tenantKey), email: user.email, name: user.name, phone: user.phone, role: user.role, status: "ACTIVE", updatedAt: now }, $setOnInsert: { passwordHash: hashPassword(password), createdAt: now } },
    { upsert: true },
  );
}

const platformId = tenantIds.get("bakimnerde")!;
const cpoId = tenantIds.get("voltgo")!;
const contractorId = tenantIds.get("marmara-teknik")!;
await db.collection("cpoProfiles").updateOne({ tenantId: cpoId }, { $set: { tenantId: cpoId, agreementType: "JOB_BASED", stationCount: 184, privatePolicy: { paymentTermDays: 14 }, updatedAt: now } }, { upsert: true });
await db.collection("contractorProfiles").updateOne({ tenantId: contractorId }, { $set: { tenantId: contractorId, serviceRegions: ["İstanbul", "Bursa", "Kocaeli"], availabilityDays: [1, 2, 3, 4, 5, 6], maintenanceBaseCost: 6500, contractApproval: { status: "APPROVED", approvedAt: now, documentUrl: "/contracts/marmara-teknik.pdf" }, privatePolicy: { paymentTermDays: 7 }, updatedAt: now } }, { upsert: true });
await db.collection("wallets").updateOne({ tenantId: contractorId }, { $set: { tenantId: contractorId, type: "CLOSED", currency: "TRY", balance: 128400, blockedBalance: 17600, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });
await db.collection("wallets").updateOne({ tenantId: cpoId }, { $set: { tenantId: cpoId, type: "CLOSED", currency: "TRY", balance: 420000, blockedBalance: 0, updatedAt: now }, $setOnInsert: { createdAt: now } }, { upsert: true });

const sampleJobId = new ObjectId();
const sampleJob = await db.collection("jobs").findOneAndUpdate({ jobNumber: "BN-2481" }, { $set: {
  cpoTenantId: cpoId, contractorTenantId: contractorId,
  station: { name: "İstanbul Havalimanı P3", city: "İstanbul", district: "Arnavutköy" }, charger: { externalId: "TR-VGE-3482", model: "VX-180" },
  status: "ASSIGNED", publishedAt: new Date(now.getTime() - 2 * 86400000), publishDeadlineAt: new Date(now.getTime() + 12 * 86400000),
  assignmentAt: new Date(now.getTime() - 12 * 3600000), assignmentAcceptanceDeadlineAt: new Date(now.getTime() + 12 * 3600000),
  contractorAcceptedAt: new Date(now.getTime() - 10 * 3600000), appointmentAt: new Date(now.getTime() - 30 * 60000),
  outageNotificationSentAt: new Date(now.getTime() - 10 * 3600000),
  pricingSnapshot: { cpoPrice: 14800, contractorCost: 6500, currency: "TRY" },
  evidencePolicy: { beforePhotoCount: 6, afterPhotoCount: 6, brandedPhotoCount: 1 },
  workflowCycle: 1,
  createdByTenantId: cpoId, updatedAt: now,
}, $setOnInsert: { _id: sampleJobId, jobNumber: "BN-2481", createdAt: now } }, { upsert: true, returnDocument: "after" });
if (sampleJob?._id) {
  const fieldUser = await db.collection("users").findOne({ emailNormalized: "saha@marmarateknik.test" });
  await Promise.all([
    db.collection("jobMedia").deleteMany({ jobId: sampleJob._id }),
    db.collection("jobFieldReports").deleteMany({ jobId: sampleJob._id }),
  ]);
  if (fieldUser?._id) {
    await db.collection("jobs").updateOne({ _id: sampleJob._id }, { $set: {
      fieldWorkerUserId: fieldUser._id, fieldWorkerAssignedAt: new Date(now.getTime() - 8 * 3600000),
    } });
    await db.collection("jobMedia").insertMany([
      { jobId: sampleJob._id, cycle: 1, phase: "BEFORE", url: "/seed/bn-2481-before-1.jpg", description: "Cihaz genel görünüm", uploadedByUserId: fieldUser._id, uploadedByTenantId: contractorId, seed: true, createdAt: now },
      { jobId: sampleJob._id, cycle: 1, phase: "BEFORE", url: "/seed/bn-2481-before-2.jpg", description: "Ekran ve bağlantılar", uploadedByUserId: fieldUser._id, uploadedByTenantId: contractorId, seed: true, createdAt: now },
    ]);
  }
}

await db.collection("pricingRules").updateOne(
  { ownerTenantId: platformId, counterpartyTenantId: contractorId, itemCode: "FAN-REPLACEMENT-LABOR" },
  { $set: { ownerTenantId: platformId, counterpartyTenantId: contractorId, itemCode: "FAN-REPLACEMENT-LABOR", itemName: "Fan değişimi işçiliği", category: "Ek İşçilik", cost: 5200, salePrice: 8000, currency: "TRY", supplyType: "Parça hariç", visibleToCounterparty: false, active: true, updatedAt: now }, $setOnInsert: { createdAt: now } },
  { upsert: true },
);
await db.collection<{ _id: string; value: number }>("counters").updateOne({ _id: "jobNumber" }, { $max: { value: 2481 } }, { upsert: true });

console.log(`MongoDB hazır: ${databaseName}`);
console.log(`Ortak test parolası: ${password}`);
for (const user of users) console.log(`${user.role}: ${user.email}`);
await client.close();
