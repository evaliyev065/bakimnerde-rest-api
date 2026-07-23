const STATIC_ENDPOINT_PATTERN = /^\/[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function assertStaticEndpointPath(path: string): void {
  if (!STATIC_ENDPOINT_PATTERN.test(path)) {
    throw new Error(
      `Geçersiz API endpoint yolu: ${path}. Yalnız tek statik kebab-case segment kullanılabilir.`
    );
  }
}
