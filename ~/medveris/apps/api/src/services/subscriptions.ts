import { type Context, type Tx } from "~/db";
import { requireStaff } from "../auth/middleware.js";

export interface BillingScope {
  billingAccountId: string;
  access: BillingAccess | null;
  accountKind: string;
  accountName: string;
  activeSubscriptionId?: string;
}

export async function billingScope(c: Context<AppEnv>, tx: Tx): Promise<BillingScope> {
  const auth = requireStaff(c);
  const [access] = await tx`select app.billing_account_access(${auth.activeTenant!.id}) as access`;
  if (!access?.access) {
    throw new ForbiddenError("Billing management access is required for this workspace.");
  }
  const [row] = await tx`select billing_account_id from tenants where id = ${auth.activeTenant!.id}`;
  const [account] = await tx`select kind, name from billing_accounts where id = ${row?.billingAccountId}`;
  return {
    billingAccountId: String(row?.billingAccountId ?? ""),
    access: (access?.access as BillingAccess | null) ?? null,
    accountKind: String(account?.kind ?? "unknown"),
    accountName: String(account?.name ?? ""),
  };
}
