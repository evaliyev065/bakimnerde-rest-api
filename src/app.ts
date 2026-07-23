import express, { type Express } from "express";
import type { AppContainer } from "./bootstrap/container.js";
import type { AppConfig } from "./config/env.js";
import { registerHealthRoutes } from "./modules/platform-health/presentation/health.routes.js";
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
  app.use(rejectQueryString);
  app.use(express.json({ limit: "1mb", strict: true }));

  const routes = new RouteRegistry(app);
  registerHealthRoutes(routes, container.healthController);

  app.use(rejectUnsupportedBusinessMethod);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
