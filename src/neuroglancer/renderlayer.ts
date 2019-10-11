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

import {CoordinateSpace, CoordinateSpaceTransform, transformSubmatrix} from 'neuroglancer/coordinate_transform';
import {MouseSelectionState} from 'neuroglancer/layer';
import {PickIDManager} from 'neuroglancer/object_picking';
import {CachedWatchableValue, makeCachedDerivedWatchableValue, WatchableSet, WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {mat4} from 'neuroglancer/util/geom';
import {getDependentTransformInputDimensions} from 'neuroglancer/util/geom';
import {NullarySignal} from 'neuroglancer/util/signal';
import {Uint64} from 'neuroglancer/util/uint64';
import {VisibilityPriorityAggregator} from 'neuroglancer/visibility_priority/frontend';
import { RenderDimensions } from './navigation_state';
import { MessageList } from './util/message_list';

export enum RenderLayerRole {
  DATA,
  ANNOTATION,
  DEFAULT_ANNOTATION,
}

export function allRenderLayerRoles() {
  return new WatchableSet(
      [RenderLayerRole.DATA, RenderLayerRole.ANNOTATION, RenderLayerRole.DEFAULT_ANNOTATION]);
}


/**
 * The "global" coordinate space is the common coordinate space shared by all layers.  The global
 * position is specific to a particular LayerGroupViewer; therefore, within a given frame, the same
 * RenderLayer may be rendered using multiple different global positions.  Only global dimensions
 * may serve as spatial dimensions for the slice view.
 *
 * The "user layer" coordinate space is the common coordinate space used by all render layers for a
 * single user layer.  The global dimensions within the "user layer" consitute a subset of the full
 * set of "global" dimensions (i.e. name not ending with "'"), while the "local" dimensions for the
 * "user layer" are precisely the set of local dimensions (i.e. name ending with "'") within the
 * "user layer" coordinate space.
 *
 * The underlying data source for the layer has an associated (fixed) "model" coordinate space.
 *
 * The render layer has an associated "render layer" coordinate space, which is a subspace of the
 * "user layer" coordinate space, and is the same rank as the "model" coordinate space.
 */
export interface RenderLayerTransform {
  /**
   * Specifies for each local user layer dimension the corresponding "render layer" dimension.  A
   * value of `-1` indicates there is no corresponding "render layer" dimension.  The combined
   * values of `localToRenderLayerDimensions` and `globalToRenderLayerDimensions` that are not `-1`
   * must be distinct and partition `[0, ..., rank)`, where `rank` is the rank of the "model"
   * coordinate space.
   */
  localToRenderLayerDimensions: number[];

  /**
   * Specifies for each global dimension the corresponding "render layer" dimension.  A value of
   * `-1` indicates there is no corresponding "render layer" dimension.
   */
  globalToRenderLayerDimensions: number[];

  /**
   * Homogeneous transform from "model" coordinate space to "render layer" coordinate space.
   */
  modelToRenderLayerTransform: Float32Array;

  modelDimensionNames: readonly string[];
  layerDimensionNames: readonly string[];
}

export type RenderLayerTransformOrError = (RenderLayerTransform&{error?: undefined})|{error: string};

export type WatchableRenderLayerTransform = WatchableValueInterface<RenderLayerTransformOrError>;

function scaleTransformSubmatrix(
    transform: Float32Array, rank: number, baseInputSpace: CoordinateSpace,
    inputToBaseDimensions: readonly number[], baseOutputSpace: CoordinateSpace,
    baseToOutputDimensions: readonly number[]) {
  const {scales: baseInputScales} = baseInputSpace;
  const {scales: baseOutputScales, rank: baseOutputRank} = baseOutputSpace;
  const stride = rank + 1;
  for (let baseOutputDim = 0; baseOutputDim < baseOutputRank; ++baseOutputDim) {
    const outputDim = baseToOutputDimensions[baseOutputDim];
    if (outputDim === -1) continue;
    const baseOutputScale = baseOutputScales[baseOutputDim];
    for (let inputDim = 0; inputDim < rank; ++inputDim) {
      const baseInputDim = inputToBaseDimensions[inputDim];
      const baseInputScale = baseInputScales[baseInputDim];
      transform[stride * inputDim + outputDim] *= (baseInputScale / baseOutputScale);
    }
  }
}

export function getRenderLayerTransform(
    globalCoordinateSpace: CoordinateSpace, localCoordinateSpace: CoordinateSpace,
    modelCoordinateSpace: CoordinateSpace,
  transform: CoordinateSpaceTransform): RenderLayerTransformOrError {
  const {dimensionNames: transformInputDimensions} = transform.inputSpace;
  const {dimensionNames: transformOutputDimensions} = transform.outputSpace;
  const requiredInputDims =
      modelCoordinateSpace.dimensionNames.map(x => transformInputDimensions.indexOf(x));
  const requiredOutputDims = getDependentTransformInputDimensions(
      transform.transform, transform.rank, requiredInputDims, true);
  const newRank = requiredInputDims.length;
  const {transform: oldTransform, rank: oldRank} = transform;
  if (newRank !== requiredOutputDims.length) {
    return {
      error: 'Rank mismatch between model dimensions (' +
          modelCoordinateSpace.dimensionNames.join(', ') +
          ') and corresponding layer/global dimensions (' +
          requiredOutputDims.map(i => transformOutputDimensions[i]).join(', ')
    };
  }
  const newTransform =
      transformSubmatrix(oldTransform, oldRank, requiredInputDims, requiredOutputDims);
  const renderLayerDimensions = requiredOutputDims.map(i => transformOutputDimensions[i]);
  const localToRenderLayerDimensions =
      localCoordinateSpace.dimensionNames.map(x => renderLayerDimensions.indexOf(x));
  const globalToRenderLayerDimensions =
      globalCoordinateSpace.dimensionNames.map(x => renderLayerDimensions.indexOf(x));
  scaleTransformSubmatrix(
      newTransform, newRank, modelCoordinateSpace, requiredInputDims, globalCoordinateSpace,
      globalToRenderLayerDimensions);
  scaleTransformSubmatrix(
      newTransform, newRank, modelCoordinateSpace, requiredInputDims, localCoordinateSpace,
      localToRenderLayerDimensions);
  return {
    modelDimensionNames: modelCoordinateSpace.dimensionNames,
    layerDimensionNames: transformOutputDimensions,
    localToRenderLayerDimensions,
    globalToRenderLayerDimensions,
    modelToRenderLayerTransform: newTransform,
  };
}

export function getWatchableRenderLayerTransform(
    globalCoordinateSpace: WatchableValueInterface<CoordinateSpace>,
    localCoordinateSpace: WatchableValueInterface<CoordinateSpace>,
    modelCoordinateSpace: CoordinateSpace,
    transform: WatchableValueInterface<CoordinateSpaceTransform>):
    CachedWatchableValue<RenderLayerTransformOrError> {
  return makeCachedDerivedWatchableValue(
      (globalCoordinateSpace: CoordinateSpace, localCoordinateSpace: CoordinateSpace,
       transform: CoordinateSpaceTransform) =>
          getRenderLayerTransform(
              globalCoordinateSpace, localCoordinateSpace, modelCoordinateSpace, transform),
      [globalCoordinateSpace, localCoordinateSpace, transform], (a, b) => {
        if (a === b) return true;
        if (a.error !== undefined || b.error !== undefined) return false;
        return (
            arraysEqual(a.modelDimensionNames, b.modelDimensionNames) &&
            arraysEqual(a.layerDimensionNames, b.layerDimensionNames) &&
            arraysEqual(a.globalToRenderLayerDimensions, b.globalToRenderLayerDimensions) &&
            arraysEqual(a.localToRenderLayerDimensions, b.localToRenderLayerDimensions) &&
            arraysEqual(a.modelToRenderLayerTransform, b.modelToRenderLayerTransform));
      });
}

export class RenderLayer extends RefCounted {
  ready = false;
  role: RenderLayerRole = RenderLayerRole.DATA;
  messages = new MessageList();
  layerChanged = new NullarySignal();
  redrawNeeded = new NullarySignal();
  readyStateChanged = new NullarySignal();
  setReady(value: boolean) {
    this.ready = value;
    this.readyStateChanged.dispatch();
    this.layerChanged.dispatch();
  }

  handleAction(_action: string) {
    // Do nothing by default.
  }

  getValueAt(_x: Float32Array): any {
    return undefined;
  }

  /**
   * Transform the stored pickedValue and offset associated with the retrieved pick ID into the
   * actual value.
   */
  transformPickedValue(pickedValue: Uint64, _pickedOffset: number): any {
    return pickedValue;
  }

  /**
   * Optionally updates the mouse state based on the retrived pick information.  This might snap the
   * 3-d position to the center of the picked point.
   */
  updateMouseState(
      _mouseState: MouseSelectionState, _pickedValue: Uint64, _pickedOffset: number, _data: any) {}
}


/**
 * Extends RenderLayer with functionality for tracking the number of panels in which the layer is
 * visible.
 */
export class VisibilityTrackedRenderLayer extends RenderLayer {
  visibility = new VisibilityPriorityAggregator();
}

export interface ThreeDimensionalReadyRenderContext {
  viewProjectionMat: mat4;
  renderDimensions: RenderDimensions;
  globalPosition: Float32Array;

  /**
   * Width of GL viewport in pixels.
   */
  viewportWidth: number;

  /**
   * Height of GL viewport in pixels.
   */
  viewportHeight: number;
}

export interface ThreeDimensionalRenderContext extends ThreeDimensionalReadyRenderContext {
  pickIDs: PickIDManager;
}

export function get3dModelToRenderSpaceMatrix(
    out: mat4, renderContext: ThreeDimensionalReadyRenderContext, transform: RenderLayerTransform) {
  out[15] = 1;
  let fullRank = true;
  const {renderDimensions: {dimensionIndices: renderDimensionIndices}} = renderContext;
  const {globalToRenderLayerDimensions, modelToRenderLayerTransform} = transform;
  for (let renderDim = 0; renderDim < 3; ++renderDim) {
    const globalDim = renderDimensionIndices[renderDim];
    if (globalDim === -1) {
      fullRank = false;
      continue;
    }
    const layerDim = globalToRenderLayerDimensions[globalDim];
    if (layerDim === -1) {
      fullRank = false;
      continue;
    }
    for (let modelDim = 0; modelDim < 4; ++modelDim) {
      out[renderDim + 4 * modelDim] = modelToRenderLayerTransform[layerDim + 4 * modelDim];
    }
  }
  if (!fullRank) {
    const {dimensionNames: globalDimensionNames} =
        renderContext.renderDimensions.renderScaleFactors.coordinateSpace;
    const renderDimDesc =
        Array.from(renderDimensionIndices.filter(i => i !== -1), i => globalDimensionNames[i])
            .join(',\u00a0');
    throw new Error(
        `Transform from model dimensions (${transform.modelDimensionNames.join(',\u00a0')}) ` +
        `to render dimensions (${renderDimDesc}) does not have full rank`);
  }
}
