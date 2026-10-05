import { readFileSync } from 'node:fs';
import { assertPostgresReport } from './postgres-report-policy.mjs';

// Vitest's success code alone permits describe.skip/skipIf to make a gate green.
assertPostgresReport(readFileSync('test-results/postgres.xml', 'utf8'));
