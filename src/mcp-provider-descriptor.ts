/**
 * The MCP provider descriptor (`provides.mcp`): types and the shape check, the SDK's mirror of
 * common-api `services/tileapp/mcp-provider-descriptor.ts` (a parity test keeps them identical).
 * Serving tools to agents is admitted by the server only behind its provider flag and per-app
 * allowlist; this checks the shape before you publish. See docs/TILE_APP_MCP_PROVIDER_PLAN.md.
 */
/** Stateless Streamable HTTP, JSON responses only (§5.1). The one profile phase 1 serves. */
export const MCP_PROVIDER_PROFILES = ['mcp-2025-06-18-stateless-json'] as const;
export type McpProviderProfile = (typeof MCP_PROVIDER_PROFILES)[number];

export const MAX_TOOLS = 16;
export const MAX_RESULT_BYTES = 262_144;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,47}$/;
const MAX_TITLE = 60;
const MAX_DESCRIPTION = 1024;
const MAX_SCHEMA_DEPTH = 6;
const MAX_SCHEMA_PROPERTIES = 64;
/** Gateway paths an app can't claim (§7.2). */
const RESERVED_PREFIXES = ['/__yolo', '/_ctl', '/_t', '/_w'];

export type JsonSchemaObject = Record<string, unknown>;

export interface TileAppMcpTool {
  name: string;
  title?: string;
  description: string;
  /** Policy class, not an MCP annotation (§5.3). */
  access: 'read' | 'write';
  /**
   * W-2, write tools only: `create` makes something new; `update` changes (or removes) an existing item
   * and so takes a required integer `ifRevision`, the revision the agent read (§5.4).
   */
  writeKind?: 'create' | 'update';
  inputSchema: JsonSchemaObject;
  outputSchema?: JsonSchemaObject;
  maxResultBytes?: number;
}

