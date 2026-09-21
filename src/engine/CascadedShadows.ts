import type { CSM } from 'three/addons/csm/CSM.js';
import type { CSMHelper } from 'three/addons/csm/CSMHelper.js';

/**
 * CSMHelper allocates its per-cascade debug geometry lazily in update(). Its
 * upstream dispose() assumes that allocation already happened, even when the
 * helper stayed invisible for its entire life. Prime it once so later quality
 * changes can dispose it safely.
 */
export function initializeCsmHelper(helper: CSMHelper): void {
  helper.update();
  helper.updateVisibility();
}

/** Remove both debug geometry and the cascade lights from their scene. */
export function disposeCsm(csm: CSM, helper: CSMHelper): void {
  // Refresh before disposal in case the cascade count changed in place.
  helper.update();
  helper.dispose();
  helper.removeFromParent();
  csm.remove();
  csm.dispose();
}
