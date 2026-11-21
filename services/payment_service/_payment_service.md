# Payment Service

Placeholder, for later. Charges operators what `core/coordinator/runtime/billing.ts` computes and reports the outcomes back through `BillingRuntime.applyPaymentEvent` (`paymentSucceeded`, `paymentFailed`, `subscriptionCancelled`). Its interface goes into `core/protocol/interfaces/internal/` once a payment provider is chosen.
