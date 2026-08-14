import type { AppConfig } from "../../../config/env.js";
import type { MongoDatabase } from "../../../infrastructure/mongodb/database.js";
import type { RouteRegistry } from "../../../shared/http/route-registry.js";
import { authenticate } from "../../identity/presentation/auth.middleware.js";
import type { NotificationController } from "./notification.controller.js";

export function registerNotificationRoutes(routes: RouteRegistry, controller: NotificationController, config: AppConfig, database: MongoDatabase): void {
  const auth = authenticate(config, database);
  routes.get("/notifications-list", auth, controller.list);
  routes.post("/notifications-read", auth, controller.markRead);
}
