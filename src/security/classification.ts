/**
 * Operation classification.
 *
 * `standards/security-standard.md` requires every public operation to be
 * classified as Read, Create, Update, Admin, or Destructive. The standard names
 * the classes; it does not define what each obliges. This module supplies that
 * definition for this repository, derives the MCP annotations from it, and is
 * the single place a reviewer has to look to see what any tool is allowed to do.
 */

export const OperationClass = {
  /** Retrieves data. No side effects on the Hudu instance. */
  Read: 'Read',
  /** Brings a new record into existence. Reversible by deleting it. */
  Create: 'Create',
  /** Modifies an existing record. Overwrites prior field values. */
  Update: 'Update',
  /** Privileged: alters instance-wide configuration or extracts data in bulk. */
  Admin: 'Admin',
  /** Removes data. Not reversible through this API. */
  Destructive: 'Destructive',
} as const;

export type OperationClass = (typeof OperationClass)[keyof typeof OperationClass];

/** Gates that a tool may require beyond ordinary registration. */
export interface CapabilityRequirements {
  /** Registered only when write access is enabled (i.e. not read-only mode). */
  readonly writes: boolean;
  /** Registered only when `HUDU_ALLOW_DESTRUCTIVE=1`. */
  readonly destructiveFlag: boolean;
  /** Registered only when `HUDU_ALLOW_EXPORTS=1`. */
  readonly exportFlag: boolean;
  /** Requires an explicit `confirm: true` argument at call time. */
  readonly confirmArgument: boolean;
}

const NONE: CapabilityRequirements = {
  writes: false,
  destructiveFlag: false,
  exportFlag: false,
  confirmArgument: false,
};

/**
 * What each class obliges.
 *
 * Two independent gates protect destructive work, and they are not redundant.
 * A `confirm` argument is supplied by the model, so it is a prompt-level speed
 * bump rather than human-in-the-loop control — the operator-set environment
 * flag is the gate a compromised or confused agent cannot open. Article IX
 * asks for confirmation and described impact; the flag is what makes the
 * confirmation mean something.
 */
export const CLASS_REQUIREMENTS: Record<OperationClass, CapabilityRequirements> = {
  [OperationClass.Read]: NONE,
  [OperationClass.Create]: { ...NONE, writes: true },
  [OperationClass.Update]: { ...NONE, writes: true },
  [OperationClass.Admin]: { ...NONE, writes: true, confirmArgument: true },
  [OperationClass.Destructive]: {
    ...NONE,
    writes: true,
    destructiveFlag: true,
    confirmArgument: true,
  },
};

/** MCP annotations, derived from the class rather than hand-set per tool. */
export interface ToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint: boolean;
  readonly idempotentHint: boolean;
  readonly openWorldHint: boolean;
}

export function annotationsFor(operationClass: OperationClass): ToolAnnotations {
  switch (operationClass) {
    case OperationClass.Read:
      return {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      };
    case OperationClass.Create:
      return {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
    case OperationClass.Update:
      // Idempotent in the HTTP sense: applying the same PUT twice lands in the
      // same state. It still overwrites, which is why it is not a Read.
      return {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      };
    case OperationClass.Admin:
      return {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      };
    case OperationClass.Destructive:
      return {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      };
  }
}
