#!/usr/bin/env npx tsx
/**
 * FeedEater tradeExecuted Event Schema Verifier
 *
 * Statically analyzes each financial module's source code to verify:
 * 1. Each module emits feedeater.<module>.tradeExecuted via NATS
 * 2. The event payload includes the required fields:
 *    source, symbol, side, price, size, notional_usd, timestamp
 * 3. NATS subject naming is consistent (uses subjectFor helper)
 *
 * Usage:
 *   npx ts-node scripts/verify_trade_events.ts
 */

import { readFileSync, existsSync } from "fs";
import { resolve, join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const REQUIRED_FIELDS = [
  "source",
  "symbol",
  "side",
  "price",
  "size",
  "notional_usd",
  "timestamp",
] as const;

interface ModuleSpec {
  name: string;
  ingestFile: string;
}

const FINANCIAL_MODULES: ModuleSpec[] = [
  { name: "coinbase", ingestFile: "src/ingest.ts" },
  { name: "kraken", ingestFile: "src/ingest.ts" },
  { name: "binance", ingestFile: "src/ingest.ts" },
  { name: "kalshi", ingestFile: "src/ingest.ts" },
  { name: "polymarket", ingestFile: "src/ingest.ts" },
  { name: "uniswap", ingestFile: "src/uniswap.ts" },
  { name: "arbitrum-dex", ingestFile: "src/ingest.ts" },
  { name: "polygon-dex", ingestFile: "src/polygon-dex.ts" },
];

interface VerificationResult {
  module: string;
  file: string;
  exists: boolean;
  emitsTradeExecuted: boolean;
  usesSubjectFor: boolean;
  subjectPattern: string | null;
  fieldsFound: string[];
  fieldsMissing: string[];
  extraFields: string[];
  emissionCount: number;
  pass: boolean;
  notes: string[];
}

function extractTradeEventBlocks(source: string): string[] {
  const blocks: string[] = [];

  const patterns = [
    /subjectFor\([^)]*"tradeExecuted"[^)]*\)/g,
    /["']tradeExecuted["']/g,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const start = Math.max(0, match.index - 600);
      const end = Math.min(source.length, match.index + 600);
      blocks.push(source.slice(start, end));
    }
  }

  return blocks;
}

function findSubjectPattern(source: string): { uses: boolean; pattern: string | null } {
  const subjectForMatch = source.match(
    /subjectFor\(\s*["']([^"']+)["']\s*,\s*["']tradeExecuted["']\s*\)/
  );
  if (subjectForMatch) {
    return { uses: true, pattern: `feedeater.${subjectForMatch[1]}.tradeExecuted` };
  }

  const literalMatch = source.match(
    /["'](feedeater\.[^"']+\.tradeExecuted)["']/
  );
  if (literalMatch) {
    return { uses: false, pattern: literalMatch[1] };
  }

  return { uses: false, pattern: null };
}

function extractFieldsFromBlock(block: string): { found: string[]; extra: string[] } {
  const found: string[] = [];
  const extra: string[] = [];

  const objectLiteralRegex = /\{[^{}]*(?:source|symbol|side|price|size|notional_usd|timestamp)[^{}]*\}/gs;
  const objectMatches = block.match(objectLiteralRegex) || [];

  for (const objStr of objectMatches) {
    const fieldWithColonRegex = /(\w+)\s*:/g;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldWithColonRegex.exec(objStr)) !== null) {
      const fieldName = fieldMatch[1];
      if (REQUIRED_FIELDS.includes(fieldName as typeof REQUIRED_FIELDS[number])) {
        if (!found.includes(fieldName)) found.push(fieldName);
      } else if (!extra.includes(fieldName)) {
        extra.push(fieldName);
      }
    }

    const shorthandRegex = /[,{\n]\s*(\w+)\s*[,}\n]/g;
    while ((fieldMatch = shorthandRegex.exec(objStr)) !== null) {
      const fieldName = fieldMatch[1];
      if (REQUIRED_FIELDS.includes(fieldName as typeof REQUIRED_FIELDS[number])) {
        if (!found.includes(fieldName)) found.push(fieldName);
      }
    }
  }

  return { found, extra };
}

