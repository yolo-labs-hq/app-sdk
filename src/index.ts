/**
 * @yolo-labs/app-sdk — the client SDK for YOLO Apps.
 *
 * Import this from your app's IN-IFRAME code to talk to the YOLO host over the
 * origin-safe postMessage bridge. See the README.
 *
 * Phase 1: the bridge client (`createTileApp`) + event subscriptions +
 * permission helper, and manifest types/validator. Brokered credentials
 * (`brokeredFetch`) and the publisher CLI are later phases.
 */
export * from './envelope.js';
export * from './client.js';
export * from './manifest.js';
