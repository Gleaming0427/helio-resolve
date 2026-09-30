import { DomainError } from "./DomainError.js";

/** The payment provider definitively refused a refund: retrying with the same key cannot succeed. */
export class RefundRejected extends DomainError {}
