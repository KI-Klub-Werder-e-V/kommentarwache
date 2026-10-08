import type { MapperName } from '@kommentarwache/contract';
import type { Battery } from '@kommentarwache/contract';
import { BATTERY_V1 } from './v1.js';
import { BATTERY_V2 } from './v2.js';

/** Batteries known to the code, by short name. The mapper name is what the DB stores. */
export const BATTERIES: Record<string, { battery: Battery; mapper: MapperName }> = {
  v1: { battery: BATTERY_V1, mapper: 'v1' },
  v2: { battery: BATTERY_V2, mapper: 'v2' },
};
export const DEFAULT_BATTERY = 'v2';

export { BATTERY_V1, BATTERY_V2 };