export interface TileAppMcpProvider {
  /** Relative path on the app's backend, e.g. `/api/mcp`. */
  path: string;
  transport: 'streamable-http';
  profile: McpProviderProfile;
  tools: TileAppMcpTool[];
  /**
   * Where an attached item's data lives in the app's tile data (A-4): key prefix templates with one
   * `{resource}`, e.g. `vaults/{resource}/`. With platform attenuation on, a provider call can read
   * only under these prefixes, for the attached item ids, and write nothing.
   */
  resourceKeys?: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** `path`: relative, `/`-rooted, no traversal, encoding tricks, query, fragment or reserved prefix. */
function pathErrors(path: unknown): string[] {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 128) return ['provides.mcp.path must be a relative path starting with / (at most 128 characters)'];
  if (/[?#\\]/.test(path) || path.includes('//') || /(^|\/)\.\.?(\/|$)/.test(path) || /%2e|%2f|%5c/i.test(path) || !/^[A-Za-z0-9/_.-]+$/.test(path)) {
    return ['provides.mcp.path may not contain a query, fragment, `//`, `.`/`..` segments or encoded separators'];
  }
  if (RESERVED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`))) return [`provides.mcp.path may not be under a reserved gateway prefix (${RESERVED_PREFIXES.join(', ')})`];
  return [];
}

/** Keywords each schema type may use (§7.2): an allowlist. Anything else is refused. */
const SCHEMA_KEYWORDS: ReadonlyMap<string, ReadonlySet<string>> = new Map(Object.entries({
  object: new Set(['type', 'title', 'description', 'properties', 'required', 'additionalProperties']),
  string: new Set(['type', 'title', 'description', 'maxLength', 'minLength', 'enum']),
  integer: new Set(['type', 'title', 'description', 'minimum', 'maximum', 'enum']),
  number: new Set(['type', 'title', 'description', 'minimum', 'maximum']),
  boolean: new Set(['type', 'title', 'description']),
  null: new Set(['type', 'title', 'description']),
  array: new Set(['type', 'title', 'description', 'items', 'maxItems', 'minItems']),
}));
const PROPERTY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
/** Schema nodes one tool's input and output schemas may hold together. */
const MAX_SCHEMA_NODES = 256;
const MAX_ENUM = 64;
const MAX_ANNOTATION = 512;

/**
 * The restricted JSON Schema subset (§7.2): per type, only the keywords in SCHEMA_KEYWORDS (no
 * `$ref`, `pattern`, combinators, `default`, `format` or anything else unknown), closed objects with
 * plain property names, `maxLength` on every string and `maxItems` on every array, finite numeric
 * bounds, small typed enums, bounded annotations, depth and a node budget per tool.
 */
function schemaErrors(schema: unknown, at: string, budget: { nodes: number }, depth = 0): string[] {
  if (!isObj(schema)) return [`${at} must be a JSON Schema object`];
  if (depth > MAX_SCHEMA_DEPTH) return [`${at} nests deeper than ${MAX_SCHEMA_DEPTH} levels`];
  if (--budget.nodes < 0) return budget.nodes === -1 ? [`${at}: the tool's schemas hold more than ${MAX_SCHEMA_NODES} nodes`] : [];
  const type = typeof schema.type === 'string' ? schema.type : '';
  // A Map, not an object: a `type` such as "constructor" or "__proto__" must not find a prototype member.
  const allowed = SCHEMA_KEYWORDS.get(type);
  if (!allowed) return [`${at}.type must be one of ${[...SCHEMA_KEYWORDS.keys()].join(', ')}`];
  const errors: string[] = [];
  for (const k of Object.keys(schema)) if (!allowed.has(k)) errors.push(`${at} may not use '${k}' on a ${type} schema`);
  for (const k of ['title', 'description'] as const) {
    if (schema[k] !== undefined && (typeof schema[k] !== 'string' || (schema[k] as string).length > MAX_ANNOTATION)) errors.push(`${at}.${k} must be a string of at most ${MAX_ANNOTATION} characters`);
  }
  const int = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi;
  const finite = (v: unknown) => v === undefined || (typeof v === 'number' && Number.isFinite(v));
  switch (type) {
    case 'object': {
      if (schema.additionalProperties !== false) errors.push(`${at} must set additionalProperties: false`);
      const props = schema.properties === undefined ? {} : schema.properties;
      if (!isObj(props)) { errors.push(`${at}.properties must be an object`); break; }
      const keys = Object.keys(props);
      if (keys.length > MAX_SCHEMA_PROPERTIES) errors.push(`${at} declares more than ${MAX_SCHEMA_PROPERTIES} properties`);
      for (const k of keys) {
        if (!PROPERTY_NAME.test(k)) { errors.push(`${at}.properties: '${k.slice(0, 40)}' is not a plain property name`); continue; }
        errors.push(...schemaErrors(props[k], `${at}.properties.${k}`, budget, depth + 1));
      }
      if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((r) => typeof r === 'string' && keys.includes(r))
        || new Set(schema.required).size !== schema.required.length)) {
        errors.push(`${at}.required must list declared properties, each once`);
      }
      break;
    }
    case 'string': {
      if (!int(schema.maxLength, 1, 65_536)) errors.push(`${at} (string) needs an integer maxLength between 1 and 65536`);
      if (schema.minLength !== undefined && !int(schema.minLength, 0, 65_536)) errors.push(`${at}.minLength must be an integer between 0 and 65536`);
      if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > MAX_ENUM
        || !schema.enum.every((v) => typeof v === 'string' && v.length <= (typeof schema.maxLength === 'number' ? schema.maxLength : 0)))) {
        errors.push(`${at}.enum must list 1-${MAX_ENUM} strings within maxLength`);
      }
      break;
    }
    case 'integer':
    case 'number':
      if (!finite(schema.minimum) || !finite(schema.maximum)) errors.push(`${at}.minimum / maximum must be finite numbers`);
      if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0 || schema.enum.length > MAX_ENUM || !schema.enum.every((v) => Number.isInteger(v)))) {
        errors.push(`${at}.enum must list 1-${MAX_ENUM} integers`);
      }
      break;
    case 'array':
      if (!int(schema.maxItems, 1, 1000)) errors.push(`${at} (array) needs an integer maxItems between 1 and 1000`);
      if (schema.minItems !== undefined && !int(schema.minItems, 0, 1000)) errors.push(`${at}.minItems must be an integer between 0 and 1000`);
      errors.push(...schemaErrors(schema.items, `${at}.items`, budget, depth + 1));
      break;
    default:
      break;
  }
  return errors;
}

function toolErrors(tool: unknown, i: number): string[] {
  const at = `provides.mcp.tools[${i}]`;
  if (!isObj(tool)) return [`${at} must be an object`];
  const errors: string[] = [];
  if (typeof tool.name !== 'string' || !TOOL_NAME.test(tool.name)) errors.push(`${at}.name must match ${TOOL_NAME.source}`);
  if (tool.title !== undefined && (typeof tool.title !== 'string' || tool.title.length > MAX_TITLE)) errors.push(`${at}.title must be at most ${MAX_TITLE} characters`);
  if (typeof tool.description !== 'string' || tool.description.trim().length === 0 || tool.description.length > MAX_DESCRIPTION || /[<>]/.test(tool.description)) {
    errors.push(`${at}.description must be plain text, 1-${MAX_DESCRIPTION} characters, without < or >`);
  }
  if (tool.access !== 'read' && tool.access !== 'write') errors.push(`${at}.access must be 'read' or 'write'`);
  const budget = { nodes: MAX_SCHEMA_NODES };
  const input = schemaErrors(tool.inputSchema, `${at}.inputSchema`, budget);
  if (input.length === 0 && (tool.inputSchema as JsonSchemaObject).type !== 'object') input.push(`${at}.inputSchema must be of type object`);
  if (input.length === 0 && tool.access === 'write') input.push(...idempotencyKeyErrors(tool.inputSchema as JsonSchemaObject, at));
  input.push(...writeKindErrors(tool, at));
  errors.push(...input);
  if (tool.outputSchema !== undefined) errors.push(...schemaErrors(tool.outputSchema, `${at}.outputSchema`, budget));
  if (tool.maxResultBytes !== undefined && (typeof tool.maxResultBytes !== 'number' || !Number.isInteger(tool.maxResultBytes) || tool.maxResultBytes < 1 || tool.maxResultBytes > MAX_RESULT_BYTES)) {
    errors.push(`${at}.maxResultBytes must be an integer between 1 and ${MAX_RESULT_BYTES}`);
  }
  return errors;
}

