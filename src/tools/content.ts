/**
 * Knowledge base: articles, folders and procedures.
 *
 * These three resources are one subject. An article is a document, a folder is
 * where it lives, and a procedure is a checklist that documents a repeatable
 * job — and a model asked to "write up the onboarding steps for Contoso" needs
 * all three in view to choose correctly between them. They therefore share a
 * module and cross-reference each other in their descriptions.
 *
 * The one genuinely irregular endpoint here is the procedure kickoff, which is
 * a POST whose two inputs travel in the query string. It is hand-written below;
 * everything else is regular enough for the resource factory.
 */

import { z } from 'zod';

import { unwrapRecord } from '../api/envelope.js';
import { buildPath } from '../api/paths.js';
import { OperationClass } from '../security/classification.js';
import { defineTool, type ToolDefinition } from './define.js';
import { buildResourceTools, type ResourceSpec } from './resource.js';

const updatedAtDescription =
  'ISO-8601 range as "start,end". Either side may be omitted — "2026-01-01T00:00:00Z," means ' +
  'everything changed since that moment, ",2026-01-01T00:00:00Z" everything changed before it. ' +
  'A bare timestamp with no comma matches that exact moment.';

/**
 * The public-sharing warning.
 *
 * Article IX treats an externally visible action as needing its consequence
 * named at the point of decision, and for this field the point of decision is
 * the argument description — by the time a confirmation prompt would fire, the
 * model has already chosen the value.
 */
const enableSharingDescription =
  'PUBLISHES THIS ARTICLE TO THE PUBLIC INTERNET when set to true. Hudu mints a share URL ' +
  '(returned as `share_url` on the record) that renders the full article content to anyone ' +
  'holding the link, with no Hudu login, no company scoping and no record of who read it. ' +
  'Client documentation frequently contains internal hostnames, procedures and account ' +
  'references, so treat this as a disclosure decision rather than a formatting one: leave it ' +
  'unset unless the user has explicitly asked for a link they can send outside their Hudu ' +
  'tenant, and tell them what the article contains before you set it. Setting it to false ' +
  'withdraws an existing public URL.';

const contentDescription =
  'Body of the article, as HTML. Hudu stores this string and renders it as HTML in the ' +
  'knowledge base, so Markdown passed here is stored literally and shown to readers with its ' +
  'asterisks, hashes and pipes intact — convert to HTML (<h2>, <p>, <ul>, <table>, ' +
  '<a href="...">) before sending. Existing content is replaced wholesale on update, not ' +
  'appended to.';

const articleWritableFields = {
  name: z.string().min(1).optional().describe('Title of the article, shown in lists and search.'),
  content: z.string().optional().describe(contentDescription),
  company_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the company whose knowledge base this article belongs to. Omit it to ' +
        'create a global article that is visible across every company. Resolve a customer name ' +
        'to an id with hudu_list_companies first.',
    ),
  folder_id: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Numeric id of the folder to file the article under, from hudu_list_folders. Omit to ' +
        'leave the article at the top level. Pick a folder whose own company matches the ' +
        "article's — Hudu does not document what it does with a mismatch.",
    ),
  enable_sharing: z.boolean().optional().describe(enableSharingDescription),
};

