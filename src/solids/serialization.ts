import type { ISolid, SolidJSON } from './ISolid.js';
import { shellsFromJSON } from './json.js';
import { Solid } from './Solid.js';

/**
 * Rebuilds a solid from the output of `toJSON`, also after a pass through `JSON.stringify`.
 * The result is a general `Solid` whose `type` is the original class name.
 */
export function solidFromJSON(json: SolidJSON): ISolid {
  return new Solid(shellsFromJSON(json), json.type);
}
