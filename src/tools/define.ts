/**
 * The tool definition factory.
 *
 * Every tool in this server is built here. Centralising it is what keeps the
 * security posture uniform: classification, capability gating, confirmation,
 * secret stripping, error translation and response shaping all happen once,
 * in this file, rather than being re-remembered in each of the ninety-odd
 * operations the Hudu API exposes.
 *
 * A tool module therefore declares *what* it does. It cannot accidentally opt
 * out of *how* the server behaves.
 */

import { z } from 'zod';

import type { HuduClient } from '../api/client.js';
import { CapabilityDisabledError, HuduApiError } from '../api/errors.js';
import { scrubSecrets } from '../api/redact.js';
import type { Config } from '../config.js';
import { applyCharacterBudget, ResponseFormat } from '../presentation/format.js';
import {
  annotationsFor,
  CLASS_REQUIREMENTS,
  type OperationClass,
  type ToolAnnotations,
} from '../security/classification.js';
import {
  collectSecretValues,
  redactSecretsInText,
  stripSecrets,
  WITHHELD,
  WITHHELD_DISABLED,
} from '../security/secrets.js';

/** What a tool handler is given. */
export interface ToolContext {
  readonly client: HuduClient;
  readonly config: Config;
}

/** What a tool handler returns; shaping and serialisation happen downstream. */
export interface ToolResult {
  /** Structured payload. Secrets are stripped from this automatically. */
  readonly data: unknown;
  /** Optional human-facing rendering. Falls back to pretty JSON. */
  readonly markdown?: string | undefined;
  /** Short line prepended to the response, e.g. an impact statement. */
  readonly notice?: string | undefined;
}

export interface ToolDefinition<Shape extends z.ZodRawShape = z.ZodRawShape> {
  /** Tool name, `hudu_`-prefixed and snake_case. */
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Shape;
  readonly operationClass: OperationClass;
  /** Required only when {@link CapabilityRequirements.exportFlag} applies. */
  readonly requiresExportFlag?: boolean;
  /** Required only when the tool reveals stored secret material. */
  readonly requiresPasswordReveal?: boolean;
  /** Human-readable impact, shown before a confirmed action runs. */
  readonly impact?: string;
  /**
   * Arguments arrive as an open record rather than the Zod-inferred type.
   *
   * The SDK has already validated them against `inputSchema` before the handler
   * runs, so the inferred type would add no safety — and `objectOutputType`
   * carries no index signature, which would force a cast at every lookup
   * instead of one honest declaration here.
   */
  readonly handler: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
}

/** A tool definition plus the derived metadata the server needs to register it. */
export interface PreparedTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: z.ZodRawShape;
  readonly annotations: ToolAnnotations;
  readonly operationClass: OperationClass;
  readonly definition: ToolDefinition;
}

/** Shared argument every read tool accepts. */
export const responseFormatArg = {
  response_format: z
    .enum([ResponseFormat.Markdown, ResponseFormat.Json])
    .default(ResponseFormat.Json)
    .describe(
      "Output shape. 'json' (default) is compact and machine-readable; 'markdown' is easier " +
        'for a person to read but larger.',
    ),
};

/** Shared argument every gated action requires. */
export const confirmArg = {
  confirm: z
    .literal(true)
    .describe(
      'Must be exactly true. This operation changes or removes data in Hudu and will not run ' +
        'without it. Tell the user what will happen before you set it.',
    ),
};

/**
 * Decide whether a tool should be registered under the current configuration.
 *
 * Unregistered rather than registered-and-refusing: a tool a model cannot see is
 * a tool it cannot be talked into calling. `standards/security-standard.md`
 * asks for least privilege and secure defaults, and an absent tool is the
 * strongest form of both.
 */
export function shouldRegister(definition: ToolDefinition, config: Config): boolean {
  const requirements = CLASS_REQUIREMENTS[definition.operationClass];

  if (requirements.writes && config.readOnly) return false;
  if (requirements.destructiveFlag && !config.allowDestructive) return false;
  if (definition.requiresExportFlag && !config.allowExports) return false;
  if (definition.requiresPasswordReveal && !config.allowPasswordReveal) return false;

  return true;
}

/** Attach a `confirm` argument to tools whose class requires one. */
function withConfirmation(definition: ToolDefinition): z.ZodRawShape {
  const requirements = CLASS_REQUIREMENTS[definition.operationClass];
  return requirements.confirmArgument
    ? { ...definition.inputSchema, ...confirmArg }
    : definition.inputSchema;
}

/**
 * Build the description the model actually sees.
 *
 * Impact and gating are appended rather than left to each author to remember.
 * Article X makes descriptions part of the interface contract, and an
 * undocumented gate reads to a model as a broken tool.
 */
function buildDescription(definition: ToolDefinition): string {
  const parts = [definition.description.trim()];
  const requirements = CLASS_REQUIREMENTS[definition.operationClass];

  parts.push(`\nOperation class: ${definition.operationClass}.`);

  if (definition.impact) {
    parts.push(`Impact: ${definition.impact}`);
  }

  if (requirements.confirmArgument) {
    parts.push(
      'This tool requires `confirm: true`. Describe the specific records affected to the user ' +
        'and get their agreement before calling it.',
    );
  }

  if (definition.requiresPasswordReveal) {
    parts.push(
      'Returns stored credential material. Never echo the returned value into a summary, a ' +
        'file, a message, or any subsequent tool call; hand it to the user and nowhere else.',
    );
  }

  return parts.join('\n');
}

export function prepareTool(definition: ToolDefinition): PreparedTool {
  return {
    name: definition.name,
    title: definition.title,
    description: buildDescription(definition),
    inputSchema: withConfirmation(definition),
    annotations: annotationsFor(definition.operationClass),
    operationClass: definition.operationClass,
    definition,
  };
}

