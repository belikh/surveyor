// Node-side stub for the workerd-only `cloudflare:workers` module. Vitest
// aliases the specifier here (see vitest.config.ts) so the Worker entry and
// its tests share the same class shape: the real runtime supplies its own
// WorkflowEntrypoint, and this stub only has to store ctx/env.

export class WorkflowEntrypoint<Env = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  run(_event: unknown, _step: unknown): Promise<unknown> {
    throw new Error("WorkflowEntrypoint.run is provided by the workerd runtime");
  }
}
