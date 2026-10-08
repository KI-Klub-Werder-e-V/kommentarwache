/**
 * A connector talks to one platform: it declares what it can do and does only that. The
 * actions engine asks for capabilities before planning and falls back to the human
 * queue when a wanted action does not exist on a platform.
 */

export type Capability =
  'poll' | 'webhook' | 'hide' | 'unhide' | 'delete' | 'ban' | 'unban' | 'hold' | 'approve';

export interface ActionTarget {
  /** the platform's id for the comment */
  platformCommentId: string;
  /** the platform's id for the author, when known */
  platformAuthorId: string | null;
  /** extra ids a platform needs, e.g. the post or thread; from the comment's context */
  threadRef: string | null;
}

export interface ActionResult {
  ok: boolean;
  /** what the platform answered, kept for the log */
  response?: Record<string, unknown>;
  error?: string;
}

export interface Connector {
  readonly kind: string;
  readonly capabilities: ReadonlySet<Capability>;
  /** seconds after posting during which deletion is still possible; undefined means always */
  readonly actionWindowSeconds?: number;
  hide?(target: ActionTarget): Promise<ActionResult>;
  unhide?(target: ActionTarget): Promise<ActionResult>;
  delete?(target: ActionTarget): Promise<ActionResult>;
  ban?(target: ActionTarget): Promise<ActionResult>;
  unban?(target: ActionTarget): Promise<ActionResult>;
}

/** Builds a connector instance for a connectors row, from its kind and decrypted config. */
export type ConnectorFactory = (row: {
  id: number;
  kind: string;
  name: string;
  config: Record<string, unknown>;
}) => Connector | undefined;

/**
 * An in-memory platform for tests and dry runs: remembers every call, can be told to
 * fail, and reports what is hidden or banned.
 */
export class FakeConnector implements Connector {
  readonly kind = 'fake';
  readonly capabilities: ReadonlySet<Capability>;
  readonly calls: Array<{ op: string; target: ActionTarget }> = [];
  readonly hidden = new Set<string>();
  readonly deleted = new Set<string>();
  readonly banned = new Set<string>();
  failNext: string | null = null;

  constructor(capabilities: Capability[] = ['hide', 'unhide', 'delete', 'ban', 'unban']) {
    this.capabilities = new Set(capabilities);
  }

  private record(op: string, target: ActionTarget, apply: () => void): ActionResult {
    this.calls.push({ op, target });
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      return { ok: false, error };
    }
    apply();
    return { ok: true, response: { op, id: target.platformCommentId } };
  }

  async hide(t: ActionTarget) {
    return this.record('hide', t, () => this.hidden.add(t.platformCommentId));
  }
  async unhide(t: ActionTarget) {
    return this.record('unhide', t, () => this.hidden.delete(t.platformCommentId));
  }
  async delete(t: ActionTarget) {
    return this.record('delete', t, () => this.deleted.add(t.platformCommentId));
  }
  async ban(t: ActionTarget) {
    return this.record('ban', t, () => this.banned.add(t.platformAuthorId ?? ''));
  }
  async unban(t: ActionTarget) {
    return this.record('unban', t, () => this.banned.delete(t.platformAuthorId ?? ''));
  }
}

/** Connector instances by connectors.id, built lazily from the factories for each kind. */
export class ConnectorRegistry {
  private readonly factories = new Map<string, ConnectorFactory>();
  private readonly instances = new Map<number, Connector>();

  register(kind: string, factory: ConnectorFactory): this {
    this.factories.set(kind, factory);
    return this;
  }

  /** a fixed instance, e.g. a FakeConnector in tests */
  set(connectorId: number, connector: Connector): this {
    this.instances.set(connectorId, connector);
    return this;
  }

  get(row: {
    id: number;
    kind: string;
    name: string;
    config: Record<string, unknown>;
  }): Connector | undefined {
    const known = this.instances.get(row.id);
    if (known) return known;
    const built = this.factories.get(row.kind)?.(row);
    if (built) this.instances.set(row.id, built);
    return built;
  }
}
