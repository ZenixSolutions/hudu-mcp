#!/usr/bin/env node
/**
 * Verify that CHANGELOG.md has a finished, released section for one version.
 *
 * Usage:
 *   node scripts/check-changelog.mjs 0.1.0
 *   node scripts/check-changelog.mjs v0.1.0     # a leading "v" is accepted
 *
 * Exits 0 when the section is release-ready and 1 otherwise, printing a GitHub
 * `::error` annotation per problem. `.github/workflows/release.yml` runs this
 * before installing dependencies, so a tag pushed against an unfinished
 * changelog fails in seconds rather than after a full build.
 *
 * Why it exists: a release workflow that only greps for the version heading is
 * satisfied by a heading with scaffolding underneath it, which is exactly the
 * section a human forgot to finish.
 *
 * Scope. Every check applies to the requested version's OWN section — the lines
 * from its `## [x.y.z]` heading to the next `## ` heading — with one deliberate
 * exception: the comparison link is looked for among the file's link
 * definitions, because Keep a Changelog puts those at the bottom of the file.
 * Scoping matters. An `[Unreleased]` heading legitimately sits above the
 * released section, and this file's preamble legitimately says the tool surface
 * "is not yet stable"; a whole-file scan would fail every release.
 *
 * Confidence. The structural checks — heading present, ISO date present, not
 * headed "Unreleased", body non-empty, comparison link defined — are exact:
 * they test the document's shape and cannot be satisfied by a section that
 * lacks it. The scaffolding check is NOT exact. It is a list of phrases someone
 * thought to write down, matched case-insensitively at word boundaries, and it
 * catches only wording that appears on that list. A section reading "Various
 * improvements." passes every check here. Nothing in this script is a substitute
 * for reading the section before tagging.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG_PATH = join(REPO_ROOT, 'CHANGELOG.md');
const CHANGELOG_LABEL = relative(REPO_ROOT, CHANGELOG_PATH);

/**
 * Wording that means "this section was never finished".
 *
 * Matched case-insensitively with word boundaries so that, for example, "wip"
 * does not fire on "wiping" and "tbd" does not fire inside an identifier.
 */
const SCAFFOLDING_PHRASES = [
  'tbd',
  'to be determined',
  'to be written',
  'todo',
  'fixme',
  'wip',
  'work in progress',
  'coming soon',
  'fill in',
  'fill this in',
  'fill me in',
  'replace me',
  'replace this',
  'placeholder text',
  'placeholder entry',
  'lorem ipsum',
  'describe the change',
  'describe your changes',
  'add entries here',
  'add your changes here',
  'nothing yet',
  'no changes yet',
  'xxx',
  'foo bar',
  'changeme',
  'change me',
  'your text here',
  'summary goes here',
  'notes go here',
];

const errors = [];

function fail(message, line, title) {
  errors.push({ message, line, title });
}

