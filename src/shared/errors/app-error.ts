export class AppError extends Error {
  public constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly details: ReadonlyArray<{ field: string; reason: string }> = []
  ) {
    super(message);
    this.name = "AppError";
  }
}
