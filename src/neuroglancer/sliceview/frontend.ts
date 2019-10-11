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

import debounce from 'lodash/debounce';
import {ChunkState} from 'neuroglancer/chunk_manager/base';
import {Chunk, ChunkManager, ChunkSource} from 'neuroglancer/chunk_manager/frontend';
import {CoordinateSpace} from 'neuroglancer/coordinate_transform';
import {LayerManager} from 'neuroglancer/layer';
import {NavigationState} from 'neuroglancer/navigation_state';
import {SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, SLICEVIEW_RPC_ID, SLICEVIEW_UPDATE_VIEW_RPC_ID, SliceViewBase, SliceViewChunkSource as SliceViewChunkSourceInterface, SliceViewChunkSpecification, SliceViewSourceOptions, TransformedSource, VisibleLayerSources} from 'neuroglancer/sliceview/base';
import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {RenderLayer} from 'neuroglancer/sliceview/renderlayer';
import {getIndicesComplement} from 'neuroglancer/util/array';
import {Disposer, invokeDisposers, RefCounted} from 'neuroglancer/util/disposable';
import {getDependentTransformInputDimensions, kOneVec, mat3, mat4, vec3, vec4} from 'neuroglancer/util/geom';
import * as matrix from 'neuroglancer/util/matrix';
import {MessageList, MessageSeverity} from 'neuroglancer/util/message_list';
import {getObjectId} from 'neuroglancer/util/object_id';
import {NullarySignal} from 'neuroglancer/util/signal';
import {withSharedVisibility} from 'neuroglancer/visibility_priority/frontend';
import {GL} from 'neuroglancer/webgl/context';
import {FramebufferConfiguration, makeTextureBuffers, StencilBuffer} from 'neuroglancer/webgl/offscreen';
import {ShaderBuilder, ShaderModule, ShaderProgram} from 'neuroglancer/webgl/shader';
import {getSquareCornersBuffer} from 'neuroglancer/webgl/square_corners_buffer';
import {registerSharedObjectOwner, RPC} from 'neuroglancer/worker_rpc';

export type GenericChunkKey = string;

const tempMat3 = mat3.create();

class FrontendSliceViewBase extends
    SliceViewBase<SliceViewChunkSource, RenderLayer, FrontendTransformedSource> {}
const Base = withSharedVisibility(FrontendSliceViewBase);

export interface FrontendTransformedSource extends
    TransformedSource<RenderLayer, SliceViewChunkSource> {
  visibleChunks: GenericChunkKey[];
  lowerClipSpatialBound: vec3;
  upperClipSpatialBound: vec3;
}

interface FrontendVisibleLayerSources extends
    VisibleLayerSources<RenderLayer, SliceViewChunkSource, FrontendTransformedSource> {
  transformGeneration: number;
  lastSeenGeneration: number;
  disposers: Disposer[];
  messages: MessageList;
}

function serializeTransformedSource(tsource: TransformedSource<RenderLayer, SliceViewChunkSource>) {
  const msg: any = {
    source: tsource.source.addCounterpartRef(),
    effectiveVoxelSize: tsource.effectiveVoxelSize,
    spatialChunkDimensions: tsource.spatialChunkDimensions,
    fixedChunkDimensions: tsource.fixedChunkDimensions,
    lowerChunkSpatialBound: tsource.lowerChunkSpatialBound,
    upperChunkSpatialBound: tsource.upperChunkSpatialBound,
    fixedLayerToChunkTransform: tsource.fixedLayerToChunkTransform,
  };
  tsource.chunkLayout.toObject(msg);
  return msg;
}

function serializeAllTransformedSources(
    allSources: TransformedSource<RenderLayer, SliceViewChunkSource>[][]) {
  return allSources.map(alternatives => alternatives.map(serializeTransformedSource));
}

function disposeTransformedSources(
    layer: RenderLayer, allSources: TransformedSource<RenderLayer, SliceViewChunkSource>[][]) {
  for (const alternatives of allSources) {
    for (const {source} of alternatives) {
      layer.removeSource(source);
      source.dispose();
    }
  }
}


@registerSharedObjectOwner(SLICEVIEW_RPC_ID)
export class SliceView extends Base {
  gl = this.chunkManager.gl;

