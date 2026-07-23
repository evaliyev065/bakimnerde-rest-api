import type { Express, RequestHandler } from "express";
import { assertStaticEndpointPath } from "./static-endpoint.js";

export class RouteRegistry {
  public constructor(private readonly app: Express) {}

  public get(path: string, ...handlers: RequestHandler[]): void {
    assertStaticEndpointPath(path);
    this.app.get(path, ...handlers);
  }

  public post(path: string, ...handlers: RequestHandler[]): void {
    assertStaticEndpointPath(path);
    this.app.post(path, ...handlers);
  }
}
