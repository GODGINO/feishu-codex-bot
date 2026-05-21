/**
 * Relay protocol types shared between server and browser extension.
 *
 * Flow:
 *   MCP Server -> HTTP POST /api/relay/command -> RelayServer -> WebSocket -> Extension
 *   Extension -> WebSocket -> RelayServer -> HTTP response -> MCP Server
 */

/** Command sent from MCP server to extension via relay */
export interface RelayCommand {
  id: string;
  tool: string;
  params: Record<string, unknown>;
}

/** Response from extension back to MCP server */
export interface RelayResponse {
  id: string;
  result?: unknown;
  error?: string;
}

/** WebSocket message envelope */
export type RelayMessage =
  | { type: 'command'; payload: RelayCommand }
  | { type: 'response'; payload: RelayResponse }
  | { type: 'ping' }
  | { type: 'pong' }
  | { type: 'error'; message: string };

/** Status of a connected extension */
export interface ExtensionStatus {
  sessionKey: string;
  connectedAt: number;
  lastPingAt: number;
  userAgent?: string;
}
