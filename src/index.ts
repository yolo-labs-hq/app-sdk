/**
 * @yolo-labs/app-sdk — the client SDK for YOLO Apps.
 *
 * Import this from your app's IN-IFRAME code to talk to the YOLO host over the
 * origin-safe postMessage bridge. See the README.
 *
 * The bridge client (`createTileApp`), the server client
 * (`createTileServerClient`), capability discovery, portable storage helpers,
 * and manifest types/validator. Secrets need no SDK call: the platform attaches
 * them to vendor requests. The publisher CLI is a later phase.
 */
export * from './envelope.js';
export * from './client.js';
export * from './mcp.js';
export * from './link.js';
export * from './clipboard.js';
export * from './mcp-provider-descriptor.js';
export * from './mcp-provider.js';
export * from './server.js';
export * from './storage.js';
export * from './manifest.js';
export * from './mcp.js';
