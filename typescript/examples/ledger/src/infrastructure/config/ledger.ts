import {
  aggregateRepository,
  createApplication,
  type CheckpointStore,
  type Clock,
  type DocumentStore,
  type EventHandler,
  type EventStore,
  type IdGenerator,
  type IdempotencyStore,
  type InfrastructureError,
  type ReadinessCheck,
  type SnapshotStore,
  type Telemetry,
} from "@projected/application/event-sourced";
import { ledgerContracts } from "../../application/port/driving/index.js";
import { accountBalance } from "../../application/usecase/account-balance.js";
import { accountStatement } from "../../application/usecase/account-statement.js";
import { closeAccount } from "../../application/usecase/close-account.js";
import { depositMoney } from "../../application/usecase/deposit-money.js";
import { makeTransfer } from "../../application/usecase/make-transfer.js";
import { openAccount } from "../../application/usecase/open-account.js";
import { statementProjection } from "../../application/usecase/statement-projection.js";
import { transferProcess } from "../../application/usecase/transfer-process.js";
import { transferStatus } from "../../application/usecase/transfer-status.js";
import { withdrawMoney } from "../../application/usecase/withdraw-money.js";
import { Account } from "../../domain/account/account.js";
import { Transfer } from "../../domain/transfer/transfer.js";
import { documentStatements } from "../adapter/driven/statements/document-statements.js";

/** Everything ledger needs from the outside world. Swap any of it without touching a use case. */
export interface LedgerInfrastructure {
  readonly eventStore: EventStore;
  /** Snapshots of long account streams. Without it, every load folds the whole stream. */
  readonly snapshots?: SnapshotStore;
  readonly checkpoints: CheckpointStore;
  /** Holds read models. */
  readonly documents: DocumentStore;
  /** Remembers command outcomes so retried commands never run twice. */
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly telemetry?: Telemetry;
  /** Further event handlers, e.g. a relay publishing events to a broker. */
  readonly eventHandlers?: readonly EventHandler[];
  /** What the service cannot serve without, reported by `GET /health/ready`. */
  readonly readiness?: readonly ReadinessCheck[];
  readonly onDefect?: (defect: Error) => void;
  /** An event handler the request path could not bring up to date; the poller retries it. */
  readonly onEventHandlingError?: (error: InfrastructureError, handler: string) => void;
}

/**
 * The composition root: binds every contract to its handler. Leaving a contract out, or binding
 * a handler to the wrong contract, does not compile.
 */
export function composeLedger(infrastructure: LedgerInfrastructure) {
  const { eventStore, checkpoints, idempotency, ids, clock, telemetry } = infrastructure;
  const repositoryOptions = { ...(telemetry === undefined ? {} : { telemetry }), ...(infrastructure.snapshots === undefined ? {} : { snapshots: infrastructure.snapshots }) };
  // A busy account sees transfers side by side (the transfer process's concurrency): each that
  // loses the race to its next version tries again on fresh state.
  const accounts = aggregateRepository(Account, eventStore, { ...repositoryOptions, maxAttempts: 10 });
  const transfers = aggregateRepository(Transfer, eventStore, repositoryOptions);
  const statements = documentStatements(infrastructure.documents);

  return createApplication(ledgerContracts, {
    ids,
    commands: {
      "open-account@1": openAccount({ accounts }),
      "deposit-money@1": depositMoney({ accounts }),
      "withdraw-money@1": withdrawMoney({ accounts }),
      "close-account@1": closeAccount({ accounts }),
      "make-transfer@1": makeTransfer({ transfers, clock }),
    },
    queries: {
      "account-balance@1": accountBalance({ accounts }),
      "transfer-status@1": transferStatus({ transfers }),
      "account-statement@1": accountStatement({ accounts, statements }),
    },
    eventHandling: {
      handlers: [transferProcess({ accounts, transfers }), statementProjection({ statements }), ...(infrastructure.eventHandlers ?? [])],
      store: eventStore,
      checkpoints,
      // Everything in the background (startPolling): a request waits for its own write alone.
      // Balances read the account itself, so they are never behind; statements follow within a poll.
      inline: false,
    },
    idempotency: { store: idempotency },
    readiness: infrastructure.readiness ?? [],
    ...(telemetry === undefined ? {} : { telemetry }),
    ...(infrastructure.onDefect === undefined ? {} : { onDefect: infrastructure.onDefect }),
    ...(infrastructure.onEventHandlingError === undefined ? {} : { onEventHandlingError: infrastructure.onEventHandlingError }),
  });
}
