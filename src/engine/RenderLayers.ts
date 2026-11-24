import type * as THREE from 'three';

/** Layer 0: Rendered by both Main Camera and Water-Mirror Reflector Virtual Camera. */
export const LAYER_DEFAULT = 0;

/** Layer 1: Rendered ONLY by Main Camera, excluded from groundReflector. */
export const LAYER_MAIN_ONLY = 1;

/**
 * Assigns a render layer to an Object3D and every descendant node.
 * Required because Three.js StandardDrawingPipeline tests layers per-object
 * while still traversing child hierarchies.
 */
export function setObjectLayerRecursive(
  root: THREE.Object3D,
  layer: number,
): void {
  root.traverse((obj) => {
    obj.layers.set(layer);
  });
}
