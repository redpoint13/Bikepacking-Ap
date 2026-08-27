import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _resetApiFieldWarnings, readApiField } from '../apiField.js';
import { classifyLandManager } from '../camp.js';
import { parseUSGSPercentileRdb, usgsReliability, usgsSiteType } from '../water.js';
import { readWildernessName } from '../wilderness.js';

/**
 * These parse responses captured verbatim from the live services, not fixtures
 * written from what the code expected. Every field-name fault in this app got
 * through review because the test fixture and the buggy reader were authored
 * from the same assumption: water.test.js asserted monitoringLocationType,
 * a field the USGS API has never returned.
 *
 * Re-capture with the curl commands in each fixture's companion note if a
 * service changes shape; a diff here is the signal that it did.
 */

const fixture = (name) =>
  fs.readFileSync(path.resolve(process.cwd(), 'src/tests/fixtures', name), 'utf8');

let warn;
beforeEach(() => {
  _resetApiFieldWarnings();
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => warn.mockRestore());

describe('readApiField', () => {
  it('returns the first present candidate', () => {
    expect(readApiField({ b: 2 }, ['a', 'b'], 'x')).toBe(2);
    expect(warn).not.toHaveBeenCalled();
  });

  it('matches case-insensitively and says so', () => {
    // The USFS layer accepts WILDERNESSNAME and answers with wildernessname.
    expect(readApiField({ wildernessname: 'Lost Creek' }, ['WILDERNESSNAME'], 'w')).toBe(
      'Lost Creek',
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('case differs'));
  });

  it('warns, once, when no candidate is present, and lists the real keys', () => {
    expect(readApiField({ site_type_code: 'SP' }, ['monitoringLocationType'], 'USGS type')).toBe(
      undefined,
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('site_type_code'));
    readApiField({ site_type_code: 'SP' }, ['monitoringLocationType'], 'USGS type');
    expect(warn).toHaveBeenCalledTimes(1); // not once per element in a loop
  });

  it('tolerates a null or absent object', () => {
    expect(readApiField(null, ['a'], 'x')).toBeUndefined();
    expect(readApiField(undefined, ['a'], 'x')).toBeUndefined();
  });
});

describe('real USGS monitoring-locations response', () => {
  const data = JSON.parse(fixture('usgs-monitoring-locations.json'));

  it('has features carrying snake_case properties', () => {
    expect(Array.isArray(data.features)).toBe(true);
    expect(data.features.length).toBeGreaterThan(0);
    const props = data.features[0].properties;
    expect(props).toHaveProperty('site_type_code');
    // The name the code used to read, which has never existed:
    expect(props).not.toHaveProperty('monitoringLocationType');
  });

  it('is typed and scored from the real shape without warning', () => {
    for (const f of data.features) {
      expect(usgsSiteType(f)).toBe('SP');
      expect(usgsReliability(f)).toBe(80);
    }
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('real USGS percentile RDB', () => {
  it('parses the tab-delimited table the service actually returns', () => {
    const text = fixture('usgs-percentiles.rdb');
    expect(text.startsWith('#')).toBe(true); // comment block, not JSON
    // Pick a date present in the capture rather than today's.
    const row = text.split('\n').find((l) => l.startsWith('USGS\t'));
    const cols = text
      .split('\n')
      .find((l) => l.startsWith('agency_cd'))
      .split('\t');
    const f = row.split('\t');
    const month = Number(f[cols.indexOf('month_nu')]);
    const day = Number(f[cols.indexOf('day_nu')]);
    const stats = parseUSGSPercentileRdb(text, new Date(2026, month - 1, day));
    expect(stats.size).toBeGreaterThan(0);
    const [first] = [...stats.values()];
    expect(first.p50).toEqual(expect.any(Number));
  });
});

describe('real BLM surface-management response', () => {
  const data = JSON.parse(fixture('blm-sma.json'));

  it('carries ADMIN_AGENCY_CODE and not the HOLDING_NAME the code once asked for', () => {
    const attrs = data.features[0].attributes;
    expect(attrs).toHaveProperty('ADMIN_AGENCY_CODE');
    expect(attrs).not.toHaveProperty('HOLDING_NAME');
  });

  it('classifies the captured point as private, not the permissive default', () => {
    const attrs = data.features[0].attributes;
    const code = readApiField(attrs, ['ADMIN_AGENCY_CODE', 'ADMIN_DEPT_CODE'], 'BLM agency code');
    const result = classifyLandManager({}, String(code));
    expect(result.landManager).toBe('Private');
    expect(result.isDispersedLegal).toBe(false);
  });
});

describe('real USFS wilderness response', () => {
  const data = JSON.parse(fixture('usfs-wilderness.json'));

  it('answers in lowercase however the query was cased', () => {
    const attrs = data.features[0].attributes;
    expect(attrs).toHaveProperty('wildernessname');
    expect(attrs).not.toHaveProperty('WILDERNESSNAME');
  });

  it('is read correctly, rather than falling back to the generic label', () => {
    expect(readWildernessName(data.features[0].attributes)).toBe('Lost Creek Wilderness');
  });
});