  // Transforms viewport coordinates to OpenGL normalized device coordinates
  // [left: -1, right: 1], [top: 1, bottom: -1].
  projectionMat = mat4.create();

  // Equals `projectionMat * viewMat`.
  viewProjectionMat = mat4.create();

  viewChanged = new NullarySignal();

  renderingStale = true;

  visibleChunksStale = true;

  visibleLayerList = new Array<RenderLayer>();

  visibleLayers: Map<RenderLayer, FrontendVisibleLayerSources>;

  offscreenFramebuffer = this.registerDisposer(new FramebufferConfiguration(
      this.gl,
      {colorBuffers: makeTextureBuffers(this.gl, 1), depthBuffer: new StencilBuffer(this.gl)}));

  numVisibleChunks = 0;

  constructor(
      public chunkManager: ChunkManager, public layerManager: LayerManager,
      public navigationState: NavigationState) {
    super();
    const rpc = this.chunkManager.rpc!;
    this.initializeCounterpart(rpc, {
      chunkManager: chunkManager.rpcId,
    });
    this.registerDisposer(navigationState.changed.add(this.debouncedUpdateNavigationState));
    this.registerDisposer(layerManager.layersChanged.add(() => {
      if (this.valid) {
        this.updateVisibleLayers();
      }
    }));

    this.viewChanged.add(() => {
      this.renderingStale = true;
    });
    this.registerDisposer(chunkManager.chunkQueueManager.visibleChunksChanged.add(() => {
      this.viewChanged.dispatch();
    }));

    this.updateViewportFromNavigationState();
    this.updateVisibleLayers();
  }

  private debouncedUpdateNavigationState =
      this.registerCancellable(debounce(() => this.updateViewportFromNavigationState(), 0));

  ensureViewMatrixUpdated() {
    this.debouncedUpdateNavigationState.flush();
  }

  isReady() {
    this.ensureViewMatrixUpdated();
    this.setViewportSizeDebounced.flush();
    if (!this.valid) {
      return false;
    }
    this.maybeUpdateVisibleChunks();
    let numValidChunks = 0;
    for (const {visibleSources} of this.visibleLayers.values()) {
      for (const tsource of visibleSources) {
        const {source} = tsource;
        const {chunks} = source;
        for (const key of tsource.visibleChunks) {
          const chunk = chunks.get(key);
          if (chunk && chunk.state === ChunkState.GPU_MEMORY) {
            ++numValidChunks;
          }
        }
      }
    }
    return numValidChunks === this.numVisibleChunks;
  }

