/**
 * The workflow registry.
 *
 * Composite tools that answer a question in one call which the atomic tools can
 * only answer in several. They sit *above* `src/tools/` in the layering — they
 * compose its client and its factory, and nothing in `tools/` may import from
 * here.
 *
 * That direction is why registration happens in `server.ts` rather than by
 * `tools/index.ts` importing this file: the alternative would be an upward
 * import that quietly inverts the layer boundary the whole codebase is built on.
 *
 * The bar for adding one is that it replaces a call sequence a model would
 * otherwise have to discover for itself. Every tool here traces to a specific
 * question an external reviewer asked of 0.1.0 and could not get answered
 * cheaply — or, in two cases, at all.
 */

import type { ToolDefinition } from '../tools/define.js';
import { overviewTools } from './overview.js';
import { timelineTools } from './timeline.js';

export function allWorkflowDefinitions(): ToolDefinition[] {
  return [...overviewTools(), ...timelineTools()];
}
