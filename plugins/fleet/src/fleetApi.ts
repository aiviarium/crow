// The fleet plugin's view-facing API: `hosts.*` from the hand-written contract in `./api.ts`, `jobs.*`
// from the generated wire types in `@rookery/client` via `./jobs.ts`, and the M3 host parts: `env.*` for a
// host's state, desktop and ports (`./env.ts`) and `access.*` for sharing it (`./access.ts`).

import type { ClientRookery } from "@rookery/sdk/client"
import type { Accessor } from "solid-js"
import { createGrantsApi, type GrantsApi } from "./access"
import { createHostsApi, type HostsApi } from "./api"
import { createFleetEnvApi, type FleetEnvApi } from "./env"
import { createJobsApi, type JobsApi } from "./jobs"
import { type CurrentUser, createMeApi } from "./me"

export interface FleetApi extends HostsApi, JobsApi {
  env: FleetEnvApi
  grants: GrantsApi
  /** The signed-in person, once `auth.me` has answered. */
  me(): CurrentUser | null
  /** Whether they hold the org role admin, which is manage on every host. */
  isAdmin(): boolean
}

export interface FleetServices extends FleetApi {
  /** `auth.me`, for the store that keeps the person and their role. */
  fetchMe(): Promise<CurrentUser | null>
}

export function createFleetApi(
  rookery: ClientRookery,
  current: Accessor<CurrentUser | null> = () => null,
): FleetServices {
  const meApi = createMeApi(rookery)
  return {
    ...createHostsApi(rookery),
    ...createJobsApi(rookery),
    env: createFleetEnvApi(rookery),
    grants: createGrantsApi(rookery),
    me: () => current(),
    isAdmin: () => !!current()?.admin,
    fetchMe: () => meApi.me(),
  }
}