function countEmissions(source: string): number {
  const pattern = /\.publish\s*\(\s*subjectFor\([^)]*["']tradeExecuted["'][^)]*\)/g;
  const matches = source.match(pattern);
  return matches ? matches.length : 0;
}

function verifyModule(modulesDir: string, spec: ModuleSpec): VerificationResult {
  const filePath = join(modulesDir, spec.name, spec.ingestFile);
  const result: VerificationResult = {
    module: spec.name,
    file: `modules/${spec.name}/${spec.ingestFile}`,
    exists: false,
    emitsTradeExecuted: false,
    usesSubjectFor: false,
    subjectPattern: null,
    fieldsFound: [],
    fieldsMissing: [],
    extraFields: [],
    emissionCount: 0,
    pass: false,
    notes: [],
  };

  if (!existsSync(filePath)) {
    result.notes.push(`File not found: ${filePath}`);
    return result;
  }

  result.exists = true;
  const source = readFileSync(filePath, "utf-8");

  const { uses, pattern } = findSubjectPattern(source);
  result.usesSubjectFor = uses;
  result.subjectPattern = pattern;
  result.emitsTradeExecuted = pattern !== null;

  if (!result.emitsTradeExecuted) {
    result.notes.push("No tradeExecuted emission found in source");
    return result;
  }

  result.emissionCount = countEmissions(source);

  const blocks = extractTradeEventBlocks(source);
  const allFound = new Set<string>();
  const allExtra = new Set<string>();

  for (const block of blocks) {
    const { found, extra } = extractFieldsFromBlock(block);
    for (const f of found) allFound.add(f);
    for (const e of extra) allExtra.add(e);
  }

  result.fieldsFound = Array.from(allFound);
  result.fieldsMissing = REQUIRED_FIELDS.filter((f) => !allFound.has(f));
  result.extraFields = Array.from(allExtra);

  if (!result.usesSubjectFor) {
    result.notes.push("Uses hardcoded subject string instead of subjectFor()");
  }

  if (result.emissionCount > 1) {
    result.notes.push(
      `Multiple emission points (${result.emissionCount}) — verify all paths emit the same schema`
    );
  }

  result.pass =
    result.emitsTradeExecuted &&
    result.usesSubjectFor &&
    result.fieldsMissing.length === 0;

  return result;
}

function printResults(results: VerificationResult[]): void {
  const COL = {
    reset: "\x1b[0m",
    green: "\x1b[32m",
    red: "\x1b[31m",
    yellow: "\x1b[33m",
    cyan: "\x1b[36m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
  };

  console.log("");
  console.log(
    `${COL.bold}=== FeedEater tradeExecuted Event Schema Verification ===${COL.reset}`
  );
  console.log("");
  console.log(
    `Required fields: ${REQUIRED_FIELDS.join(", ")}`
  );
  console.log(
    `Expected subject: feedeater.<module>.tradeExecuted (via subjectFor)`
  );
  console.log("");

  for (const r of results) {
    const status = r.pass
      ? `${COL.green}PASS${COL.reset}`
      : `${COL.red}FAIL${COL.reset}`;

    console.log(
      `${COL.bold}${r.module.padEnd(14)}${COL.reset} ${status}  ${COL.dim}${r.file}${COL.reset}`
    );

    if (!r.exists) {
      console.log(`  ${COL.red}File not found${COL.reset}`);
      continue;
    }

    if (!r.emitsTradeExecuted) {
      console.log(
        `  ${COL.red}No tradeExecuted emission found${COL.reset}`
      );
      continue;
    }

    console.log(`  Subject:  ${r.subjectPattern}`);
    console.log(
      `  Fields:   ${r.fieldsFound.length}/${REQUIRED_FIELDS.length} required`
    );

    if (r.fieldsMissing.length > 0) {
      console.log(
        `  ${COL.red}Missing:  ${r.fieldsMissing.join(", ")}${COL.reset}`
      );
    }

    if (r.extraFields.length > 0) {
      console.log(
        `  ${COL.dim}Extra:    ${r.extraFields.join(", ")}${COL.reset}`
      );
    }

    if (r.emissionCount > 0) {
      console.log(`  Emitters: ${r.emissionCount} publish() call(s)`);
    }

    for (const note of r.notes) {
      console.log(`  ${COL.yellow}Note: ${note}${COL.reset}`);
    }

    console.log("");
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  const total = results.length;

  console.log("---");
  console.log(
    `${COL.bold}Summary: ${passed}/${total} modules pass${COL.reset}` +
      (failed > 0 ? ` (${COL.red}${failed} failed${COL.reset})` : "")
  );
  console.log("");

  if (failed > 0) {
    process.exitCode = 1;
  }
}

function main(): void {
  const rootDir = resolve(__dirname, "..");
  const modulesDir = join(rootDir, "modules");

  const results = FINANCIAL_MODULES.map((spec) =>
    verifyModule(modulesDir, spec)
  );

  printResults(results);
}

main();