  private getTransformedSources(layer: RenderLayer, messages: MessageList):
      FrontendTransformedSource[][] {
    messages.clearMessages();
    const transform = layer.transform.value;
    const globalTransform = this.globalTransform!;
    const returnError = (message: string) => {
      messages.addMessage({
        severity: MessageSeverity.error,
        message,
      });
      return [];
    };
    if (transform.error !== undefined) {
      return returnError(transform.error);
    }
    const modelSpace = layer.multiscaleSource.modelSpace;
    const rank = modelSpace.rank;
    const globalRank = this.globalPosition.length;
    const {
      globalToRenderLayerDimensions,
      localToRenderLayerDimensions,
      modelToRenderLayerTransform
    } = transform;
    const localRank = localToRenderLayerDimensions.length;
    const spatialLayerDimensions: number[] = [];
    const allSpatialLayerDimensions: number[] = [];
    const fullRank = globalRank + localRank;
    const {displayDimensionIndices, displayRank} = globalTransform;
    for (let i = 0; i < displayRank; ++i) {
      const globalDim = displayDimensionIndices[i];
      const layerDim = globalToRenderLayerDimensions[globalDim];
      allSpatialLayerDimensions.push(layerDim);
      if (layerDim === -1) continue;
      spatialLayerDimensions.push(layerDim);
    }
    const sources = layer.multiscaleSource.getSources({
      transform: modelToRenderLayerTransform,
      spatialLayerDimensions,
    });
    const {voxelPhysicalScales: globalScales} = globalTransform;
    try {
      const getTransformedSource = (source: SliceViewChunkSource): FrontendTransformedSource => {
        const combinedTransform = new Float32Array((rank + 1) * (rank + 1));
        const invCombinedTransform = new Float32Array((rank + 1) * (rank + 1));
        matrix.multiply(
            combinedTransform, rank + 1, modelToRenderLayerTransform, rank + 1,
            source.spec.transform, rank + 1, rank + 1, rank + 1, rank + 1);
        if (matrix.inverse(
                invCombinedTransform, rank + 1, combinedTransform, rank + 1, rank + 1) === 0) {
          throw new Error(`Transform is singular`);
        }
        const numSpatialDims = spatialLayerDimensions.length;
        const spatialChunkDimensions =
            getDependentTransformInputDimensions(combinedTransform, rank, spatialLayerDimensions);
        if (spatialChunkDimensions.length !== numSpatialDims) {
          const {modelDimensionNames, layerDimensionNames} = transform;
          throw new Error(
              `Rank mismatch between rendered layer dimensions ` +
              `(${Array.from(spatialLayerDimensions, i => layerDimensionNames[i]).join(',\u00a0')}) ` +
              `and corresponding model dimensions ` +
              `(${Array.from(spatialChunkDimensions, i => modelDimensionNames[i]).join(',\u00a0')})`);
        }
        // Compute `chunkSpatialSize`, and `{lower,upper}ChunkSpatialBound`.
        const lowerChunkSpatialBound = vec3.create();
        const upperChunkSpatialBound = vec3.create();
        const lowerClipSpatialBound = vec3.create();
        const upperClipSpatialBound = vec3.create();
        const chunkSpatialSize = vec3.create();
        for (let chunkSpatialDimIndex = 0; chunkSpatialDimIndex < numSpatialDims;
             ++chunkSpatialDimIndex) {
          const chunkDim = spatialChunkDimensions[chunkSpatialDimIndex];
          chunkSpatialSize[chunkSpatialDimIndex] = source.spec.chunkDataSize[chunkDim];
          lowerChunkSpatialBound[chunkSpatialDimIndex] = source.spec.lowerChunkBound[chunkDim];
          upperChunkSpatialBound[chunkSpatialDimIndex] = source.spec.upperChunkBound[chunkDim];
          lowerClipSpatialBound[chunkSpatialDimIndex] = source.spec.lowerClipBound[chunkDim];
          upperClipSpatialBound[chunkSpatialDimIndex] = source.spec.upperClipBound[chunkDim];
        }
        chunkSpatialSize.fill(1, numSpatialDims);
        lowerChunkSpatialBound.fill(0, numSpatialDims);
        upperChunkSpatialBound.fill(1, numSpatialDims);
        lowerClipSpatialBound.fill(0, numSpatialDims);
        upperClipSpatialBound.fill(1, numSpatialDims);
        // Compute `spatialTransform`.
        const spatialTransform = mat4.create();
        for (let globalSpatialDimIndex = 0; globalSpatialDimIndex < displayRank;
             ++globalSpatialDimIndex) {
          const layerDim = allSpatialLayerDimensions[globalSpatialDimIndex];
          if (layerDim === -1) continue;
          for (let chunkSpatialDimIndex = 0; chunkSpatialDimIndex < numSpatialDims;
               ++chunkSpatialDimIndex) {
            const chunkDim = spatialChunkDimensions[chunkSpatialDimIndex];
            spatialTransform[chunkSpatialDimIndex * 4 + globalSpatialDimIndex] =
                combinedTransform[chunkDim * (rank + 1) + layerDim];
          }
          spatialTransform[12 + globalSpatialDimIndex] =
              combinedTransform[rank * (rank + 1) + layerDim];
        }
        const chunkLayout = ChunkLayout.get(chunkSpatialSize, spatialTransform);
        // This is an approximation of the voxel size (exact only for permutation/scaling
        // transforms).  It would be better to model the voxel as an ellipsiod and find the lengths
        // of the axes.
        const effectiveVoxelSize =
            chunkLayout.localSpatialVectorToGlobal(vec3.create(), /*baseVoxelSize=*/ kOneVec);
        for (let i = 0; i < displayRank; ++i) {
          effectiveVoxelSize[i] *= globalScales[i];
        }
        effectiveVoxelSize.fill(1, displayRank);

        // Compute `fixedLayerToChunkTransform`.
        const fixedLayerToChunkTransform = new Float32Array((fullRank + 1) * rank);
        for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
          for (let globalDim = 0; globalDim < globalRank; ++globalDim) {
            const layerDim = globalToRenderLayerDimensions[globalDim];
            if (layerDim === -1) continue;
            fixedLayerToChunkTransform[chunkDim + globalDim * rank] =
                invCombinedTransform[chunkDim + layerDim * (rank + 1)];
          }
          for (let localDim = 0; localDim < localRank; ++localDim) {
            const layerDim = localToRenderLayerDimensions[localDim];
            if (layerDim === -1) continue;
            fixedLayerToChunkTransform[chunkDim + (globalRank + localDim) * rank] =
                invCombinedTransform[chunkDim + layerDim * (rank + 1)];
          }
          fixedLayerToChunkTransform[chunkDim + fullRank * rank] =
              invCombinedTransform[chunkDim + rank * (rank + 1)];
        }
        while (true) {
          let i = spatialChunkDimensions.length;
          if (i >= 3) break;
          spatialChunkDimensions[i] = -1;
        }
        return {
          renderLayer: layer,
          source,
          lowerChunkSpatialBound,
          upperChunkSpatialBound,
          lowerClipSpatialBound,
          upperClipSpatialBound,
          effectiveVoxelSize,
          chunkLayout,
          spatialChunkDimensions,
          fixedChunkDimensions: getIndicesComplement(spatialChunkDimensions, rank),
          fixedLayerToChunkTransform,
          curPositionInChunks: new Float32Array(rank),
          fixedPositionWithinChunk: new Uint32Array(rank),
          visibleChunks: [],
        };
      };
      const transformedSources =
          sources.map(alternatives => alternatives.map(source => getTransformedSource(source)));
      for (const alternatives of sources) {
        for (const source of alternatives) {
          layer.addSource(source);
        }
      }
      return transformedSources;
    } catch (e) {
      // Ensure references are released in the case of an exception.
      for (const alternatives of sources) {
        for (const source of alternatives) {
          source.dispose();
        }
      }
      const {globalDimensionNames} = globalTransform;
      const dimensionDesc = Array
                                .from(
                                    globalTransform.displayDimensionIndices.filter(i => i !== -1),
                                    i => globalDimensionNames[i])
                                .join(',\u00a0');
      const message = `Cannot render (${dimensionDesc}) cross section: ${e.message}`;
      return returnError(message);
    }
  }

  private updateViewportFromNavigationState() {
    let {navigationState} = this;
    let viewportChanged = false;
    let globalTransformChanged = false;
    let {globalTransform} = this;
    if (!navigationState.valid) {
      if (globalTransform !== undefined) {
        globalTransform = this.globalTransform = undefined;
        globalTransformChanged = true;
      }
    } else {
      navigationState.toMat3(tempMat3);
      const coordinateSpace = navigationState.coordinateSpace.value!;
      const newRank = coordinateSpace.rank;
      const {renderDimensions} = navigationState.pose;
      if (globalTransform === undefined || globalTransform.globalRank !== newRank ||
          globalTransform.generation !== renderDimensions.changed.count) {
        const displayDimensions = renderDimensions.value;
        globalTransformChanged = true;
        globalTransform = this.globalTransform = {
          globalRank: newRank,
          displayRank: displayDimensions.rank,
          globalDimensionNames: coordinateSpace.dimensionNames,
          displayDimensionIndices: displayDimensions.dimensionIndices,
          voxelPhysicalScales: displayDimensions.voxelPhysicalScales,
          canonicalVoxelFactors: displayDimensions.canonicalVoxelFactors,
          generation: renderDimensions.changed.count,
        };
      }
      if (this.setViewportToDataMatrix(tempMat3, navigationState.position.value)) {
        viewportChanged = true;
      }
    }
    if (globalTransformChanged) {
      this.updateVisibleLayers();
    }
    if (viewportChanged || globalTransformChanged) {
      this.invalidateVisibleSources();
      const msg: any = {id: this.rpcId};
      if (viewportChanged) {
        msg.viewportToData = tempMat3;
        msg.globalPosition = this.globalPosition;
      }
      if (globalTransformChanged) {
        msg.globalTransform = globalTransform;
      }
      this.rpc!.invoke(SLICEVIEW_UPDATE_VIEW_RPC_ID, msg);
      this.updateViewportToDevice();
    }
  }

  private updateVisibleLayers = this.registerCancellable(debounce(() => {
    this.updateVisibleLayersNow();
  }, 0));

  private invalidateVisibleSources = (() => {
    this.visibleSourcesStale = true;
    this.viewChanged.dispatch();
  });

  private bindVisibleRenderLayer(renderLayer: RenderLayer, disposers: Disposer[]) {
    disposers.push(renderLayer.localPosition.changed.add(this.invalidateVisibleChunks));
    disposers.push(renderLayer.redrawNeeded.add(this.viewChanged.dispatch));
    disposers.push(renderLayer.transform.changed.add(this.updateVisibleLayers));
    disposers.push(renderLayer.renderScaleTarget.changed.add(this.invalidateVisibleSources));
    const {renderScaleHistogram} = renderLayer;
    if (renderScaleHistogram !== undefined) {
      disposers.push(renderScaleHistogram.visibility.add(this.visibility));
    }
  }

  private updateVisibleLayersNow() {
    if (this.wasDisposed) {
      return false;
    }
    this.ensureViewMatrixUpdated();
    if (this.globalTransform === undefined) {
      return false;
    }
    // Used to determine which layers are no longer visible.
    const curUpdateGeneration = Date.now();
    const {visibleLayers, visibleLayerList} = this;
    const globalTransform = this.globalTransform!;
    let rpc = this.rpc!;
    let rpcMessage: any = {'id': this.rpcId};
    let changed = false;
    visibleLayerList.length = 0;
    for (let renderLayer of this.layerManager.readyRenderLayers()) {
      if (renderLayer instanceof RenderLayer) {
        visibleLayerList.push(renderLayer);
        let layerInfo = visibleLayers.get(renderLayer);
        if (layerInfo === undefined) {
          const disposers: Disposer[] = [];
          const messages = new MessageList();
          layerInfo = {
            messages,
            allSources: this.getTransformedSources(renderLayer, messages),
            transformGeneration: renderLayer.transform.changed.count,
            visibleSources: [],
            disposers,
            lastSeenGeneration: curUpdateGeneration,
            globalTransform,
          };
          disposers.push(renderLayer.messages.addChild(layerInfo.messages));
          visibleLayers.set(renderLayer.addRef(), layerInfo);
          this.bindVisibleRenderLayer(renderLayer, disposers);
        } else {
          layerInfo.lastSeenGeneration = curUpdateGeneration;
          const curTransformGeneration = renderLayer.transform.changed.count;
          if (layerInfo.transformGeneration === curTransformGeneration &&
              layerInfo.globalTransform === globalTransform) {
            continue;
          }
          const allSources = layerInfo.allSources;
          layerInfo.allSources = this.getTransformedSources(renderLayer, layerInfo.messages);
          disposeTransformedSources(renderLayer, allSources);
          layerInfo.visibleSources.length = 0;
          layerInfo.globalTransform = globalTransform;
          layerInfo.transformGeneration = curTransformGeneration;
        }
        rpcMessage['layerId'] = renderLayer.rpcId;
        rpcMessage['sources'] = serializeAllTransformedSources(layerInfo.allSources);
        rpc.invoke(SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID, rpcMessage);
        changed = true;
      }
    }
    for (const [renderLayer, layerInfo] of visibleLayers) {
      if (layerInfo.lastSeenGeneration === curUpdateGeneration) continue;
      rpcMessage['layerId'] = renderLayer.rpcId;
      rpc.invoke(SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID, rpcMessage);
      visibleLayers.delete(renderLayer);
      disposeTransformedSources(renderLayer, layerInfo.allSources);
      invokeDisposers(layerInfo.disposers);
      renderLayer.dispose();
      changed = true;
    }
    if (changed) {
      this.visibleSourcesStale = true;
    }
    // Unconditionally call viewChanged, because layers may have been reordered even if the set of
    // sources is the same.
    this.viewChanged.dispatch();
    return changed;
  }

  private updateViewportToDevice() {
    var {width, height, projectionMat, viewMatrix, viewProjectionMat} = this;
    // FIXME: Make this adjustable.
    const sliceThickness = 10;
    mat4.ortho(
        projectionMat, -width / 2, width / 2, height / 2, -height / 2, -sliceThickness,
        sliceThickness);
    mat4.multiply(viewProjectionMat, projectionMat, viewMatrix);
    this.invalidateVisibleChunks();
  }
  setViewportSizeDebounced = this.registerCancellable(
      debounce((width: number, height: number) => this.setViewportSize(width, height), 0));

  private invalidateVisibleChunks = () => {
    this.visibleChunksStale = true;
    this.viewChanged.dispatch();
  };

  setViewportSize(width: number, height: number) {
    this.setViewportSizeDebounced.cancel();
    if (super.setViewportSize(width, height)) {
      this.rpc!.invoke(
          SLICEVIEW_UPDATE_VIEW_RPC_ID, {id: this.rpcId, width: width, height: height});
      this.updateViewportToDevice();
      return true;
    }
    return false;
  }

  updateRendering() {
    this.ensureViewMatrixUpdated();
    this.setViewportSizeDebounced.flush();
    if (!this.renderingStale || this.globalTransform === undefined || this.width === 0 ||
        this.height === 0) {
      return;
    }
    this.renderingStale = false;
    this.maybeUpdateVisibleChunks();

    let {gl, offscreenFramebuffer, width, height} = this;

    offscreenFramebuffer.bind(width!, height!);
    gl.disable(gl.SCISSOR_TEST);

    // we have viewportToData
    // we need: matrix that maps input x to the output x axis, scaled by

    gl.clearStencil(0);
    gl.clearColor(0, 0, 0, 0);
    gl.colorMask(true, true, true, true);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.stencilOpSeparate(
        /*face=*/ gl.FRONT_AND_BACK, /*sfail=*/ gl.KEEP, /*dpfail=*/ gl.KEEP,
        /*dppass=*/ gl.REPLACE);

    let renderLayerNum = 0;
    for (let renderLayer of this.visibleLayerList) {
      gl.clear(gl.STENCIL_BUFFER_BIT);
      gl.stencilFuncSeparate(
          /*face=*/ gl.FRONT_AND_BACK,
          /*func=*/ gl.GREATER,
          /*ref=*/ 1,
          /*mask=*/ 1);

      renderLayer.setGLBlendMode(gl, renderLayerNum);
      renderLayer.draw(this);
      ++renderLayerNum;
    }
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    offscreenFramebuffer.unbind();
  }

  maybeUpdateVisibleChunks() {
    this.updateVisibleLayers.flush();
    if (!this.visibleChunksStale && !this.visibleSourcesStale) {
      return false;
    }
    this.visibleChunksStale = false;
    this.updateVisibleChunks();
    return true;
  }

  updateVisibleChunks() {
    function getLayoutObject(_chunkLayout: ChunkLayout) {
      return undefined;
    }
    let numVisibleChunks = 0;
    function addChunk(
        _chunkLayout: ChunkLayout, _chunkObject: undefined, _positionInChunks: vec3,
        sources: FrontendTransformedSource[]) {
      for (const tsource of sources) {
        tsource.visibleChunks.push(tsource.curPositionInChunks.join());
      }
      numVisibleChunks += sources.length;
    }
    this.computeVisibleChunks(/*initialize=*/ () => {
      for (const layerInfo of this.visibleLayers.values()) {
        for (const tsource of layerInfo.visibleSources) {
          tsource.visibleChunks.length = 0;
        }
      }
    }, getLayoutObject, addChunk);
    this.numVisibleChunks = numVisibleChunks;
  }

  disposed() {
    for (const [renderLayer, layerInfo] of this.visibleLayers) {
      disposeTransformedSources(renderLayer, layerInfo.allSources);
      invokeDisposers(layerInfo.disposers);
      renderLayer.dispose();
    }
    this.visibleLayers.clear();
    this.visibleLayerList.length = 0;
  }
}

