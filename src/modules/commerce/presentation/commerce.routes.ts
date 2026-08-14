import type { AppConfig } from "../../../config/env.js";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import { authenticate } from "../../identity/presentation/auth.middleware.js";
import type { CommerceController } from "./commerce.controller.js";

export function registerCommerceRoutes(routes: RouteRegistry, controller: CommerceController, config: AppConfig, database: MongoDatabase): void {
  const auth = authenticate(config, database);
  routes.get("/pricing-list", auth, controller.listPrices);
  routes.post("/pricing-create", auth, controller.createPrice);
  routes.post("/pricing-update", auth, controller.updatePrice);
  routes.post("/pricing-delete", auth, controller.deletePrice);
  routes.get("/wallets-list", auth, controller.listWallets);
  routes.get("/wallet-transactions-list", auth, controller.listWalletTransactions);
  routes.post("/wallet-transaction-detail", auth, controller.walletTransactionDetail);
  routes.post("/wallet-adjust", auth, controller.adjustWallet);
  routes.post("/wallet-credit-limit", auth, controller.updateCreditLimit);
}
