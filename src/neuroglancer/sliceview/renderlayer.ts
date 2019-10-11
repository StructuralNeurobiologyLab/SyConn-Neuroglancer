/**
 * @license
 * Copyright 2016 Google Inc.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {ChunkManager} from 'neuroglancer/chunk_manager/frontend';
import {RenderScaleHistogram, trackableRenderScaleTarget} from 'neuroglancer/render_scale_statistics';
import {RenderLayer as GenericRenderLayer, RenderLayerTransform, RenderLayerTransformOrError, ThreeDimensionalRenderContext, VisibilityTrackedRenderLayer} from 'neuroglancer/renderlayer';
import {SharedWatchableValue} from 'neuroglancer/shared_watchable_value';
import {SLICEVIEW_RENDERLAYER_RPC_ID} from 'neuroglancer/sliceview/base';
import {MultiscaleSliceViewChunkSource, SliceView, SliceViewChunkSource} from 'neuroglancer/sliceview/frontend';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {Borrowed} from 'neuroglancer/util/disposable';
import * as matrix from 'neuroglancer/util/matrix';
import {ShaderModule} from 'neuroglancer/webgl/shader';
import {RpcId} from 'neuroglancer/worker_rpc';
import {SharedObject} from 'neuroglancer/worker_rpc';

export interface RenderLayerOptions {
  /**
   * Specifies the transform from the "model" coordinate space (specified by the multiscale source)
   * to the "render layer" coordinate space.
   */
  transform: WatchableValueInterface<RenderLayerTransformOrError>;
  renderScaleTarget?: WatchableValueInterface<number>;
  renderScaleHistogram?: RenderScaleHistogram;

  /**
   * Specifies the position within the "local" coordinate space.
   */
  localPosition: WatchableValueInterface<Float32Array>;
}

export interface VisibleSourceInfo {
  source: Borrowed<SliceViewChunkSource>;
  refCount: number;
  transform?: RenderLayerTransform|undefined;
  inverseTransformMatrix?: Float32Array|undefined;
}

export abstract class RenderLayer extends GenericRenderLayer {
  rpcId: RpcId|null = null;

  localPosition: WatchableValueInterface<Float32Array>;

  transform: WatchableValueInterface<RenderLayerTransformOrError>;

  renderScaleTarget: WatchableValueInterface<number>;
  renderScaleHistogram?: RenderScaleHistogram;

  /**
   * Currently visible sources for this render layer.
   */
  private visibleSources = new Map<Borrowed<SliceViewChunkSource>, VisibleSourceInfo>();

  /**
   * Cached list of sources in `visibleSources`, ordered by voxel size.
   *
   * Truncated to zero length when `visibleSources` changes to indicate that it is invalid.
   */
  private visibleSourcesList_: VisibleSourceInfo[] = [];

  getInverseTransform(info: VisibleSourceInfo): Float32Array|undefined {
    const {transform: {value: transform}} = this;
    if (transform.error !== undefined) return undefined;
    if (info.transform !== transform) {
      info.transform = transform;
      const {source: {spec: {rank, transform: sourceTransform}}} = info;
      const fullTransform = new Float32Array((rank + 1) ** 2);
      matrix.multiply(
          fullTransform, rank + 1, transform.modelToRenderLayerTransform, rank + 1, sourceTransform,
          rank + 1, rank + 1, rank + 1, rank + 1)
      matrix.inverseInplace(fullTransform, rank + 1, rank + 1);
      info.inverseTransformMatrix = fullTransform;
    }
    return info.inverseTransformMatrix;
  }

  addSource(source: Borrowed<SliceViewChunkSource>) {
    const {visibleSources} = this;
    const info = visibleSources.get(source);
    if (info !== undefined) {
      ++info.refCount;
    } else {
      visibleSources.set(source, {source, refCount: 1});
      this.visibleSourcesList_.length = 0;
    }
  }

  removeSource(source: Borrowed<SliceViewChunkSource>) {
    const {visibleSources} = this;
    const info = visibleSources.get(source)!;
    if (info.refCount !== 1) {
      --info.refCount;
    } else {
      visibleSources.delete(source);
      this.visibleSourcesList_.length = 0;
    }
  }

  get visibleSourcesList() {
    const {visibleSources, visibleSourcesList_} = this;
    if (visibleSourcesList_.length === 0 && visibleSources.size !== 0) {
      for (const info of visibleSources.values()) {
        visibleSourcesList_.push(info);
      }
      // Sort by volume scaling factor.
      visibleSourcesList_.sort((a, b) => {
        return a.source.spec.transformDeterminant - b.source.spec.transformDeterminant;
      });
    }
    return visibleSourcesList_;
  }


  constructor(
      public chunkManager: ChunkManager, public multiscaleSource: MultiscaleSliceViewChunkSource,
      options: RenderLayerOptions) {
    super();

    const {renderScaleTarget = trackableRenderScaleTarget(1)} = options;
    this.renderScaleTarget = renderScaleTarget;
    this.renderScaleHistogram = options.renderScaleHistogram;
    this.transform = options.transform;
    this.localPosition = options.localPosition;
    const sharedObject = this.registerDisposer(new SharedObject());
    const rpc = this.chunkManager.rpc!;
    sharedObject.RPC_TYPE_ID = SLICEVIEW_RENDERLAYER_RPC_ID;
    sharedObject.initializeCounterpart(rpc, {
      nonGlobalPosition:
          this.registerDisposer(SharedWatchableValue.makeFromExisting(rpc, this.localPosition))
              .rpcId,
      renderScaleTarget:
          this.registerDisposer(SharedWatchableValue.makeFromExisting(rpc, this.renderScaleTarget))
              .rpcId,
    });
    this.rpcId = sharedObject.rpcId;
    this.setReady(true);
  }

  get gl() {
    return this.chunkManager.chunkQueueManager.gl;
  }

  setGLBlendMode(gl: WebGL2RenderingContext, renderLayerNum: number): void {
    // Default blend mode for non-blend-mode-aware layers
    if (renderLayerNum > 0) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }
  }
  abstract draw(sliceView: SliceView): void;
}

export interface SliceViewPanelRenderContext extends ThreeDimensionalRenderContext {
  emitter: ShaderModule;

  /**
   * Specifies whether the emitted color value will be used.
   */
  emitColor: boolean;

  /**
   * Specifies whether the emitted pick ID will be used.
   */
  emitPickID: boolean;

  sliceView: SliceView;
}

export class SliceViewPanelRenderLayer extends VisibilityTrackedRenderLayer {
  draw(_renderContext: SliceViewPanelRenderContext) {
    // Must be overridden by subclasses.
  }

  isReady() {
    return true;
  }
}
