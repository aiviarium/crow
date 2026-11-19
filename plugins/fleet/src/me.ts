// Who is using Crow: the id and name grants are written with, and the org role that holds manage on every
// host. `auth.me` is already there; the plugin SDK has no `me()` of its own.
import type { Me } from "@rookery/client"
import type { ClientRookery } from "@rookery/sdk/client"

export interface CurrentUser {
  id: string
  name: string
  /** The org role admin, which holds manage on every host and may read `admin.users`. */
  admin: boolean
}

export const principalOf = (userId: string) => `user:${userId}`

export function createMeApi(rookery: ClientRookery): { me(): Promise<CurrentUser | null> } {
  return {
    async me() {
      try {
        const me = await rookery.rpc.call<Me>("auth.me", {})
        if (!me.user) return null
        return { id: me.user.id, name: me.user.name, admin: me.admin }
      } catch {
        return null
      }
    },
  }
}