function annotate({ message, line, title }) {
  const flat = String(message).replace(/\r?\n/g, ' ');
  const location = Number.isInteger(line) && line > 0 ? `,line=${line}` : '';
  const label = title ? `,title=${title}` : '';
  console.log(`::error file=${CHANGELOG_LABEL}${location}${label}::${flat}`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function finish() {
  for (const error of errors) annotate(error);
  if (errors.length > 0) {
    console.log(
      `${CHANGELOG_LABEL}: ${errors.length} problem${errors.length === 1 ? '' : 's'} found.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

// --- Argument -------------------------------------------------------------

const rawVersion = (process.argv[2] ?? '').trim();

if (rawVersion === '') {
  console.log(
    '::error::check-changelog.mjs requires a version argument, for example: node scripts/check-changelog.mjs 0.1.0',
  );
  process.exit(1);
}

const version = rawVersion.replace(/^v/i, '');

if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
  console.log(
    `::error::"${rawVersion}" is not a semantic version. Expected something like 0.1.0 or v0.1.0.`,
  );
  process.exit(1);
}

// --- File -----------------------------------------------------------------

let source;
try {
  source = readFileSync(CHANGELOG_PATH, 'utf8');
} catch {
  console.log(`::error::${CHANGELOG_LABEL} could not be read. A release requires a changelog.`);
  process.exit(1);
}

const lines = source.split(/\r?\n/);

// --- Locate the version's own section -------------------------------------

// Matches `## [0.1.0] - 2026-08-04`, `## 0.1.0 - 2026-08-04`, and the
// unfinished variants of both, so that a present-but-wrong heading is reported
// as wrong rather than as missing.
const headingPattern = new RegExp(`^##\\s+\\[?${escapeRegExp(version)}\\]?(?![0-9A-Za-z.-])`);

const headingIndex = lines.findIndex((line) => headingPattern.test(line));

if (headingIndex === -1) {
  fail(
    `No section for version ${version}. Add a "## [${version}] - YYYY-MM-DD" heading to ${CHANGELOG_LABEL} describing this release.`,
    undefined,
    'Missing changelog section',
  );
  finish();
}

const headingLine = lines[headingIndex];
const headingLineNumber = headingIndex + 1;

let sectionEnd = lines.length;
for (let i = headingIndex + 1; i < lines.length; i += 1) {
  if (/^##\s/.test(lines[i])) {
    sectionEnd = i;
    break;
  }
}

const body = lines.slice(headingIndex + 1, sectionEnd);

// --- Heading checks -------------------------------------------------------

if (/\bunreleased\b/i.test(headingLine)) {
  fail(
    `The heading for ${version} is still marked "Unreleased": ${headingLine.trim()}. Move the entries under a dated "## [${version}] - YYYY-MM-DD" heading before tagging.`,
    headingLineNumber,
    'Section still unreleased',
  );
}

const dateMatch = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(headingLine);

if (!dateMatch) {
  fail(
    `The heading for ${version} carries no release date: ${headingLine.trim()}. Use "## [${version}] - YYYY-MM-DD".`,
    headingLineNumber,
    'Section is undated',
  );
} else {
  const [iso, year, month, day] = dateMatch;
  const parsed = new Date(`${iso}T00:00:00Z`);
  const valid =
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === Number(year) &&
    parsed.getUTCMonth() + 1 === Number(month) &&
    parsed.getUTCDate() === Number(day);

  if (!valid) {
    fail(
      `The release date "${iso}" on the ${version} heading is not a real calendar date.`,
      headingLineNumber,
      'Invalid release date',
    );
  }
}

// --- Body checks ----------------------------------------------------------

// Content means a line that says something: not blank, not a bare category
// heading such as "### Added", and not a lone list bullet.
//
// Link definitions are excluded too. Keep a Changelog puts them at the bottom
// of the file, which means they fall inside the last version's section — so
// without this the newest release could never be reported as empty.
const contentLines = body
  .map((line, offset) => ({ text: line, number: headingIndex + 2 + offset }))
  .filter(({ text }) => {
    const trimmed = text.trim();
    if (trimmed === '') return false;
    if (/^#{3,6}\s/.test(trimmed)) return false;
    if (/^[-*+]\s*$/.test(trimmed)) return false;
    if (/^\[[^\]]+\]:\s*\S+/.test(trimmed)) return false;
    return true;
  });

if (contentLines.length === 0) {
  fail(
    `The section for ${version} is empty. A release must describe what changed.`,
    headingLineNumber,
    'Empty changelog section',
  );
}

for (const phrase of SCAFFOLDING_PHRASES) {
  const pattern = new RegExp(`(^|[^0-9A-Za-z])${escapeRegExp(phrase)}([^0-9A-Za-z]|$)`, 'i');
  for (const { text, number } of contentLines) {
    if (pattern.test(text)) {
      fail(
        `The section for ${version} still contains scaffolding wording ("${phrase}"): ${text.trim()}`,
        number,
        'Unfinished changelog entry',
      );
      break;
    }
  }
}

// --- Comparison link ------------------------------------------------------

// Link definitions live at the bottom of the file by Keep a Changelog
// convention, so this one check reads the whole file. It is still scoped to
// this version: the label must be exactly [<version>].
const linkPattern = new RegExp(`^\\[${escapeRegExp(version)}\\]:\\s*\\S+`, 'm');

if (!linkPattern.test(source)) {
  fail(
    `No comparison link defined for ${version}. Add a "[${version}]: https://github.com/ZenixSolutions/hudu-mcp/compare/..." definition at the bottom of ${CHANGELOG_LABEL}.`,
    undefined,
    'Missing comparison link',
  );
}

finish();