/** Convenience wrapper so tool modules keep their literal argument types. */
export function defineTool<Shape extends z.ZodRawShape>(
  definition: ToolDefinition<Shape>,
): ToolDefinition {
  return definition;
}

/**
 * The MCP content payload a handler ultimately produces.
 *
 * The open index signature is required by the SDK's `registerTool` callback
 * type, which models a tool result as an extensible record so that future
 * protocol fields do not become breaking changes.
 */
export interface McpToolResponse {
  readonly content: { type: 'text'; text: string }[];
  readonly structuredContent?: Record<string, unknown>;
  readonly isError?: boolean;
  readonly [key: string]: unknown;
}

const asStructured = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : { result: value };

/**
 * Run a prepared tool end to end.
 *
 * The order here is deliberate. Gates are checked before the handler runs, so a
 * disabled capability never issues a request. Secrets are stripped after the
 * handler returns, so no tool can forget to do it. Errors are translated last,
 * so every failure leaves as guidance rather than as a stack trace.
 */
export async function executeTool(
  prepared: PreparedTool,
  rawArgs: Record<string, unknown>,
  context: ToolContext,
): Promise<McpToolResponse> {
  const { definition } = prepared;
  const requirements = CLASS_REQUIREMENTS[definition.operationClass];

  try {
    if (requirements.writes && context.config.readOnly) {
      throw new CapabilityDisabledError(
        `${definition.name} modifies data and this server is running in read-only mode.`,
        'Unset HUDU_READ_ONLY on the server and restart it. This cannot be overridden per call.',
      );
    }

    if (requirements.destructiveFlag && !context.config.allowDestructive) {
      throw new CapabilityDisabledError(
        `${definition.name} is a Destructive operation and destructive actions are disabled.`,
        'The operator must set HUDU_ALLOW_DESTRUCTIVE=1 and restart the server. Note that the ' +
          'Hudu API key itself must also have been created with destructive actions enabled — ' +
          'that scope is fixed at key creation and cannot be changed later.',
      );
    }

    if (definition.requiresExportFlag && !context.config.allowExports) {
      throw new CapabilityDisabledError(
        `${definition.name} triggers a bulk export and exports are disabled.`,
        'The operator must set HUDU_ALLOW_EXPORTS=1 and restart the server, and the API key ' +
          'must have been created with export capability.',
      );
    }

    if (definition.requiresPasswordReveal && !context.config.allowPasswordReveal) {
      throw new CapabilityDisabledError(
        `${definition.name} returns stored credentials and password reveal is disabled.`,
        'The operator must set HUDU_ALLOW_PASSWORD_REVEAL=1 and restart the server. Password ' +
          'metadata is available without it — only the secret values are withheld.',
      );
    }

    if (requirements.confirmArgument && rawArgs['confirm'] !== true) {
      throw new CapabilityDisabledError(
        `${definition.name} requires confirm: true and it was not supplied.`,
        `${definition.impact ?? 'This operation changes data in Hudu.'} Explain that to the ` +
          'user, get their agreement, then call again with confirm: true.',
      );
    }

    const result = await definition.handler(rawArgs, context);

    const placeholder = context.config.allowPasswordReveal ? WITHHELD : WITHHELD_DISABLED;
    const safeData = definition.requiresPasswordReveal
      ? result.data
      : stripSecrets(result.data, { placeholder });

    const budgeted =
      safeData !== null && typeof safeData === 'object' && 'items' in safeData
        ? applyCharacterBudget(safeData as never)
        : safeData;

    // A handler renders its Markdown view from the *raw* record, before
    // stripping has run, so `result.markdown` bypasses `stripSecrets` entirely.
    // Scrub the rendered string by value as well, or `response_format:
    // "markdown"` becomes an ungated password reveal.
    const markdown =
      result.markdown === undefined || definition.requiresPasswordReveal
        ? result.markdown
        : redactSecretsInText(result.markdown, collectSecretValues(result.data), placeholder);

    const text = markdown ?? JSON.stringify(budgeted, null, 2);
    const withNotice = result.notice ? `${result.notice}\n\n${text}` : text;

    return {
      content: [{ type: 'text', text: withNotice }],
      structuredContent: asStructured(budgeted),
    };
  } catch (error) {
    return { content: [{ type: 'text', text: toAgentError(error) }], isError: true };
  }
}

/**
 * Translate any thrown value into a message a model can act on.
 *
 * The whole result is scrubbed on the way out, not just the branch that looked
 * risky. `HuduApiError` redacts itself at construction, but an arbitrary error
 * thrown anywhere below this point has had no such treatment — and its message
 * is interpolated verbatim. Scrubbing here makes this a boundary rather than a
 * list of remembered cases, which is what Article VIII asks for.
 */
export function toAgentError(error: unknown): string {
  return scrubSecrets(describeError(error));
}

function describeError(error: unknown): string {
  if (error instanceof HuduApiError) return `Error: ${error.toAgentMessage()}`;
  if (error instanceof CapabilityDisabledError) return `Error: ${error.toAgentMessage()}`;

  if (error instanceof z.ZodError) {
    const issues = error.issues
      .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    return `Error: the arguments did not match this tool's schema.\n${issues}\nWhat to do: correct the listed fields and call the tool again.`;
  }

  // Anything else is a defect in this server rather than a user or API problem.
  // Report it as such, without the stack, and without whatever it was carrying.
  const message = error instanceof Error ? error.message : String(error);
  return (
    `Error: unexpected internal failure: ${message}\n` +
    'What to do: this is a bug in hudu-mcp rather than a problem with the request. Please ' +
    'report it at https://github.com/ZenixSolutions/hudu-mcp/issues with the tool name and ' +
    'arguments used.'
  );
}