export interface SliceViewChunkSourceOptions {
  spec: SliceViewChunkSpecification;
}

export abstract class SliceViewChunkSource extends ChunkSource implements
    SliceViewChunkSourceInterface {
  chunks: Map<string, SliceViewChunk>;

  spec: SliceViewChunkSpecification;

  constructor(chunkManager: ChunkManager, options: SliceViewChunkSourceOptions) {
    super(chunkManager, options);
    this.spec = options.spec;
  }

  static encodeOptions(options: SliceViewChunkSourceOptions) {
    const encoding = super.encodeOptions(options);
    encoding.spec = options.spec.toObject();
    return encoding;
  }

  initializeCounterpart(rpc: RPC, options: any) {
    options['spec'] = this.spec.toObject();
    super.initializeCounterpart(rpc, options);
  }
}

export interface SliceViewChunkSource {
  // TODO(jbms): Move this declaration to the class definition above and declare abstract once
  // TypeScript supports mixins with abstact classes.
  getChunk(x: any): any;
}

export class SliceViewChunk extends Chunk {
  chunkGridPosition: vec3;
  source: SliceViewChunkSource;

  constructor(source: SliceViewChunkSource, x: any) {
    super(source);
    this.chunkGridPosition = x['chunkGridPosition'];
    this.state = ChunkState.SYSTEM_MEMORY;
  }
}

