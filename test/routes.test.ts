import assert from "node:assert/strict";
import test from "node:test";
import {
  TEMPU_ROUTE_NUMBERS,
  findRoute,
  getDirectionData,
  tempuRoutes,
} from "../shared/index.js";

const expectedNumbers = [
  "01",
  "02",
  "03",
  "04",
  "05",
  "06",
  "07",
  "08",
  "10",
  "11",
  "12",
  "13",
  "14",
  "15",
  "16",
  "17",
];

test("keeps exactly the supplied 16 route numbers and never invents route 09", () => {
  assert.deepEqual(
    tempuRoutes.map((route) => route.number),
    expectedNumbers
  );
  assert.deepEqual([...TEMPU_ROUTE_NUMBERS], expectedNumbers);
  assert.equal(findRoute("09"), undefined);
  assert.equal(tempuRoutes.length, 16);
});

test("every outbound and return direction has a usable ordered stop list", () => {
  for (const route of tempuRoutes) {
    for (const direction of ["outbound", "return"] as const) {
      const data = getDirectionData(route, direction);
      assert.ok(data.stops.length >= 2, `${route.number} ${direction}`);
      assert.ok(
        data.stops.every((stop) => typeof stop === "string" && stop.trim().length > 0),
        `${route.number} ${direction} contains an empty stop`
      );
      assert.ok(
        !data.stops.includes("একই পথে"),
        `${route.number} ${direction} contains explanatory text as a stop`
      );
      assert.equal(new Set(data.stops).size, data.stops.length);
    }
  }
});

test("routes marked একই পথে use the exact reverse stop order", () => {
  const routesWithSamePath = tempuRoutes.filter(
    (route) => route.number !== "11" && route.number !== "15"
  );

  for (const route of routesWithSamePath) {
    assert.deepEqual(route.return.stops, [...route.outbound.stops].reverse());
    assert.equal(route.return.derived, true);
    assert.equal(route.return.confidence, "verified");
  }
});

test("route 11 keeps its explicitly supplied return and distinct place names", () => {
  const route = findRoute("11");
  assert.ok(route);
  assert.deepEqual(route.return.stops, [
    "সিডিএ",
    "কর্ণেলহাট",
    "একে খান গেট",
    "ফয়েজ লেক",
    "জিইসি মোড়",
    "ওয়াসার মোড়",
    "আলমাস সিনেমা",
  ]);
  assert.equal(route.return.derived, false);
  assert.ok(route.outbound.stops.includes("একে খান মোড়"));
  assert.ok(route.return.stops.includes("একে খান গেট"));
  assert.notEqual("একে খান মোড়", "একে খান গেট");
});

test("route 15 treats আবদুস সাত্তার রোড as a via road, not a stop", () => {
  const route = findRoute("15");
  assert.ok(route);
  assert.deepEqual(route.return.stops, [
    "কোতোয়ালী মোড়",
    "লালদীঘি",
    "আন্দরকিল্লা",
    "জামালখান",
    "গণি বেকারী",
    "গুলজার সিনেমা",
    "কাতালগঞ্জ",
    "পাঁচলাইশ থানা",
    "মুরাদপুর",
  ]);
  assert.equal(route.return.derived, true);
  assert.equal(route.return.confidence, "partial");
  assert.deepEqual(route.return.via, ["আবদুস সাত্তার রোড"]);
  assert.ok(!route.return.stops.includes("আবদুস সাত্তার রোড"));
  assert.ok(route.outbound.stops.includes("নজির আহমদ চৌধুরী রোড"));
  assert.ok(!route.return.stops.includes("নজির আহমদ চৌধুরী রোড"));
  assert.match(route.return.note ?? "", /Owner confirmation required/);
});

test("preserves special characters and parenthetical stop names", () => {
  const route07 = findRoute("07");
  const route10 = findRoute("10");
  assert.ok(route07);
  assert.ok(route10);
  assert.equal(route07.outbound.stops[0], "কর্ণফুলী ব্রিজ (ব্রিজের ২০০ গজ আগে)");
  assert.ok(route10.outbound.stops.includes("পাকা রাস্তার মাথা (লতিফপুর)"));
  assert.ok(route10.outbound.stops.includes("পাহাড়তলী আলম বিড়ি ফ্যাক্টরি"));
  assert.ok(findRoute("01")?.outbound.stops.includes("কাজীর দেউড়ী"));
});
