import { Context } from "effect"

export interface CorsOptions {
  cors?: string[]
  origins?: string[]
  credentials?: boolean
  headers?: string[]
  methods?: string[]
}

export const CorsConfig = Context.Service<CorsOptions | undefined>("@opencode/CorsConfig")

function allowedOrigins(options?: CorsOptions): readonly string[] | undefined {
  return options?.cors ?? options?.origins
}

export function isAllowedCorsOrigin(origin: string | undefined, options?: CorsOptions): boolean {
  const allowed = allowedOrigins(options)
  if (!allowed?.length) return true
  if (!origin) return false
  return allowed.includes(origin)
}

export function isAllowedRequestOrigin(
  origin: string | undefined,
  _host: string | undefined,
  options?: CorsOptions,
): boolean {
  if (!origin) return true
  const allowed = allowedOrigins(options)
  if (!allowed?.length) return true
  return allowed.includes(origin)
}