export const articlesSpec: ResourceSpec = {
  key: 'articles',
  singular: 'article',
  title: 'Article',
  titlePlural: 'Articles',
  basePath: '/articles',
  // Undocumented envelopes, measured on Hudu 2.34.2 (spec-defects.md F1, F2).
  listKey: 'articles',
  recordKey: 'article',
  summary:
    'An article is a knowledge-base document: HTML content, optionally filed in a folder and ' +
    'optionally scoped to one company. Articles with no company are global to the instance.',
  listNotes:
    "Filter by `company_id` for one customer's knowledge base. Articles created without a " +
    'company are global, and the API documents no filter that isolates those — request without ' +
    '`company_id` and select on a null `company_id` yourself.\n\n' +
    '`enable_sharing: true` returns only articles that currently have a public, ' +
    'unauthenticated share URL, which makes this the tool to answer "what of ours is exposed ' +
    'publicly?". `draft: true` returns unpublished work in progress.\n\n' +
    'Every record carries its full HTML `content`, which is large. Pass `fields` — for example ' +
    '["id","name","company_id","folder_id","enable_sharing"] — when you are looking for an ' +
    'article rather than reading one, then fetch the body with hudu_get_article. Note also ' +
    'that no `archived` filter is documented, so archived articles cannot be selected for or ' +
    'against here.',
  paginated: true,
  filters: {
    search: z
      .string()
      .optional()
      .describe('Broad text search across articles. The best first filter when you have a topic.'),
    name: z.string().optional().describe('Match against the article title specifically.'),
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only articles belonging to this company, by numeric Hudu company id.'),
    draft: z
      .boolean()
      .optional()
      .describe(
        'true returns only drafts (unpublished articles); false returns only published ones. ' +
          'Omit for both. Draft state is readable and filterable but not writable: the API ' +
          'documents no `draft` field on the create or update body, so hudu_create_article and ' +
          'hudu_update_article cannot publish or unpublish an article.',
      ),
    enable_sharing: z
      .boolean()
      .optional()
      .describe(
        'true returns only articles that have a public share URL readable without a Hudu login. ' +
          'Use it to audit external exposure.',
      ),
    slug: z.string().optional().describe('Match the URL slug, if you already have one.'),
    updated_at: z.string().optional().describe(updatedAtDescription),
  },
  create: {
    bodyKey: 'article',
    fields: {
      ...articleWritableFields,
      name: z.string().min(1).describe('Title of the article, shown in lists and search.'),
    },
  },
  update: { bodyKey: 'article', fields: articleWritableFields },
  deletable: true,
  deleteImpact:
    'Permanently removes the article and its content, along with any public share URL it had. ' +
    'The REST API offers no undo and no trash to recover it from.',
  archivable: true,
};

export const foldersSpec: ResourceSpec = {
  key: 'folders',
  singular: 'folder',
  title: 'Folder',
  titlePlural: 'Folders',
  basePath: '/folders',
  // Undocumented envelopes, measured on Hudu 2.34.2 (spec-defects.md F1, F2).
  listKey: 'folders',
  recordKey: 'folder',
  summary:
    'A folder groups knowledge-base articles. Folders nest through `parent_folder_id`, and a ' +
    'folder carrying a `company_id` belongs to that company rather than to the global ' +
    'knowledge base.',
  listNotes:
    'These are article folders. Passwords are organised by a separate `password_folders` ' +
    'resource with its own tools; do not use these ids there.\n\n' +
    'The response is flat, not a tree — reconstruct the hierarchy yourself by following each ' +
    "folder's `parent_folder_id`, which is null at the top level.\n\n" +
    'On `in_company`, the API documents exactly one sentence: "When true, only returns ' +
    'company-specific KB articles." It says nothing about what false does, nor how it ' +
    'interacts with `company_id`. Read it as "restrict to company-scoped folders and exclude ' +
    'global ones", and check the returned `company_id` values rather than trusting that ' +
    'reading.',
  paginated: true,
  filters: {
    name: z.string().optional().describe('Match against the folder name.'),
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only folders belonging to this company, by numeric Hudu company id.'),
    in_company: z
      .boolean()
      .optional()
      .describe(
        'Documented only as "when true, only returns company-specific KB articles" — in ' +
          'practice, restricts the result to folders that belong to a company and excludes ' +
          'global ones. Behaviour when false is undocumented; omit it rather than sending ' +
          'false if you want everything.',
      ),
  },
  create: {
    bodyKey: 'folder',
    fields: {
      name: z.string().min(1).describe('Name of the folder as it appears in the knowledge base.'),
      description: z
        .string()
        .optional()
        .describe('Short explanation of what belongs in this folder, shown alongside its name.'),
      icon: z
        .string()
        .optional()
        .describe(
          'Icon shown on the folder. Hudu uses Font Awesome class names elsewhere in the API, ' +
            'e.g. "fas fa-folder"; the folder endpoint does not document the accepted values, ' +
            'so copy one from an existing folder via hudu_list_folders rather than inventing it.',
        ),
      parent_folder_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Numeric id of the folder to nest this one inside. Omit for a top-level folder.'),
      company_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Numeric id of the company whose knowledge base owns this folder. Omit for a folder ' +
            'in the global knowledge base, visible across every company.',
        ),
    },
  },
  update: {
    bodyKey: 'folder',
    fields: {
      name: z.string().min(1).optional().describe('New name for the folder.'),
      description: z.string().optional().describe('New description for the folder.'),
      icon: z
        .string()
        .optional()
        .describe('New icon for the folder; see hudu_create_folder for accepted values.'),
      parent_folder_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Move the folder under a different parent, by numeric folder id.'),
      company_id: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'Move the folder into a different company. This changes who can see the folder and ' +
            'everything filed in it, so confirm the move with the user before making it.',
        ),
    },
  },
  deletable: true,
  deleteImpact:
    'Removes the folder. Hudu does not document what happens to the articles and subfolders ' +
    'inside it — whether they are deleted with it or moved to the top level is unspecified, so ' +
    'assume the worst case. hudu_list_articles has no folder filter, so check the folder in ' +
    'the Hudu web UI and re-file anything that must survive before deleting.',
};

