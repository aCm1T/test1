import { PerspectiveCamera, Scene } from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { CSMHelper } from 'three/addons/csm/CSMHelper.js';
import { describe, expect, it } from 'vitest';
import { disposeCsm, initializeCsmHelper } from '../../src/engine/CascadedShadows';

describe('cascaded shadow lifecycle', () => {
  it('initializes an invisible helper before safely removing every cascade light', () => {
    const scene = new Scene();
    const camera = new PerspectiveCamera(75, 16 / 9, 0.1, 200);
    const csm = new CSM({ camera, parent: scene, cascades: 2, maxFar: 80 });
    const helper = new CSMHelper(csm);
    helper.visible = false;
    scene.add(helper);

    initializeCsmHelper(helper);
    expect(helper.shadowLines).toHaveLength(2);
    expect(csm.lights.every((light) => scene.children.includes(light))).toBe(true);

    expect(() => disposeCsm(csm, helper)).not.toThrow();
    expect(scene.children).not.toContain(helper);
    expect(csm.lights.every((light) => !scene.children.includes(light))).toBe(true);
  });
});