/**
 * Helper for rendering a SliceView that has been pre-rendered to a texture.
 */
export class SliceViewRenderHelper extends RefCounted {
  private copyVertexPositionsBuffer = getSquareCornersBuffer(this.gl);
  private shader: ShaderProgram;

  private textureCoordinateAdjustment = new Float32Array(4);

  constructor(public gl: GL, emitter: ShaderModule) {
    super();
    let builder = new ShaderBuilder(gl);
    builder.addVarying('vec2', 'vTexCoord');
    builder.addUniform('sampler2D', 'uSampler');
    builder.addInitializer(shader => {
      gl.uniform1i(shader.uniform('uSampler'), 0);
    });
    builder.addUniform('vec4', 'uColorFactor');
    builder.addUniform('vec4', 'uBackgroundColor');
    builder.addUniform('mat4', 'uProjectionMatrix');
    builder.addUniform('vec4', 'uTextureCoordinateAdjustment');
    builder.require(emitter);
    builder.setFragmentMain(`
vec4 sampledColor = texture(uSampler, vTexCoord);
if (sampledColor.a == 0.0) {
  sampledColor = uBackgroundColor;
}
emit(sampledColor * uColorFactor, 0u);
`);
    builder.addAttribute('vec4', 'aVertexPosition');
    builder.setVertexMain(`
vTexCoord = uTextureCoordinateAdjustment.xy + 0.5 * (aVertexPosition.xy + 1.0) * uTextureCoordinateAdjustment.zw;
gl_Position = uProjectionMatrix * aVertexPosition;
`);
    this.shader = this.registerDisposer(builder.build());
  }

