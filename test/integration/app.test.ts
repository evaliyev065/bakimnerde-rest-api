import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../../src/app.js";
import { createContainer } from "../../src/bootstrap/container.js";
import type { AppConfig } from "../../src/config/env.js";

const config: AppConfig = {
  environment: "test",
  host: "127.0.0.1",
  port: 3000,
  apiVersion: "1",
  logLevel: "silent"
};
const app = createApp(config, createContainer());

describe("health endpointleri", () => {
  it("liveness durumunu standart zarfla döndürür", async () => {
    const response = await request(app).get("/health-live").expect(200);
    expect(response.body.data).toEqual({ status: "alive", service: "bakimnerde-api" });
    expect(response.body.meta.apiVersion).toBe("1");
    expect(response.body.meta.requestId).toMatch(/^req_/);
    expect(response.headers["x-request-id"]).toBe(response.body.meta.requestId);
  });

  it("readiness kontrol kapsamını açıkça döndürür", async () => {
    const response = await request(app).get("/health-ready").expect(200);
    expect(response.body.data).toEqual({
      status: "ready",
      service: "bakimnerde-api",
      checks: { configuration: "ready" }
    });
  });

  it("güvenli istemci request ID değerini korur", async () => {
    const response = await request(app)
      .get("/health-live")
      .set("x-request-id", "manual-test-001")
      .expect(200);
    expect(response.body.meta.requestId).toBe("manual-test-001");
  });
});

describe("statik URL standardı", () => {
  it("query string kullanımını reddeder", async () => {
    const response = await request(app).get("/health-live?id=123").expect(400);
    expect(response.body.error.code).toBe("URL_PARAMETERS_NOT_ALLOWED");
  });

  it("nested bilinmeyen yolu standart hata zarfıyla reddeder", async () => {
    const response = await request(app).get("/health-live/extra").expect(404);
    expect(response.body.error.code).toBe("ENDPOINT_NOT_FOUND");
    expect(response.body.meta.requestId).toMatch(/^req_/);
  });

  it.each(["put", "patch", "delete"] as const)(
    "%s yöntemini açık 405 sözleşmesiyle reddeder",
    async (method) => {
      const response = await request(app)[method]("/health-live").send({ id: "forbidden" }).expect(405);
      expect(response.body.error.code).toBe("API_METHOD_NOT_ALLOWED");
      expect(response.headers.allow).toBe("GET, POST");
    }
  );
});
