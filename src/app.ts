import express, { type Express } from "express";
import type { AppContainer } from "./bootstrap/container.js";
import type { AppConfig } from "./config/env.js";
import { registerCommerceRoutes } from "./modules/commerce/presentation/commerce.routes.js";
import { registerHealthRoutes } from "./modules/platform-health/presentation/health.routes.js";
import { registerIdentityRoutes } from "./modules/identity/presentation/identity.routes.js";
import { registerJobRoutes } from "./modules/operations/presentation/job.routes.js";
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
    response.setHeader("access-control-allow-origin", config.corsOrigin);
    response.setHeader("access-control-allow-headers", "content-type, authorization, x-request-id");
    response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    if (request.method === "OPTIONS") {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(rejectQueryString);
  app.use(express.json({ limit: "1mb", strict: true }));

  const routes = new RouteRegistry(app);
  registerHealthRoutes(routes, container.healthController);
  registerIdentityRoutes(routes, container.identityController, config);
  registerCommerceRoutes(routes, container.commerceController, config);
  registerJobRoutes(routes, container.jobController, config);

  app.use(rejectUnsupportedBusinessMethod);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
