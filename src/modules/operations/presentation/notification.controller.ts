import type { Request, Response } from "express";
import { success } from "../../../shared/http/response.js";
import type { ContextRequest } from "../../../shared/http/types.js";
import type { AuthenticatedResponse } from "../../identity/presentation/auth.middleware.js";
import type { NotificationService } from "../application/notification.service.js";

export class NotificationController {
  public constructor(private readonly service: NotificationService) {}

  public list = async (request: Request, response: Response): Promise<void> => {
    const data = await this.service.list((response as AuthenticatedResponse).locals.auth);
    response.json(success(request as ContextRequest, data));
  };

  public markRead = async (request: Request, response: Response): Promise<void> => {
    const data = await this.service.markRead((response as AuthenticatedResponse).locals.auth, request.body);
    response.json(success(request as ContextRequest, data));
  };
}
