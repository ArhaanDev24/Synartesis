/**
 * In-memory CRM standing in for a real external system.
 *
 * Behaviour is deterministic on purpose: Phase 4 asserts that a store is
 * byte-identical before a run and after undoing it, which is only meaningful
 * if ids and timestamps do not drift between runs.
 */

export const PLANS = ["free", "pro", "enterprise"] as const;
export type Plan = (typeof PLANS)[number];

export interface Customer {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly plan: Plan;
  readonly notes: string;
}

export interface SentEmail {
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  readonly sentAt: string;
}

export interface ToyCrmState {
  readonly customers: Readonly<Record<string, Customer>>;
  readonly outbox: readonly SentEmail[];
}

export interface CustomerDraft {
  readonly name: string;
  readonly email: string;
  readonly plan: Plan;
  readonly notes: string;
}

export type CustomerPatch = {
  readonly [K in keyof CustomerDraft]?: CustomerDraft[K] | undefined;
};

export interface ToyCrmOptions {
  /** Injected so tests can pin email timestamps. */
  readonly now?: () => string;
}

export class CustomerNotFoundError extends Error {
  constructor(public readonly customerId: string) {
    super(`no customer with id ${customerId}`);
    this.name = "CustomerNotFoundError";
  }
}

const SEED: readonly Customer[] = [
  { id: "c_001", name: "Ada Lovelace", email: "ada@example.com", plan: "pro", notes: "founding customer" },
  { id: "c_002", name: "Grace Hopper", email: "grace@example.com", plan: "enterprise", notes: "renewal in March" },
  { id: "c_003", name: "Alan Turing", email: "alan@example.com", plan: "free", notes: "" },
];

export class ToyCrmStore {
  readonly #customers = new Map<string, Customer>();
  #outbox: SentEmail[] = [];
  #nextId = SEED.length + 1;
  readonly #now: () => string;

  constructor(options: ToyCrmOptions = {}) {
    this.#now = options.now ?? ((): string => new Date().toISOString());
    for (const customer of SEED) {
      this.#customers.set(customer.id, customer);
    }
  }

  getCustomer(id: string): Customer {
    const customer = this.#customers.get(id);
    if (customer === undefined) {
      throw new CustomerNotFoundError(id);
    }
    return customer;
  }

  createCustomer(draft: CustomerDraft): Customer {
    // Ids are never recycled: a rolled-back delete followed by a fresh create
    // must not collide with the id the rollback restored.
    const id = `c_${String(this.#nextId).padStart(3, "0")}`;
    this.#nextId += 1;
    const customer: Customer = { id, ...draft };
    this.#customers.set(id, customer);
    return customer;
  }

  /**
   * Restores a customer under a caller-supplied id. This is what makes
   * delete_customer reversible; a plain create would allocate a new id and
   * leave every foreign key pointing at nothing.
   */
  restoreCustomer(customer: Customer): Customer {
    this.#customers.set(customer.id, customer);
    return customer;
  }

  updateCustomer(id: string, patch: CustomerPatch): Customer {
    const current = this.getCustomer(id);
    // Merged field by field rather than by spread: an absent optional arrives
    // over the wire as an explicit `undefined`, and spreading that would erase
    // the current value instead of leaving it untouched.
    const updated: Customer = {
      id: current.id,
      name: patch.name ?? current.name,
      email: patch.email ?? current.email,
      plan: patch.plan ?? current.plan,
      notes: patch.notes ?? current.notes,
    };
    this.#customers.set(id, updated);
    return updated;
  }

  deleteCustomer(id: string): Customer {
    const customer = this.getCustomer(id);
    this.#customers.delete(id);
    return customer;
  }

  sendEmail(to: string, subject: string, body: string): SentEmail {
    const email: SentEmail = { to, subject, body, sentAt: this.#now() };
    this.#outbox = [...this.#outbox, email];
    return email;
  }

  /**
   * Test helper: a detached deep copy of the whole store. Keys are sorted so
   * that two structurally equal stores also serialise identically, which is
   * what the Phase 4 rollback assertion actually compares.
   */
  __snapshot(): ToyCrmState {
    const ids = [...this.#customers.keys()].sort();
    return {
      customers: Object.fromEntries(ids.map((id) => [id, { ...this.getCustomer(id) }])),
      outbox: this.#outbox.map((email) => ({ ...email })),
    };
  }
}
