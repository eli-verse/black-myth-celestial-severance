import * as THREE from 'three';
import { WebGPURenderer, RenderPipeline } from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import type BloomNode from 'three/addons/tsl/display/BloomNode.js';
import { smaa } from 'three/addons/tsl/display/SMAANode.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { LAYER_MAIN_ONLY } from './RenderLayers.ts';
import type { RendererBackend, RendererInterface } from '../types/game.ts';

type BackendFlagView = {
  isWebGPUBackend?: boolean;
  isWebGLBackend?: boolean;
};

export interface RendererSystemOptions {
  forceWebGL?: boolean;
}

export class RendererSystem implements RendererInterface {
  private _backend: RendererBackend = 'webgl2';
  private readonly forceWebGLOption?: boolean;
  private container: HTMLElement | null = null;

  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  renderer!: WebGPURenderer;
  renderPipeline!: RenderPipeline;
  bloomPass!: BloomNode;

  private readonly onWindowResize = (): void => {
    this.resize();
  };

  constructor(options?: RendererSystemOptions) {
    this.forceWebGLOption = options?.forceWebGL;
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x07070c);
    this.camera = new THREE.PerspectiveCamera(54, 16 / 9, 0.1, 450);
    this.camera.layers.enable(LAYER_MAIN_ONLY);
    this.camera.position.set(0, 3.8, 12.5);
    this.camera.lookAt(0, 1.4, -0.5);
  }

  get backend(): RendererBackend {
    return this._backend;
  }

  public getPerfStats(): { drawCalls: number; triangles: number; frameCalls: number } {
    const renderInfo = this.renderer?.info?.render;
    return {
      drawCalls: typeof renderInfo?.drawCalls === 'number' ? renderInfo.drawCalls : 0,
      triangles: typeof renderInfo?.triangles === 'number' ? renderInfo.triangles : 0,
      frameCalls: typeof renderInfo?.frameCalls === 'number' ? renderInfo.frameCalls : 0,
    };
  }

  async init(container: HTMLElement): Promise<void> {
    this.container = container;
    const forceWebGL =
      this.forceWebGLOption ??
      new URLSearchParams(window.location.search).get('forceWebGL') === '1';

    const width = Math.max(1, container.clientWidth || window.innerWidth || 1280);
    const height = Math.max(1, container.clientHeight || window.innerHeight || 720);

    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();

    this.renderer = new WebGPURenderer({ antialias: true, forceWebGL });
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(width, height);

    container.appendChild(this.renderer.domElement);

    await this.renderer.init();

    const backendFlags = this.renderer.backend as unknown as BackendFlagView;
    this._backend = backendFlags.isWebGPUBackend ? 'webgpu' : 'webgl2';

    const scenePass = pass(this.scene, this.camera);
    const scenePassColor = scenePass.getTextureNode('output');
    this.bloomPass = bloom(scenePassColor, 0.20, 0.26, 1.08);
    this.renderPipeline = new RenderPipeline(this.renderer);
    this.renderPipeline.outputNode = smaa(scenePassColor.add(this.bloomPass));
    this.renderPipeline.needsUpdate = true;

    window.addEventListener('resize', this.onWindowResize);
  }

  applyEnvironment(
    envMap: THREE.DataTexture,
    environmentIntensity = 1.0,
  ): void {
    envMap.mapping = THREE.EquirectangularReflectionMapping;
    this.scene.environment = envMap;
    this.scene.environmentIntensity = environmentIntensity;
  }

  async loadAndApplyEnvironment(
    url: string,
    environmentIntensity = 1.0,
  ): Promise<THREE.DataTexture> {
    const envMap = await new HDRLoader().loadAsync(url);
    this.applyEnvironment(envMap, environmentIntensity);
    return envMap;
  }

  render(): void {
    if (!this.renderPipeline) {
      return;
    }
    this.renderPipeline.render();
  }

  async prewarmScene(
    onBeforePrewarm?: () => void,
    onAfterPrewarm?: () => void,
  ): Promise<void> {
    if (!this.renderer || !this.renderPipeline) {
      return;
    }
    onBeforePrewarm?.();
    try {
      const compileAsyncFn = (
        this.renderer as unknown as {
          compileAsync?: (scene: THREE.Scene, camera: THREE.Camera) => Promise<unknown>;
        }
      ).compileAsync;
      if (typeof compileAsyncFn === 'function') {
        await compileAsyncFn.call(this.renderer, this.scene, this.camera);
      }
      this.renderPipeline.render();
    } catch {
      // Safe fallback for WebGL2 / headless environments without compileAsync support
    } finally {
      onAfterPrewarm?.();
    }
  }

  resize(width?: number, height?: number): void {
    if (!this.renderer) {
      return;
    }
    const rawFallbackWidth =
      this.container?.clientWidth ||
      (typeof window !== 'undefined' ? window.innerWidth : 0) ||
      1280;
    const rawFallbackHeight =
      this.container?.clientHeight ||
      (typeof window !== 'undefined' ? window.innerHeight : 0) ||
      720;
    const fallbackWidth =
      Number.isFinite(rawFallbackWidth) && rawFallbackWidth > 0
        ? Math.max(1, rawFallbackWidth)
        : 1280;
    const fallbackHeight =
      Number.isFinite(rawFallbackHeight) && rawFallbackHeight > 0
        ? Math.max(1, rawFallbackHeight)
        : 720;
    const targetWidth =
      width !== undefined && Number.isFinite(width) && width > 0
        ? Math.max(1, width)
        : fallbackWidth;
    const targetHeight =
      height !== undefined && Number.isFinite(height) && height > 0
        ? Math.max(1, height)
        : fallbackHeight;
    this.camera.aspect = targetWidth / targetHeight;
    this.camera.updateProjectionMatrix();
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.renderer.setPixelRatio(Math.min(dpr, 2));
    this.renderer.setSize(targetWidth, targetHeight);
  }

  dispose(): void {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.onWindowResize);
    }
    if (this.renderPipeline && typeof this.renderPipeline.dispose === 'function') {
      this.renderPipeline.dispose();
    }
    if (this.renderer) {
      this.renderer.dispose();
      this.renderer.domElement.remove();
    }
    this.container = null;
  }
}