  draw(
      texture: WebGLTexture|null, projectionMatrix: mat4, colorFactor: vec4, backgroundColor: vec4,
      xStart: number, yStart: number, xEnd: number, yEnd: number) {
    let {gl, shader, textureCoordinateAdjustment} = this;
    textureCoordinateAdjustment[0] = xStart;
    textureCoordinateAdjustment[1] = yStart;
    textureCoordinateAdjustment[2] = xEnd - xStart;
    textureCoordinateAdjustment[3] = yEnd - yStart;
    shader.bind();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniformMatrix4fv(shader.uniform('uProjectionMatrix'), false, projectionMatrix);
    gl.uniform4fv(shader.uniform('uColorFactor'), colorFactor);
    gl.uniform4fv(shader.uniform('uBackgroundColor'), backgroundColor);
    gl.uniform4fv(shader.uniform('uTextureCoordinateAdjustment'), textureCoordinateAdjustment);

    let aVertexPosition = shader.attribute('aVertexPosition');
    this.copyVertexPositionsBuffer.bindToVertexAttrib(aVertexPosition, /*components=*/ 2);

    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);

    gl.disableVertexAttribArray(aVertexPosition);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  static get(gl: GL, emitter: ShaderModule) {
    return gl.memoize.get(
        `sliceview/SliceViewRenderHelper:${getObjectId(emitter)}`,
        () => new SliceViewRenderHelper(gl, emitter));
  }
}

export abstract class MultiscaleSliceViewChunkSource {
  /**
   * Specifies the "multiscale model" coordinate space.
   *
   * This may be used to pick a default coordinate space and position, and the bounding box may be
   * displayed, but does not affect rendering.
   */
  modelSpace: CoordinateSpace;

  /**
   * @return Chunk sources for each scale, ordered by increasing minVoxelSize.  For each scale,
   * there may be alternative sources with different chunk layouts.
   *
   * Every chunk source must have rank equal to `modelSpace.rank`.
   */
  abstract getSources(options: SliceViewSourceOptions): SliceViewChunkSource[][];

  chunkManager: ChunkManager;
}
