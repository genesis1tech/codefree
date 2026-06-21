import { Layer } from "effect"
import { HttpApiError, HttpApiMiddleware } from "effect/unstable/httpapi"

export class Authorization extends HttpApiMiddleware.Service<Authorization>()(
  "@opencode/ServerAuthorization",
  { error: HttpApiError.UnauthorizedNoContent },
) {}

export const authorizationLayer = Layer.succeed(Authorization)(Authorization.of((effect) => effect))