export const proceduresSpec: ResourceSpec = {
  key: 'procedures',
  singular: 'procedure',
  title: 'Procedure',
  titlePlural: 'Procedures',
  basePath: '/procedures',
  listKey: 'procedures',
  // GET /procedures/{id} wraps the record as {procedure: {...}} on Hudu 2.34.2
  // (spec-defects.md F2).
  recordKey: 'procedure',
  summary:
    'A procedure — called a Process in the Hudu interface — is an ordered checklist of tasks ' +
    'with a completion count, used for repeatable work such as onboarding, offboarding and ' +
    'server builds.',
  listNotes:
    'This API version exposes procedures read-only. There is no create, update or delete ' +
    'endpoint for them, so no such tool exists here and none is being withheld — process ' +
    'templates are authored in the Hudu web interface. The one write available is ' +
    'hudu_kickoff_procedure, which starts a new process from an existing template.\n\n' +
    'Results include both templates and processes already started from one: `parent_procedure` ' +
    'names the template a running process came from and is null on the template itself. ' +
    '`total` and `completed` count tasks, `completion_percentage` arrives as a string like ' +
    '"0%", and a non-null `asset` means the process is pinned to a specific device or person. ' +
    'For instructions that are read rather than worked through, look at articles instead ' +
    '(hudu_list_articles).',
  paginated: true,
  filters: {
    name: z.string().optional().describe('Match against the procedure name.'),
    company_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Return only procedures belonging to this company, by numeric Hudu company id.'),
    slug: z.string().optional().describe('Match the URL slug, if you already have one.'),
  },
};

/**
 * `POST /procedures/{id}/kickoff`.
 *
 * Irregular twice over: it is a create whose target path is not the collection,
 * and its two inputs are query parameters on a POST that documents no body.
 */
const kickoffTool = defineTool({
  name: 'hudu_kickoff_procedure',
  title: 'Start a Process from a Procedure',
  description:
    "Start a new process from an existing procedure. Hudu copies the procedure's task list " +
    'into a new process record with its own id, slug and URL, and returns that new record. ' +
    'Afterwards the company has a live checklist that its users can work through and tick off; ' +
    'the procedure it came from is unchanged and can be kicked off again.\n\n' +
    'Attach the new process to an asset with `asset_id` when the work concerns one specific ' +
    'device or person — that is how an onboarding checklist ends up on the employee record it ' +
    'belongs to. Give it a `name` when several runs of the same procedure would otherwise be ' +
    'indistinguishable, e.g. "Onboarding — J. Okafor".\n\n' +
    'Find the procedure id with hudu_list_procedures. Both optional inputs are sent as query ' +
    'parameters because that is what Hudu documents for this endpoint; it accepts no request ' +
    'body. Success answers 200 rather than the 201 you might expect from a create, and 404 ' +
    'covers both a missing procedure and an unrouted path.',
  inputSchema: {
    id: z
      .number()
      .int()
      .positive()
      .describe('Numeric Hudu id of the procedure to start a process from.'),
    asset_id: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Numeric id of an asset to attach the new process to, such as the employee or server ' +
          'the work is about. Omit to leave the process unattached.',
      ),
    name: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Name for the new process. Omit to inherit the procedure's own name, which makes " +
          'repeated runs hard to tell apart.',
      ),
  },
  operationClass: OperationClass.Create,
  impact:
    'Creates a live process in Hudu, visible to the users of the company that owns the ' +
    'procedure and appearing in their process list as outstanding work.',
  handler: async (args, { client }) => {
    const id = args['id'] as number;
    const response = await client.post<unknown>(
      buildPath('/procedures/{id}/kickoff', { id }),
      undefined,
      {
        asset_id: args['asset_id'] as number | undefined,
        name: args['name'] as string | undefined,
      },
    );
    return {
      data: unwrapRecord(response.data, undefined) ?? null,
      notice: `Started a process from procedure ${id}. It is now live in Hudu.`,
    };
  },
});

export function contentTools(): ToolDefinition[] {
  return [
    ...buildResourceTools(articlesSpec),
    ...buildResourceTools(foldersSpec),
    ...buildResourceTools(proceduresSpec),
    kickoffTool,
  ];
}
