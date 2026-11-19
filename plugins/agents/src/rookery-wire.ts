// Copied from Rookery's M5 branch until Crow repins its client dependency.
export type AgentConnect = { env: string }

export interface AgentHostCapability {
  agents?: boolean
}

export const AGENT_CONNECT = "agents.connect"
