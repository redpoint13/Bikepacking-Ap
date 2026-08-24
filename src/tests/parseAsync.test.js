/**
 * parseAsync.test.js — Non-blocking GPX parsing.
 *
 * parseGPXAsync must produce a result identical to parseGPX while yielding to
 * the event loop, so a long route never blocks paint or input.
 */

import { describe, expect, it, vi } from 'vitest';
import { parseGPX, parseGPXAsync } from '../gpx.js';

/** Builds a GPX document with `n` track points and a namespace, as real files have. */
function makeGPX(n) {
  const pts = Array.from(
    { length: n },
    (_, i) =>
      `<trkpt lat="${35 + i * 0.001}" lon="${-111 - i * 0.001}"><ele>${2000 + i}</ele></trkpt>`,
  ).join('');
  return `<?xml version="1.0"?>
<gpx version="1.1" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Chunk Test</name><trkseg>${pts}</trkseg></trk>
  <wpt lat="35.05" lon="-111.05"><name>Spring Creek</name><desc>water</desc></wpt>
</gpx>`;
}

describe('parseGPXAsync', () => {
  it('produces a result identical to the synchronous parse', async () => {
    const gpx = makeGPX(500);
    expect(await parseGPXAsync(gpx)).toEqual(parseGPX(gpx));
  });

  it('parses every track point across chunk boundaries', async () => {
    // 4500 > PARSE_CHUNK_SIZE (2000), so this spans three chunks.
    const route = await parseGPXAsync(makeGPX(4500));
    expect(route.trackPoints).toHaveLength(4500);
    expect(route.trackPoints[0][2]).toBe(2000);
    expect(route.trackPoints[4499][2]).toBe(6499);
  });

  it('keeps waypoints and derived fields intact', async () => {
    const route = await parseGPXAsync(makeGPX(3000));
    expect(route.name).toBe('Chunk Test');
    expect(route.waypoints).toHaveLength(1);
    expect(route.waypoints[0].name).toBe('Spring Creek');
    expect(route.totalDistanceMiles).toBeGreaterThan(0);
    expect(route.difficulty).toBeTruthy();
    expect(route.bounds.minLat).toBeLessThan(route.bounds.maxLat);
  });

  it('yields to the event loop rather than blocking through the parse', async () => {
    let ranBetweenChunks = 0;
    const ticker = setInterval(() => {
      ranBetweenChunks++;
    }, 0);

    await parseGPXAsync(makeGPX(6000));
    clearInterval(ticker);

    // A blocking parse would starve the timer entirely.
    expect(ranBetweenChunks).toBeGreaterThan(0);
  });

  it('reports progress', async () => {
    const seen = [];
    await parseGPXAsync(makeGPX(6000), { onProgress: (f) => seen.push(f) });

    expect(seen.length).toBeGreaterThan(0);
    expect(Math.min(...seen)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...seen)).toBeLessThanOrEqual(1);
    // Progress must not run backwards.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });

  it('rejects a GPX with no track points', async () => {
    const empty = '<?xml version="1.0"?><gpx version="1.1"><trk><trkseg/></trk></gpx>';
    await expect(parseGPXAsync(empty)).rejects.toThrow(/no track points/i);
  });
});
