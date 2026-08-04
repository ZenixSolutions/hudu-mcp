/**
 * The tool registry.
 *
 * Every tool the server can offer is assembled here, in one list, in a stable
 * order. Registration is decided later, per configuration, in `buildServer` —
 * this function only says what exists.
 *
 * Order matters a little: clients present tools in the order given, and a model
 * scanning the list benefits from companies coming first, since almost every
 * Hudu task starts by resolving a customer to a company id.
 */

import { adminTools } from './admin.js';
import { assetTools } from './assets.js';
import { companyTools } from './companies.js';
import { contentTools } from './content.js';
import type { ToolDefinition } from './define.js';
import { ipamTools } from './ipam.js';
import { monitoringTools } from './monitoring.js';
import { passwordTools } from './passwords.js';
import { rackTools } from './racks.js';

export function allToolDefinitions(): ToolDefinition[] {
  const tools = [
    ...companyTools(),
    ...assetTools(),
    ...contentTools(),
    ...passwordTools(),
    ...ipamTools(),
    ...rackTools(),
    ...monitoringTools(),
    ...adminTools(),
  ];

  assertUniqueNames(tools);
  return tools;
}

/**
 * Fail loudly on a duplicate tool name.
 *
 * Two modules can plausibly both want `hudu_list_folders`. The MCP SDK would
 * accept the second registration and silently shadow the first, producing a
 * server whose behaviour depends on module import order — the kind of defect
 * that survives a whole test suite and then surprises someone in production.
 */
function assertUniqueNames(tools: readonly ToolDefinition[]): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();

  for (const tool of tools) {
    if (seen.has(tool.name)) duplicates.add(tool.name);
    seen.add(tool.name);
  }

  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate tool name(s) in the registry: ${[...duplicates].sort().join(', ')}. ` +
        'Two modules are defining the same tool; rename one of them.',
    );
  }
}
