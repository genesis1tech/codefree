import { Context, Effect } from "effect"

export interface Interface {
  get: (input: { directory: string; cwd: string }) => Effect.Effect<Record<string, string>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PtyEnvironment") {}

export * as PtyEnvironment from "."
