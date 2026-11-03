import {
  TEMPU_ROUTE_NUMBERS,
  tempuRoutes,
  type Direction,
  type TempuRoute,
} from "./routes";

export type JourneyErrorCode =
  | "UNKNOWN_ROUTE"
  | "INVALID_DIRECTION"
  | "INVALID_INDEX"
  | "SAME_STOP"
  | "END_BEFORE_START";

export type ValidatedJourney = {
  route: TempuRoute;
  direction: Direction;
  directionData: TempuRoute["outbound"];
  startIndex: number;
  endIndex: number;
  startStop: string;
  endStop: string;
  segmentStops: string[];
};

export type JourneyValidation =
  | { ok: true; journey: ValidatedJourney }
  | { ok: false; code: JourneyErrorCode; message: string };

export function findRoute(routeNumber: string): TempuRoute | undefined {
  return tempuRoutes.find((item) => item.number === routeNumber);
}

export function getDirectionData(
  route: TempuRoute,
  direction: Direction
): TempuRoute["outbound"] {
  return direction === "outbound" ? route.outbound : route.return;
}

export function validateJourney(
  routeNumber: string,
  direction: Direction,
  startIndex: number,
  endIndex: number
): JourneyValidation {
  const route = findRoute(routeNumber);

  if (!route) {
    return {
      ok: false,
      code: "UNKNOWN_ROUTE",
      message: "This route number is not part of the verified route set.",
    };
  }

  if (direction !== "outbound" && direction !== "return") {
    return {
      ok: false,
      code: "INVALID_DIRECTION",
      message: "Direction must be either outbound or return.",
    };
  }

  const directionData = getDirectionData(route, direction);
  const stops = directionData.stops;

  if (
    !Number.isInteger(startIndex) ||
    !Number.isInteger(endIndex) ||
    startIndex < 0 ||
    endIndex < 0 ||
    startIndex >= stops.length ||
    endIndex >= stops.length
  ) {
    return {
      ok: false,
      code: "INVALID_INDEX",
      message: "Start and end stops must be valid indices for this direction.",
    };
  }

  if (startIndex === endIndex) {
    return {
      ok: false,
      code: "SAME_STOP",
      message: "Start and end stops must be different.",
    };
  }

  if (endIndex < startIndex) {
    return {
      ok: false,
      code: "END_BEFORE_START",
      message: "The destination must come after the starting stop.",
    };
  }

  return {
    ok: true,
    journey: {
      route,
      direction,
      directionData,
      startIndex,
      endIndex,
      startStop: stops[startIndex],
      endStop: stops[endIndex],
      segmentStops: stops.slice(startIndex, endIndex + 1),
    },
  };
}

export function isVerifiedRouteNumber(value: string): boolean {
  return (TEMPU_ROUTE_NUMBERS as readonly string[]).includes(value);
}
