import type { Ctx } from "@rookery/sdk"
import { RookeryError } from "@rookery/sdk"

/** The signed-in person of a call, or FORBIDDEN: what changes things on GitHub is always someone's doing. */
export const needUser = (ctx: Ctx) => {
  if (!ctx.user) throw new RookeryError("FORBIDDEN", "This needs a signed-in person.")
  return ctx.user
}
