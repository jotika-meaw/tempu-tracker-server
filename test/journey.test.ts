import assert from "node:assert/strict";
import test from "node:test";
import {
  findRoute,
  getDirectionData,
  tempuRoutes,
  validateJourney,
} from "../shared/index.ts";

test("every route supports a full outbound and return journey", () => {
  for (const route of tempuRoutes) {
    for (const direction of ["outbound", "return"] as const) {
      const stops = getDirectionData(route, direction).stops;
      const result = validateJourney(route.number, direction, 0, stops.length - 1);
      assert.equal(result.ok, true, `${route.number} ${direction}`);

      if (result.ok) {
        assert.equal(result.journey.startStop, stops[0]);
        assert.equal(result.journey.endStop, stops[stops.length - 1]);
        assert.deepEqual(result.journey.segmentStops, stops);
      }
    }
  }
});

test("every adjacent stop pair is a valid partial journey", () => {
  for (const route of tempuRoutes) {
    for (const direction of ["outbound", "return"] as const) {
      const stops = getDirectionData(route, direction).stops;
      for (let index = 0; index < stops.length - 1; index += 1) {
        const result = validateJourney(route.number, direction, index, index + 1);
        assert.equal(
          result.ok,
          true,
          `${route.number} ${direction} ${index}->${index + 1}`
        );

        if (result.ok) {
          assert.deepEqual(result.journey.segmentStops, [
            stops[index],
            stops[index + 1],
          ]);
        }
      }
    }
  }
});

test("route 15 partial return uses the structured inferred tail", () => {
  const result = validateJourney("15", "return", 0, 5);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.journey.segmentStops, [
      "কোতোয়ালী মোড়",
      "লালদীঘি",
      "আন্দরকিল্লা",
      "জামালখান",
      "গণি বেকারী",
      "গুলজার সিনেমা",
    ]);
    assert.equal(result.journey.directionData.confidence, "partial");
  }
});

test("rejects route 09 and every other non-canonical route number", () => {
  const route09 = validateJourney("09", "outbound", 0, 1);
  assert.equal(route09.ok, false);
  if (!route09.ok) assert.equal(route09.code, "UNKNOWN_ROUTE");

  for (const routeNumber of ["", "9", "18", "00", "99", "abc"]) {
    const result = validateJourney(routeNumber, "outbound", 0, 1);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "UNKNOWN_ROUTE");
  }
});

test("rejects same stop, reversed indices, and out-of-range indices", () => {
  const same = validateJourney("01", "outbound", 2, 2);
  assert.equal(same.ok, false);
  if (!same.ok) assert.equal(same.code, "SAME_STOP");

  const reversed = validateJourney("01", "outbound", 3, 2);
  assert.equal(reversed.ok, false);
  if (!reversed.ok) assert.equal(reversed.code, "END_BEFORE_START");

  for (const [startIndex, endIndex] of [
    [-1, 2],
    [0, 99],
    [1.5, 3],
    [0, 2.5],
  ] as const) {
    const result = validateJourney("01", "outbound", startIndex, endIndex);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "INVALID_INDEX");
  }
});

test("rejects an invalid direction defensively", () => {
  const result = validateJourney("01", "sideways" as "outbound", 0, 1);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, "INVALID_DIRECTION");
});

test("route 11 return starts at its explicit stop and not the outbound first stop", () => {
  const route = findRoute("11");
  assert.ok(route);
  const result = validateJourney("11", "return", 0, 2);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.journey.startStop, "সিডিএ");
    assert.notEqual(result.journey.startStop, route.outbound.stops[0]);
  }
});
