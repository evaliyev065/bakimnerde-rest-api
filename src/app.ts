import express, { type Express } from "express";
import type { AppContainer } from "./bootstrap/container.js";
import type { AppConfig } from "./config/env.js";
import { registerCommerceRoutes } from "./modules/commerce/presentation/commerce.routes.js";
import { registerHealthRoutes } from "./modules/platform-health/presentation/health.routes.js";
import { registerIdentityRoutes } from "./modules/identity/presentation/identity.routes.js";
import { registerContractorRegistrationRoutes } from "./modules/identity/presentation/contractor-registration.routes.js";
import { registerUserManagementRoutes } from "./modules/identity/presentation/user-management.routes.js";
import { registerJobRoutes } from "./modules/operations/presentation/job.routes.js";
import { registerJobCollaborationRoutes } from "./modules/operations/presentation/job-collaboration.routes.js";
import { registerNotificationRoutes } from "./modules/operations/presentation/notification.routes.js";
import {
  errorHandler,
  notFoundHandler,
  rejectQueryString,
  rejectUnsupportedBusinessMethod
} from "./shared/http/error-handler.js";
import { requestContext } from "./shared/http/request-context.js";
import { RouteRegistry } from "./shared/http/route-registry.js";

export function createApp(config: AppConfig, container: AppContainer): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(requestContext(config));
  app.use((request, response, next) => {
    const allowedOrigins = config.corsOrigin.split(",").map((origin) => origin.trim()).filter(Boolean);
    const requestOrigin = request.headers.origin;
    if (requestOrigin && allowedOrigins.includes(requestOrigin)) {
      response.setHeader("access-control-allow-origin", requestOrigin);
      response.setHeader("vary", "Origin");
    }
    response.setHeader("access-control-allow-headers", "content-type, authorization, x-request-id, idempotency-key, x-api-version");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(rejectQueryString);
  app.use(express.json({ limit: "2mb", strict: true }));

  const routes = new RouteRegistry(app);
  registerHealthRoutes(routes, container.healthController);
  registerIdentityRoutes(routes, container.identityController, config, container.database);
  registerContractorRegistrationRoutes(routes, container.contractorRegistrationController, config, container.database);
  registerUserManagementRoutes(routes, container.userManagementController, config, container.database);
  registerCommerceRoutes(routes, container.commerceController, config, container.database);
  registerJobRoutes(routes, container.jobController, config, container.database);
  registerJobCollaborationRoutes(routes, container.jobCollaborationController, config, container.database);
  registerNotificationRoutes(routes, container.notificationController, config, container.database);

  app.use(rejectUnsupportedBusinessMethod);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