/**
 * W-2: a write tool takes a required `idempotencyKey` argument (a string of 8-128 characters): the agent
 * sends the same key when it repeats a write, the gateway forwards it, and the app applies one write
 * per key. Agents can only fill a tool's arguments, so that is where the key lives.
 */
export const IDEMPOTENCY_KEY_ARG = 'idempotencyKey';
function idempotencyKeyErrors(schema: JsonSchemaObject, at: string): string[] {
  const props = isObj(schema.properties) ? schema.properties : {};
  const key = props[IDEMPOTENCY_KEY_ARG];
  const required = Array.isArray(schema.required) && schema.required.includes(IDEMPOTENCY_KEY_ARG);
  const ok = isObj(key) && key.type === 'string' && typeof key.minLength === 'number' && key.minLength >= 8
    && typeof key.maxLength === 'number' && key.maxLength <= 128 && required;
  return ok ? [] : [`${at}: a write tool must take a required '${IDEMPOTENCY_KEY_ARG}' string argument (minLength >= 8, maxLength <= 128)`];
}

/** W-2: a write tool says whether it creates or updates; an update takes a required integer `ifRevision`. */
export const IF_REVISION_ARG = 'ifRevision';
function writeKindErrors(tool: Record<string, unknown>, at: string): string[] {
  if (tool.access !== 'write') return tool.writeKind === undefined ? [] : [`${at}.writeKind is only for write tools`];
  if (tool.writeKind !== 'create' && tool.writeKind !== 'update') return [`${at}.writeKind must be 'create' or 'update' for a write tool`];
  if (tool.writeKind === 'create' || !isObj(tool.inputSchema)) return [];
  const schema = tool.inputSchema;
  const props = isObj(schema.properties) ? schema.properties : {};
  const rev = props[IF_REVISION_ARG];
  const required = Array.isArray(schema.required) && schema.required.includes(IF_REVISION_ARG);
  return isObj(rev) && rev.type === 'integer' && required ? [] : [`${at}: an 'update' write tool must take a required integer '${IF_REVISION_ARG}' argument`];
}

/** `{resource}` once, as a whole last-but-one segment: `<segment>/…/{resource}/` (portable key segments). */
const RESOURCE_KEY = /^(?:[A-Za-z0-9._~@+=,-]{1,64}\/){0,4}\{resource\}\/$/;
export const MAX_RESOURCE_KEYS = 4;

function resourceKeyErrors(keys: unknown): string[] {
  if (!Array.isArray(keys) || keys.length === 0 || keys.length > MAX_RESOURCE_KEYS) return [`provides.mcp.resourceKeys must list 1-${MAX_RESOURCE_KEYS} key prefixes`];
  const bad = keys.filter((k) => typeof k !== 'string' || !RESOURCE_KEY.test(k) || k.split('/').some((seg) => seg === '.' || seg === '..'));
  if (bad.length > 0) return ["provides.mcp.resourceKeys entries must look like 'vaults/{resource}/' (portable segments, {resource} once, as the last segment)"];
  return new Set(keys).size === keys.length ? [] : ['provides.mcp.resourceKeys must be distinct'];
}

/** Shape errors of `provides` (flag-independent; the SDK validator mirrors these). */
export function mcpProviderShapeErrors(provides: unknown): string[] {
  if (provides === undefined) return [];
  if (!isObj(provides)) return ['provides must be an object'];
  const extra = Object.keys(provides).filter((k) => k !== 'mcp');
  const errors = extra.map((k) => `provides.${k} is not supported`);
  const mcp = provides.mcp;
  if (mcp === undefined) return errors;
  if (!isObj(mcp)) return [...errors, 'provides.mcp must be an object'];
  errors.push(...pathErrors(mcp.path));
  if (mcp.resourceKeys !== undefined) errors.push(...resourceKeyErrors(mcp.resourceKeys));
  if (mcp.transport !== 'streamable-http') errors.push("provides.mcp.transport must be 'streamable-http'");
  if (!MCP_PROVIDER_PROFILES.includes(mcp.profile as McpProviderProfile)) errors.push(`provides.mcp.profile must be one of ${MCP_PROVIDER_PROFILES.join(', ')}`);
  if (!Array.isArray(mcp.tools) || mcp.tools.length === 0 || mcp.tools.length > MAX_TOOLS) {
    errors.push(`provides.mcp.tools must list 1-${MAX_TOOLS} tools`);
    return errors;
  }
  mcp.tools.forEach((t, i) => errors.push(...toolErrors(t, i)));
  const names = mcp.tools.map((t) => (isObj(t) ? t.name : undefined)).filter((n) => typeof n === 'string');
  if (new Set(names).size !== names.length) errors.push('provides.mcp.tools names must be unique');
  return errors;
}
