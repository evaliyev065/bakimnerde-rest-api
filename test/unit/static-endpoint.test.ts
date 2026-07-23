import { describe, expect, it } from "vitest";
import { assertStaticEndpointPath } from "../../src/shared/http/static-endpoint.js";

describe("statik endpoint path doğrulayıcı", () => {
  it.each(["/user/123", "/user/:id", "/api/v1/user", "/user_get", "/UserGet"])(
    "yasak yolu engeller: %s",
    (path) => expect(() => assertStaticEndpointPath(path)).toThrow(/Geçersiz API endpoint yolu/)
  );

  it.each(["/user", "/user-get", "/health-live"])(
    "statik yolu kabul eder: %s",
    (path) => expect(() => assertStaticEndpointPath(path)).not.toThrow()
  );
});
