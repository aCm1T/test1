import {
  AmbientLight,
  BackSide,
  Color,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  type WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Install dusk IBL + sky dome so MeshStandardMaterial metals don't crush to black
 * and the horizon isn't a misleading equirect "fake ground".
 */
export function setupEnvironment(
  renderer: WebGLRenderer,
  scene: Scene,
): { dispose: () => void } {
  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 1.05;

  const ambient = new AmbientLight(0x6a6870, 0.55);
  ambient.name = 'AmbientDusk';
  scene.add(ambient);

  renderer.setClearColor(0x1a2438, 1);
  scene.background = new Color(0x1c2430);

  const skyGeo = new SphereGeometry(380, 32, 16);
  const skyMat = new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      topColor: { value: new Color(0x0c1420) },
      midColor: { value: new Color(0xc45a28) },
      botColor: { value: new Color(0x2a3340) },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = normalize(world.xyz - cameraPosition);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 botColor;
      varying vec3 vWorld;
      void main() {
        float h = normalize(vWorld).y;
        vec3 col = mix(botColor, midColor, smoothstep(-0.2, 0.05, h));
        col = mix(col, topColor, smoothstep(0.05, 0.7, h));
        float sun = exp(-pow(length(normalize(vWorld) - normalize(vec3(-0.75, 0.12, 0.2))) * 2.8, 2.0));
        col += vec3(1.0, 0.45, 0.15) * sun * 0.55;
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const sky = new Mesh(skyGeo, skyMat);
  sky.name = 'DuskSkyDome';
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);

  const dispose = (): void => {
    scene.remove(ambient);
    ambient.dispose();
    scene.remove(sky);
    skyGeo.dispose();
    skyMat.dispose();
    if (scene.environment === envRT.texture) {
      scene.environment = null;
    }
    envRT.dispose();
    pmrem.dispose();
  };

  return { dispose };
}
