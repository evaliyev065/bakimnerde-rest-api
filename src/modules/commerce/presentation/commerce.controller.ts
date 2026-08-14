import type { Request, Response } from "express";
import { success } from "../../../shared/http/response.js";
import type { ContextRequest } from "../../../shared/http/types.js";
import type { AuditService } from "../../identity/application/audit.service.js";
import type { AuthenticatedResponse } from "../../identity/presentation/auth.middleware.js";
import type { CommerceService } from "../application/commerce.service.js";

export class CommerceController {
  public constructor(private readonly service: CommerceService, private readonly audit: AuditService) {}

  public listPrices = this.query(() => "PRICES_LISTED", (principal) => this.service.listPrices(principal));
  public listWallets = this.query(() => "WALLETS_LISTED", (principal) => this.service.listWallets(principal));
  public listWalletTransactions = this.query(() => "WALLET_TRANSACTIONS_LISTED", (principal) => this.service.listWalletTransactions(principal));
  public walletTransactionDetail = async (request: Request, response: Response): Promise<void> => {
    const data = await this.service.walletTransactionDetail(
      (response as AuthenticatedResponse).locals.auth,
      (request.body as { id?: string }).id ?? "",
    );
    response.json(success(request as ContextRequest, data));
  };

  public createPrice = this.mutation("PRICE_CREATED", "pricingRule", async (request, principal) => this.service.createPrice(principal, request.body));
  public updatePrice = this.mutation("PRICE_UPDATED", "pricingRule", async (request, principal) => this.service.updatePrice(principal, request.body));
  public deletePrice = this.mutation("PRICE_DELETED", "pricingRule", async (request, principal) => this.service.deletePrice(principal, (request.body as { id?: string }).id ?? ""));
  public adjustWallet = this.mutation("WALLET_ADJUSTED", "walletTransaction", async (request, principal) => this.service.adjustWallet(principal, request.body));
  public updateCreditLimit = this.mutation("WALLET_CREDIT_LIMIT_UPDATED", "wallet", async (request, principal) => this.service.updateCreditLimit(principal, request.body));

  private query(_action: () => string, handler: (principal: AuthenticatedResponse["locals"]["auth"]) => Promise<unknown>) {
    return async (request: Request, response: Response): Promise<void> => {
      const data = await handler((response as AuthenticatedResponse).locals.auth);
      response.json(success(request as ContextRequest, data));
    };
  }

  private mutation(action: string, resourceType: string, handler: (request: Request, principal: AuthenticatedResponse["locals"]["auth"]) => Promise<Record<string, unknown>>) {
    return async (request: Request, response: Response): Promise<void> => {
      const principal = (response as AuthenticatedResponse).locals.auth;
      const data = await handler(request, principal);
      const resourceId = String(data.id ?? data.transactionId ?? "unknown");
      await this.audit.record({
        principal, action, resourceType, resourceId,
        requestId: (request as ContextRequest).context.requestId, ipAddress: request.ip ?? "unknown",
        payload: { request: request.body as Record<string, unknown> },
      });
      response.json(success(request as ContextRequest, data));
    };
  }
}
