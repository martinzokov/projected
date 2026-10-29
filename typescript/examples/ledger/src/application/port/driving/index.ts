import { defineContracts } from "@projected/application/event-sourced";
import { AccountBalance } from "./account-balance.js";
import { AccountStatement } from "./account-statement.js";
import { CloseAccount } from "./close-account.js";
import { DepositMoney } from "./deposit-money.js";
import { MakeTransfer } from "./make-transfer.js";
import { OpenAccount } from "./open-account.js";
import { TransferStatus } from "./transfer-status.js";
import { WithdrawMoney } from "./withdraw-money.js";

/** Every operation ledger offers. Signed-in callers only; staff and tellers need permissions as well. */
export const ledgerContracts = defineContracts({
  name: "ledger",
  access: "authenticated",
  commands: [OpenAccount, DepositMoney, WithdrawMoney, CloseAccount, MakeTransfer],
  queries: [AccountBalance, TransferStatus, AccountStatement],
});
