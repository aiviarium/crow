// The fleet plugin's view-facing API: `hosts.*` from the hand-written contract in `./api.ts`,
// and `jobs.*` from the generated wire types in `@rookery/client` via `./jobs.ts`.
import type { ClientRookery } from "@rookery/sdk/client"
import { createHostsApi, type HostsApi } from "./api"
import { createJobsApi, type JobsApi } from "./jobs"

export type FleetApi = HostsApi & JobsApi

export function createFleetApi(rookery: ClientRookery): FleetApi {
  return { ...createHostsApi(rookery), ...createJobsApi(rookery) }
}
