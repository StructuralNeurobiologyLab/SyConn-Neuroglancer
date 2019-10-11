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

import {ChunkLayout} from 'neuroglancer/sliceview/chunk_layout';
import {WatchableValueInterface} from 'neuroglancer/trackable_value';
import {arraysEqual, filterArrayInplace, partitionArray} from 'neuroglancer/util/array';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {Disposable} from 'neuroglancer/util/disposable';
import {getDependentTransformInputDimensions, kAxes, mat3, mat4, vec3} from 'neuroglancer/util/geom';
import * as matrix from 'neuroglancer/util/matrix';
import * as vector from 'neuroglancer/util/vector';
import {SharedObject} from 'neuroglancer/worker_rpc';

export {DATA_TYPE_BYTES, DataType};

const DEBUG_CHUNK_INTERSECTIONS = false;
const DEBUG_VISIBLE_SOURCES = false;

const tempVec3 = vec3.create();

/**
 * Average cross-sectional area contained within a chunk of the specified size and rotation.
 *
 * This is estimated by taking the total volume of the chunk and dividing it by the total length of
 * the chunk along the z axis.
 */
export function estimateSliceAreaPerChunk(chunkLayout: ChunkLayout, viewMatrix: mat4) {
  // Compute the length of the projection of the chunk along the z axis in view space.
  //
  // Each chunk dimension `i` can independently affect the z projection by the dot product of column
  // `i` of `chunkLayout.transform` and row 2 of `viewMatrix`.
  let viewZProjection = 0;
  let chunkVolume = chunkLayout.detTransform;
  const {transform, size} = chunkLayout;
  for (let i = 0; i < 3; ++i) {
    let sum = 0;
    for (let j = 0; j < 3; ++j) {
      sum += viewMatrix[j * 4 + 2] * transform[4 * i + j];
    }
    const s = size[i];
    viewZProjection += Math.abs(sum) * s;
    chunkVolume *= s;
  }
  return chunkVolume / viewZProjection ;
}

/**
 * All valid chunks are in the range [lowerBound, upperBound).
 *
 * @param lowerBound Output parameter for lowerBound.
 * @param upperBound Output parameter for upperBound.
 * @param sources Sources for which to compute the chunk bounds.
 */
function computeSourcesChunkBounds(
    sourcesLowerBound: vec3, sourcesUpperBound: vec3,
    sources: Iterable<TransformedSource<RenderLayer, SliceViewChunkSource>>) {
  for (let i = 0; i < 3; ++i) {
    sourcesLowerBound[i] = Number.POSITIVE_INFINITY;
    sourcesUpperBound[i] = Number.NEGATIVE_INFINITY;
  }

  for (const tsource of sources) {
    const {lowerChunkSpatialBound, upperChunkSpatialBound} = tsource;
    if (DEBUG_VISIBLE_SOURCES) {
      console.log('computeSourcesChunkBounds', tsource);
    }
    for (let i = 0; i < 3; ++i) {
      sourcesLowerBound[i] = Math.min(sourcesLowerBound[i], lowerChunkSpatialBound[i]);
      sourcesUpperBound[i] = Math.max(sourcesUpperBound[i], upperChunkSpatialBound[i]);
    }
  }
}

enum BoundsComparisonResult {
  // Needle is fully outside haystack.
  FULLY_OUTSIDE,
  // Needle is fully inside haystack.
  FULLY_INSIDE,
  // Needle is partially inside haystack.
  PARTIALLY_INSIDE
}

function compareBoundsSingleDimension(
    needleLower: number, needleUpper: number, haystackLower: number, haystackUpper: number) {
  if (needleLower >= haystackUpper || needleUpper <= haystackLower) {
    return BoundsComparisonResult.FULLY_OUTSIDE;
  }
  if (needleLower >= haystackLower && needleUpper <= haystackUpper) {
    return BoundsComparisonResult.FULLY_INSIDE;
  }
  return BoundsComparisonResult.PARTIALLY_INSIDE;
}

function compareBounds(
    needleLowerBound: vec3, needleUpperBound: vec3, haystackLowerBound: vec3,
    haystackUpperBound: vec3) {
  let curResult = BoundsComparisonResult.FULLY_INSIDE;
  for (let i = 0; i < 3; ++i) {
    let newResult = compareBoundsSingleDimension(
        needleLowerBound[i], needleUpperBound[i], haystackLowerBound[i], haystackUpperBound[i]);
    switch (newResult) {
      case BoundsComparisonResult.FULLY_OUTSIDE:
        return newResult;
      case BoundsComparisonResult.PARTIALLY_INSIDE:
        curResult = newResult;
        break;
    }
  }
  return curResult;
}

export interface TransformedSource<RLayer extends RenderLayer,
                                                  Source extends SliceViewChunkSource> {
  renderLayer: RLayer;

  source: Source;

  /**
   * Voxel size corresponding to the spatial layer dimensions.
   */
  effectiveVoxelSize: vec3;

  chunkLayout: ChunkLayout;

  lowerChunkSpatialBound: vec3;
  upperChunkSpatialBound: vec3;

  /**
   * Dimensions of the chunk corresponding to the 3 spatial dimensions of the slice view.
   */
  spatialChunkDimensions: number[];

  /**
   * Dimensions of the chunk not corresponding to the 3 spatial dimensions of the slice view.
   */
  fixedChunkDimensions: number[];

  /**
   * Transform from non-spatial dimensions of layer space to non-spatial dimensions of chunk space.
   *
   * Input space is `[global dimensions, non-global layer dimensions]`.  Output space is the "chunk"
   * coordinate space, in units of voxels.
   */
  fixedLayerToChunkTransform: Float32Array;

  /**
   * When `computeVisibleChunks` invokes the `addChunk` callback, this is set to the position of the
   * chunk.
   */
  curPositionInChunks: Float32Array;

  fixedPositionWithinChunk: Uint32Array;
}

export interface RenderLayer {
  /**
   * Current position of non-global layer dimensions.
   */
  localPosition: WatchableValueInterface<Float32Array>;
  renderScaleTarget: WatchableValueInterface<number>;
}

function updateFixedCurPositionInChunks(
    tsource: TransformedSource<RenderLayer, SliceViewChunkSource>,
    globalPosition: Float32Array): boolean {
  const globalRank = globalPosition.length;
  const {curPositionInChunks, fixedLayerToChunkTransform, fixedPositionWithinChunk} = tsource;
  const localPosition = tsource.renderLayer.localPosition.value;
  const localRank = localPosition.length;
  const {lowerClipBound, upperClipBound, chunkDataSize} = tsource.source.spec;
  const stride = tsource.source.spec.rank;
  for (const chunkDim of tsource.fixedChunkDimensions) {
    let off = chunkDim;
    /**
     * Equal to the position in voxels within the `chunkDim` dimension of the chunk coordinte space.
     */
    let sum = 0;
    for (let globalDim = 0; globalDim < globalRank; ++globalDim) {
      sum += fixedLayerToChunkTransform[off + globalDim * stride] * globalPosition[globalDim];
    }
    off += globalRank * stride;
    for (let localDim = 0; localDim < localRank; ++localDim) {
      sum += fixedLayerToChunkTransform[off + localDim * stride] * localPosition[localDim];
    }
    sum += fixedLayerToChunkTransform[off + localRank * stride];
    if (sum < lowerClipBound[chunkDim] || sum >= upperClipBound[chunkDim]) {
      if (DEBUG_VISIBLE_SOURCES) {
        console.log(
            'excluding source', tsource, `because of chunkDim=${chunkDim}, sum=${sum}`,
            lowerClipBound, upperClipBound, fixedLayerToChunkTransform);
      }
      return false;
    }
    const chunkSize = chunkDataSize[chunkDim];
    const chunk = curPositionInChunks[chunkDim] = Math.floor(sum / chunkSize);
    fixedPositionWithinChunk[chunkDim] = sum - chunk * chunkSize;
  }
  return true;
}

function pickBestAlternativeSource<RLayer extends RenderLayer, Source extends SliceViewChunkSource,
                                                                              Transformed extends
                                       TransformedSource<RLayer, Source>>(
    viewMatrix: mat4, alternatives: Transformed[]) {
  let numAlternatives = alternatives.length;
  let bestAlternativeIndex = 0;
  if (DEBUG_VISIBLE_SOURCES) {
    console.log(alternatives);
  }
  if (numAlternatives > 1) {
    let bestSliceArea = 0;
    for (let alternativeIndex = 0; alternativeIndex < numAlternatives; ++alternativeIndex) {
      let alternative = alternatives[alternativeIndex];
      const {chunkLayout} = alternative;
      let sliceArea = estimateSliceAreaPerChunk(chunkLayout, viewMatrix);
      if (DEBUG_VISIBLE_SOURCES) {
        console.log(`chunksize = ${chunkLayout.size}, sliceArea = ${sliceArea}`);
      }
      if (sliceArea > bestSliceArea) {
        bestSliceArea = sliceArea;
        bestAlternativeIndex = alternativeIndex;
      }
    }
  }
  return alternatives[bestAlternativeIndex];
}

const tempCorners = [vec3.create(), vec3.create(), vec3.create(), vec3.create()];

export interface VisibleLayerSources<RLayer extends RenderLayer, Source extends
                                         SliceViewChunkSource,
                                         Transformed extends TransformedSource<RLayer, Source>> {
  allSources: Transformed[][];
  visibleSources: Transformed[];
  globalTransform: SliceViewGlobalTransform;
}

export interface SliceViewGlobalTransform {
  globalRank: number;
  displayRank: number;
  globalDimensionNames: readonly string[];
  displayDimensionIndices: Int32Array;
  voxelPhysicalScales: Float64Array;
  canonicalVoxelFactors: Float64Array;
  generation: number;
}

export class SliceViewBase<
    Source extends SliceViewChunkSource, RLayer extends RenderLayer, Transformed extends
        TransformedSource<RLayer, Source> = TransformedSource<RLayer, Source>> extends
    SharedObject {
  width = 0;
  height = 0;

  // Transforms (x,y) viewport coordinates in the range:
  //
  // x=[left: -width/2, right: width/2] and
  //
  // y=[top: -height/2, bottom: height/2],
  //
  // to data coordinates.
  invViewMatrix = mat4.create();
  viewMatrix = mat4.create();

  /**
   * Normal vector of cross section in (non-isotropic) global voxel coordinates.
   */
  viewportNormalInGlobalCoordinates = vec3.create();

  /**
   * Normal vector of cross section in isotropic global canonical voxel coordinates.
   */
  viewportNormalInCanonicalCoordinates = vec3.create();

  centerDataPosition = vec3.create();
  globalPosition = vector.kEmptyFloat32Vec;

  /**
   * For each visible ChunkLayout, maps each visible GenericVolumeChunkSource to its priority index.
   * Overall chunk priority ordering is based on a lexicographical ordering of (priorityIndex,
   * -distanceToCenter).
   */
  visibleChunkLayouts = new Map<ChunkLayout, Map<Transformed, number>>();

  visibleLayers = new Map<RLayer, VisibleLayerSources<RLayer, Source, Transformed>>();

  visibleSourcesStale = true;

  /**
   * Size in spatial units (nm) of a single pixel.
   */
  pixelSize: number = 0;

  globalTransform: SliceViewGlobalTransform|undefined = undefined;

  get valid() {
    return this.globalTransform !== undefined;
  }

  setViewportSize(width: number, height: number) {
    if (width !== this.width || height !== this.height) {
      this.width = width;
      this.height = height;
      return true;
    }
    return false;
  }

  private prevGlobalTransform: SliceViewGlobalTransform|undefined = undefined;

  setViewportToDataMatrix(invViewMatrixLinear: mat3, newGlobalPosition: Float32Array) {
    let {globalPosition} = this;
    const globalTransform = this.globalTransform!;
    const linearTransformChanged =
        !matrix.equal<Float32Array>(this.invViewMatrix, 4, invViewMatrixLinear, 3, 3, 3);
    if (!linearTransformChanged && arraysEqual(globalPosition, newGlobalPosition) &&
        globalTransform === this.prevGlobalTransform) {
      return false;
    }

    const {
      invViewMatrix,
      centerDataPosition,
      viewMatrix,
      viewportNormalInGlobalCoordinates,
      viewportNormalInCanonicalCoordinates
    } = this;
    matrix.copy<Float32Array>(invViewMatrix, 4, invViewMatrixLinear, 3, 3, 3);
    const {displayDimensionIndices, globalRank, displayRank, canonicalVoxelFactors} =
        globalTransform;
    if (globalPosition.length !== globalRank) {
      globalPosition = this.globalPosition = new Float32Array(globalRank);
    }
    this.globalPosition.set(newGlobalPosition);
    centerDataPosition.fill(0);
    for (let i = 0; i < displayRank; ++i) {
      centerDataPosition[i] = invViewMatrix[12 + i] = newGlobalPosition[displayDimensionIndices[i]];
    }
    for (let i = displayRank; i < 3; ++i) {
      centerDataPosition[i] = invViewMatrix[12 + i] = 0;
    }
    mat4.invert(viewMatrix, invViewMatrix);
    for (let i = 0; i < 3; ++i) {
      const x = viewportNormalInGlobalCoordinates[i] = viewMatrix[i * 4 + 2];
      viewportNormalInCanonicalCoordinates[i] = x / canonicalVoxelFactors[i];
    }
    vec3.normalize(viewportNormalInGlobalCoordinates, viewportNormalInGlobalCoordinates);
    vec3.normalize(viewportNormalInCanonicalCoordinates, viewportNormalInCanonicalCoordinates);

    let newPixelSize = 0;
    const {voxelPhysicalScales: globalScales} = this.globalTransform!;
    for (let i = 0; i < 3; ++i) {
      const s = globalScales[i];
      if (s === undefined) continue;
      const x = invViewMatrix[i];
      newPixelSize += (s * x) ** 2;
    }
    newPixelSize = Math.sqrt(newPixelSize);
    if (newPixelSize !== this.pixelSize || linearTransformChanged) {
      this.visibleSourcesStale = true;
      this.pixelSize = newPixelSize;
    }
    return true;
  }

  /**
   * Computes the list of sources to use for each visible layer, based on the
   * current pixelSize.
   */
  updateVisibleSources() {
    if (!this.visibleSourcesStale) {
      return;
    }
    this.visibleSourcesStale = false;
    // Increase pixel size by a small margin.
    let pixelSize = this.pixelSize * 1.1;
    // console.log("pixelSize", pixelSize);

    let visibleChunkLayouts = this.visibleChunkLayouts;
    const curGlobalTransform = this.globalTransform;

    const {visibleLayers} = this;
    visibleChunkLayouts.clear();
    for (const [renderLayer, {allSources, visibleSources, globalTransform}] of visibleLayers) {
      visibleSources.length = 0;
      if (globalTransform !== curGlobalTransform || allSources.length === 0) {
        continue;
      }
      let numSources = allSources.length;
      let scaleIndex: number;

      // At the smallest scale, all alternative sources must have the same voxel size, which is
      // considered to be the base voxel size.
      const smallestVoxelSize = allSources[0][0].effectiveVoxelSize;

      const renderScaleTarget = renderLayer.renderScaleTarget.value;

      /**
       * Determines whether we should continue to look for a finer-resolution source *after* one
       * with the specified voxelSize.
       */
      const canImproveOnVoxelSize = (voxelSize: vec3) => {
        const targetSize = pixelSize * renderScaleTarget;
        for (let i = 0; i < 3; ++i) {
          const size = voxelSize[i];
          // If size <= pixelSize, no need for improvement.
          // If size === smallestVoxelSize, also no need for improvement.
          if (size > targetSize && size > 1.01 * smallestVoxelSize[i]) {
            return true;
          }
        }
        return false;
      };

      const improvesOnPrevVoxelSize = (voxelSize: vec3, prevVoxelSize: vec3) => {
        const targetSize = pixelSize * renderScaleTarget;
        for (let i = 0; i < 3; ++i) {
          const size = voxelSize[i];
          const prevSize = prevVoxelSize[i];
          if (Math.abs(targetSize - size) < Math.abs(targetSize - prevSize) &&
              size < 1.01 * prevSize) {
            return true;
          }
        }
        return false;
      };

      /**
       * Registers a source as being visible.  This should be called with consecutively decreasing
       * values of scaleIndex.
       */
      const addVisibleSource = (transformedSource: Transformed, sourceScaleIndex: number) => {
        // Add to end of visibleSources list.  We will reverse the list after all sources are
        // added.
        const {chunkLayout} = transformedSource;
        visibleSources[visibleSources.length++] = transformedSource;
        let existingSources = visibleChunkLayouts.get(chunkLayout);
        if (existingSources === undefined) {
          existingSources = new Map<Transformed, number>();
          visibleChunkLayouts.set(chunkLayout, existingSources);
        }
        existingSources.set(transformedSource, sourceScaleIndex);
      };

      scaleIndex = numSources - 1;
      let prevVoxelSize: vec3|undefined;
      while (true) {
        const transformedSource =
            pickBestAlternativeSource(this.viewMatrix, allSources[scaleIndex]);
        if (prevVoxelSize !== undefined &&
            !improvesOnPrevVoxelSize(transformedSource.effectiveVoxelSize, prevVoxelSize)) {
          break;
        }
        addVisibleSource(transformedSource, scaleIndex);

        if (scaleIndex === 0 || !canImproveOnVoxelSize(transformedSource.effectiveVoxelSize)) {
          break;
        }
        prevVoxelSize = transformedSource.effectiveVoxelSize;
        --scaleIndex;
      }
      // Reverse visibleSources list since we added sources from coarsest to finest resolution, but
      // we want them ordered from finest to coarsest.
      visibleSources.reverse();
      if (DEBUG_VISIBLE_SOURCES) {
        console.log('visible sources chosen', visibleSources);
      }
    }
  }
  computeVisibleChunks<T>(
      initialize: () => void, getLayoutObject: (chunkLayout: ChunkLayout) => T,
      addChunk:
          (chunkLayout: ChunkLayout, layoutObject: T, positionInChunks: vec3,
           sources: Transformed[]) => void) {
    this.updateVisibleSources();
    initialize();

    // Lower and upper bound in global data coordinates.
    const globalCorners = tempCorners;
    let {width, height, invViewMatrix} = this;
    for (let i = 0; i < 3; ++i) {
      globalCorners[0][i] = -kAxes[0][i] * width / 2 - kAxes[1][i] * height / 2;
      globalCorners[1][i] = -kAxes[0][i] * width / 2 + kAxes[1][i] * height / 2;
      globalCorners[2][i] = kAxes[0][i] * width / 2 - kAxes[1][i] * height / 2;
      globalCorners[3][i] = kAxes[0][i] * width / 2 + kAxes[1][i] * height / 2;
    }
    for (let i = 0; i < 4; ++i) {
      vec3.transformMat4(globalCorners[i], globalCorners[i], invViewMatrix);
    }
    // console.log("data bounds", dataLowerBound, dataUpperBound);

    // These variables hold the lower and upper bounds on chunk grid positions that intersect the
    // viewing plane.
    const lowerChunkBound = vec3.create();
    const upperChunkBound = vec3.create();

    const sourcesLowerChunkBound = vec3.create();
    const sourcesUpperChunkBound = vec3.create();

    // Vertex with maximal dot product with the positive viewport plane normal.
    // Implicitly, negativeVertex = 1 - positiveVertex.
    var positiveVertex = vec3.create();

    var planeNormal = vec3.create();

    // Sources whose bounds partially contain the current bounding box.
    let partiallyVisibleSources = new Array<Transformed>();

    // Sources whose bounds fully contain the current bounding box.
    let fullyVisibleSources = new Array<Transformed>();

    const {globalPosition} = this;

    this.visibleChunkLayouts.forEach((visibleSources, chunkLayout) => {
      let layoutObject = getLayoutObject(chunkLayout);

      fullyVisibleSources.length = 0;
      partiallyVisibleSources.length = 0;

      for (const tsource of visibleSources.keys()) {
        if (!updateFixedCurPositionInChunks(tsource, globalPosition)) {
          continue;
        }
        partiallyVisibleSources.push(tsource);
      }

      computeSourcesChunkBounds(
          sourcesLowerChunkBound, sourcesUpperChunkBound, partiallyVisibleSources);
      if (DEBUG_CHUNK_INTERSECTIONS) {
        console.log(
            `Initial sources chunk bounds: ` +
            `${Array.from(sourcesLowerChunkBound)}, ${Array.from(sourcesUpperChunkBound)}`);
      }
      vec3.set(
          lowerChunkBound, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY,
          Number.POSITIVE_INFINITY);
      vec3.set(
          upperChunkBound, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY,
          Number.NEGATIVE_INFINITY);

      chunkLayout.globalToLocalNormal(planeNormal, this.viewportNormalInGlobalCoordinates);
      vec3.multiply(planeNormal, planeNormal, chunkLayout.size);
      vec3.normalize(planeNormal, planeNormal);
      for (let i = 0; i < 3; ++i) {
        positiveVertex[i] = planeNormal[i] > 0 ? 1 : 0;
      }

      // Center position in chunk grid coordinates.
      const planeDistanceToOrigin =
          vec3.dot(chunkLayout.globalToLocalGrid(tempVec3, this.centerDataPosition), planeNormal);

      for (let i = 0; i < 4; ++i) {
        const localCorner = chunkLayout.globalToLocalGrid(tempVec3, globalCorners[i]);
        for (let j = 0; j < 3; ++j) {
          lowerChunkBound[j] = Math.min(lowerChunkBound[j], Math.floor(localCorner[j]));
          upperChunkBound[j] = Math.max(upperChunkBound[j], Math.floor(localCorner[j]) + 1);
        }
      }
      vec3.max(lowerChunkBound, lowerChunkBound, sourcesLowerChunkBound);
      vec3.min(upperChunkBound, upperChunkBound, sourcesUpperChunkBound);
      if (DEBUG_CHUNK_INTERSECTIONS) {
        console.log(
            `lowerChunkBound=${lowerChunkBound.join()}, upperChunkBound=${upperChunkBound.join()}`);
      }

      // Checks whether [lowerBound, upperBound) intersects the viewport plane.
      //
      // positiveVertexDistanceToOrigin = dot(planeNormal, lowerBound +
      // positiveVertex * (upperBound - lowerBound)) - planeDistanceToOrigin;
      // negativeVertexDistanceToOrigin = dot(planeNormal, lowerBound +
      // negativeVertex * (upperBound - lowerBound)) - planeDistanceToOrigin;
      //
      // positive vertex must have positive distance, and negative vertex must
      // have negative distance.
      const intersectsPlane = () => {
        var positiveVertexDistanceToOrigin = 0;
        var negativeVertexDistanceToOrigin = 0;
        // Check positive vertex.
        for (let i = 0; i < 3; ++i) {
          let normalValue = planeNormal[i];
          let lowerValue = lowerChunkBound[i];
          let upperValue = upperChunkBound[i];
          let diff = upperValue - lowerValue;
          let positiveOffset = positiveVertex[i] * diff;
          // console.log(
          //     normalValue, lowerValue, upperValue, diff, positiveOffset,
          //     positiveVertexDistanceToOrigin, negativeVertexDistanceToOrigin);
          positiveVertexDistanceToOrigin += normalValue * (lowerValue + positiveOffset);
          negativeVertexDistanceToOrigin += normalValue * (lowerValue + diff - positiveOffset);
        }
        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(`    planeNormal = ${planeNormal}`);
          console.log(
              `    planeNormalInVoxelCoordinates = ${this.viewportNormalInGlobalCoordinates}`);
          console.log(
              '    {positive,negative}VertexDistanceToOrigin: ', positiveVertexDistanceToOrigin,
              negativeVertexDistanceToOrigin, planeDistanceToOrigin);
          console.log(
              '    intersectsPlane:', negativeVertexDistanceToOrigin, planeDistanceToOrigin,
              positiveVertexDistanceToOrigin);
        }
        if (positiveVertexDistanceToOrigin < planeDistanceToOrigin) {
          return false;
        }

        return negativeVertexDistanceToOrigin <= planeDistanceToOrigin;
      };

      function checkSourceVisibility(tsource: Transformed) {
        const result = compareBounds(
            lowerChunkBound, upperChunkBound, tsource.lowerChunkSpatialBound,
          tsource.upperChunkSpatialBound);
        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log('checkSourceVisibility', tsource, lowerChunkBound, upperChunkBound);
        }
        switch (result) {
          case BoundsComparisonResult.PARTIALLY_INSIDE:
            return true;
          case BoundsComparisonResult.FULLY_INSIDE:
            fullyVisibleSources.push(tsource);
          default:
            return false;
        }
      }


      filterArrayInplace(partiallyVisibleSources, checkSourceVisibility);
      let partiallyVisibleSourcesLength = partiallyVisibleSources.length;

      // Mutates lowerBound and upperBound while running, but leaves them the
      // same once finished.
      function checkBounds(nextSplitDim: number) {
        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(
              `chunk bounds: ${lowerChunkBound} ${upperChunkBound} ` +
              `fullyVisible: ${fullyVisibleSources} partiallyVisible: ` +
              `${partiallyVisibleSources.slice(0, partiallyVisibleSourcesLength)}`);
        }

        if (fullyVisibleSources.length === 0 && partiallyVisibleSourcesLength === 0) {
          if (DEBUG_CHUNK_INTERSECTIONS) {
            console.log('  no visible sources');
          }
          return;
        }

        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(
              `Check bounds: [ ${vec3.str(lowerChunkBound)}, ${vec3.str(upperChunkBound)} ]`);
        }
        var volume = 1;
        for (let i = 0; i < 3; ++i) {
          volume *= Math.max(0, upperChunkBound[i] - lowerChunkBound[i]);
        }

        if (volume === 0) {
          if (DEBUG_CHUNK_INTERSECTIONS) {
            console.log('  volume == 0');
          }
          return;
        }

        if (!intersectsPlane()) {
          if (DEBUG_CHUNK_INTERSECTIONS) {
            console.log('  doesn\'t intersect plane');
          }
          return;
        }

        if (DEBUG_CHUNK_INTERSECTIONS) {
          console.log(
              'Within bounds: [' + vec3.str(lowerChunkBound) + ', ' + vec3.str(upperChunkBound) +
              ']');
        }

        if (volume === 1) {
          for (const tsource of fullyVisibleSources) {
            const {curPositionInChunks, spatialChunkDimensions} = tsource;
            curPositionInChunks[spatialChunkDimensions[0]] = lowerChunkBound[0];
            curPositionInChunks[spatialChunkDimensions[1]] = lowerChunkBound[1];
            curPositionInChunks[spatialChunkDimensions[2]] = lowerChunkBound[2];
          }
          addChunk(chunkLayout, layoutObject, lowerChunkBound, fullyVisibleSources);
          return;
        }

        var dimLower: number, dimUpper: number, diff: number;
        while (true) {
          dimLower = lowerChunkBound[nextSplitDim];
          dimUpper = upperChunkBound[nextSplitDim];
          diff = dimUpper - dimLower;
          if (diff === 1) {
            nextSplitDim = (nextSplitDim + 1) % 3;
          } else {
            break;
          }
        }

        let splitPoint = dimLower + Math.floor(0.5 * diff);
        let newNextSplitDim = (nextSplitDim + 1) % 3;
        let fullyVisibleSourcesLength = fullyVisibleSources.length;

        upperChunkBound[nextSplitDim] = splitPoint;

        let oldPartiallyVisibleSourcesLength = partiallyVisibleSourcesLength;
        function adjustSources() {
          partiallyVisibleSourcesLength = partitionArray(
              partiallyVisibleSources, 0, oldPartiallyVisibleSourcesLength, checkSourceVisibility);
        }

        adjustSources();
        checkBounds(newNextSplitDim);

        // Truncate list of fully visible sources.
        fullyVisibleSources.length = fullyVisibleSourcesLength;

        // Restore partiallyVisibleSources.
        partiallyVisibleSourcesLength = oldPartiallyVisibleSourcesLength;

        upperChunkBound[nextSplitDim] = dimUpper;
        lowerChunkBound[nextSplitDim] = splitPoint;

        adjustSources();
        checkBounds(newNextSplitDim);

        lowerChunkBound[nextSplitDim] = dimLower;

        // Truncate list of fully visible sources.
        fullyVisibleSources.length = fullyVisibleSourcesLength;

        // Restore partiallyVisibleSources.
        partiallyVisibleSourcesLength = oldPartiallyVisibleSourcesLength;
      }
      checkBounds(0);
    });
  }
}

/**
 * By default, choose a chunk size with at most 2^18 = 262144 voxels.
 */
export const DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2 = 18;

/**
 * Specifies common options for getNearIsotropicBlockSize and getTwoDimensionalBlockSize.
 */
export interface BaseChunkLayoutOptions {
  /**
   * Number of chunk dimensions.
   */
  rank: number;

  /**
   * Number of channels.
   */
  numChannels: number;

  /**
   * This, together with upperVoxelBound, specifies the total volume dimensions, which serves as a
   * bound on the maximum chunk size.  If not specified, defaults to a zero vector.
   */
  lowerVoxelBound?: Float32Array;

  /**
   * Upper voxel bound.  If not specified, the total volume dimensions are not used to bound the
   * chunk size.
   */
  upperVoxelBound?: Float32Array;

  /**
   * Base 2 logarithm of the maximum number of voxels per chunk.  Defaults to
   * DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2.
   */
  maxVoxelsPerChunkLog2?: number;

  /**
   * Specifies an optional transform from chunk coordinates to layer coordinates, as a
   * homogeneous `(n + 1) * (n + 1)` matrix, where `n` is the number of dimensions.  Columns
   * correspond to "chunk" dimensions, while rows correspond to layer dimensions.
   */
  transform: Float32Array;

  /**
   * Specifies the dimension indices of the spatial dimensions.
   */
  spatialLayerDimensions: number[];

  minBlockSize?: Uint32Array;
  maxBlockSize?: Uint32Array;
}

export interface GetNearIsotropicBlockSizeOptions extends BaseChunkLayoutOptions {}

/**
 * Determines a near-isotropic (in global spatial coordinates) block size.  All dimensions will be
 * powers of 2, and will not exceed upperVoxelBound - lowerVoxelBound.  The total number of voxels
 * will not exceed maxVoxelsPerChunkLog2.
 */
export function getNearIsotropicBlockSize(options: GetNearIsotropicBlockSizeOptions): Uint32Array {
  let {
    rank,
    upperVoxelBound,
    maxVoxelsPerChunkLog2 = DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2,
    transform,
    spatialLayerDimensions,
    minBlockSize,
    maxBlockSize,
  } = options;

  const {lowerVoxelBound = new Uint32Array(rank)} = options;

  // Adjust voxelSize by effective scaling factor.
  const numLayerSpatialDims = spatialLayerDimensions.length;
  const spatialChunkDimensions =
      getDependentTransformInputDimensions(transform, rank, spatialLayerDimensions);
  // Should equal `numLayerSpatialDims`, but we will allow it to differ here and defer the error.
  const numChunkSpatialDims = spatialChunkDimensions.length;
  const effectiveVoxelSize = new Float32Array(numChunkSpatialDims);
  for (let i = 0; i < numChunkSpatialDims; ++i) {
    const chunkDim = spatialChunkDimensions[i];
    let factor = 0;
    for (let j = 0; j < numLayerSpatialDims; ++j) {
      const layerDim = spatialLayerDimensions[j];
      const c = transform[chunkDim * (rank + 1) + layerDim];
      factor += c * c;
    }
    effectiveVoxelSize[i] = Math.sqrt(factor);
  }

  let chunkDataSize = new Uint32Array(rank);
  if (minBlockSize !== undefined) {
    chunkDataSize.set(minBlockSize);
  } else {
    chunkDataSize.fill(1);
  }
  let maxSpatialSize = new Uint32Array(numChunkSpatialDims);
  for (let i = 0; i < numChunkSpatialDims; ++i) {
    const dim = spatialChunkDimensions[i];
    let bound = 0xffffffff;
    if (upperVoxelBound !== undefined) {
      bound = Math.pow(2, Math.floor(Math.log2(upperVoxelBound[i] - lowerVoxelBound[dim])));
    }
    if (maxBlockSize !== undefined) {
      bound = Math.min(bound, maxBlockSize[dim]);
    }
    maxSpatialSize[i] = bound;
  }

  // Determine the dimension in which chunkDataSize should be increased.  This is the smallest
  // dimension (in nanometers) that is < maxChunkDataSize (in voxels).
  //
  // Returns -1 if there is no such dimension.
  function findNextDimension() {
    let minSize = Infinity;
    let minDimension = -1;
    for (let i = 0; i < numChunkSpatialDims; ++i) {
      const dim = spatialChunkDimensions[i];
      if (chunkDataSize[dim] >= maxSpatialSize[i]) {
        continue;
      }
      let size = chunkDataSize[dim] * effectiveVoxelSize[i];
      if (size < minSize) {
        minSize = size;
        minDimension = i;
      }
    }
    return minDimension;
  }

  maxVoxelsPerChunkLog2 -= Math.log2(options.numChannels * vector.prod(chunkDataSize));
  for (let i = 0; i < maxVoxelsPerChunkLog2; ++i) {
    let nextDim = findNextDimension();
    if (nextDim === -1) {
      break;
    }
    chunkDataSize[nextDim] *= 2;
  }
  return chunkDataSize;
}

/**
 * Returns an array of [xy, yz, xz] 2-dimensional block sizes.
 */
export function getTwoDimensionalBlockSizes(options: BaseChunkLayoutOptions) {
  const chunkDataSizes: Uint32Array[] = [];
  const {spatialLayerDimensions} = options;
  for (let i = 0; i < 3; ++i) {
    chunkDataSizes[i] = getNearIsotropicBlockSize({
      ...options,
      spatialLayerDimensions: [spatialLayerDimensions[i], spatialLayerDimensions[(i + 1) % 3]],
    });
  }
  return chunkDataSizes;
}

export enum ChunkLayoutPreference {
  /**
   * Indicates that isotropic chunks are desired.
   */
  ISOTROPIC = 0,

  /**
   * Indicates that 2-D chunks are desired.
   */
  FLAT = 1,
}

export interface SliceViewSourceOptions {
  /**
   * Additional transform from the "model" coordinate space of the slice view source to the "layer"
   * coordinate space that will be applied.  This must not be incorporated into the source directly,
   * but serves as a hint that may influence the chunk size.
   */
  transform: Float32Array;

  /**
   * Dimension indices in the "layer" coordinate space of the spatial dimensions.  Length must be 3.
   */
  spatialLayerDimensions: number[];
}

export function getCombinedTransform(
    rank: number, bToC: Float32Array, aToB: Float32Array|undefined) {
  if (aToB === undefined) {
    return bToC;
  } else {
    return matrix.multiply(
        new Float32Array((rank + 1) * (rank + 1)), rank + 1, bToC, rank + 1, aToB, rank + 1,
        rank + 1, rank + 1, rank + 1);
  }
}

/**
 * Specifies parameters for getChunkDataSizes.
 */
export interface ChunkLayoutOptions {
  /**
   * Chunk sizes in voxels.
   */
  chunkDataSizes?: Uint32Array[];

  /**
   * Preferred chunk layout, which determines chunk sizes to use if chunkDataSizes is not
   * specified.
   */
  chunkLayoutPreference?: ChunkLayoutPreference;
}

export function getChunkDataSizes(options: ChunkLayoutOptions&BaseChunkLayoutOptions) {
  if (options.chunkDataSizes !== undefined) {
    return options.chunkDataSizes;
  }
  const {chunkLayoutPreference = ChunkLayoutPreference.ISOTROPIC} = options;
  switch (chunkLayoutPreference) {
    case ChunkLayoutPreference.ISOTROPIC:
      return [getNearIsotropicBlockSize(options)];
    case ChunkLayoutPreference.FLAT:
      let chunkDataSizes = getTwoDimensionalBlockSizes(options);
      chunkDataSizes.push(getNearIsotropicBlockSize(options));
      return chunkDataSizes;
  }
  throw new Error(`Invalid chunk layout preference: ${chunkLayoutPreference}.`);
}

/**
 * Generic specification for SliceView chunks specifying a layout and voxel size.
 */
export abstract class SliceViewChunkSpecification {
  transform: Float32Array;

  inverseTransform: Float32Array;

  /**
   * Determinant of `transform`, used to compute scale factor.
   */
  transformDeterminant: number;

  /**
   * Size of chunk in voxels.
   */
  chunkDataSize: Uint32Array;

  /**
   * All valid chunks are in the range [lowerChunkBound, upperChunkBound).
   *
   * These are specified in units of chunks (not voxels).
   */
  lowerChunkBound: Float32Array;
  upperChunkBound: Float32Array;

  lowerVoxelBound: Float32Array;
  upperVoxelBound: Float32Array;

  /**
   * Lower clipping bound (in chunk coordinate space), in voxels.
   */
  lowerClipBound: Float32Array;

  /**
   * Upper clipping bound (in chunk coordinate space), in voxels.
   */
  upperClipBound: Float32Array;

  constructor(options: SliceViewChunkSpecificationOptions) {
    const {
      chunkDataSize,
      upperVoxelBound,
      transform,
    } = options;
    const rank = chunkDataSize.length;
    const {
      lowerVoxelBound = new Float32Array(rank),
    } = options;
    const {
      lowerClipBound = lowerVoxelBound,
      upperClipBound = upperVoxelBound,
    } = options;
    const lowerChunkBound = new Float32Array(rank);
    const upperChunkBound = new Float32Array(rank);
    for (let i = 0; i < rank; ++i) {
      lowerChunkBound[i] = Math.floor(lowerVoxelBound[i] / chunkDataSize[i]);
      upperChunkBound[i] = Math.floor((upperVoxelBound[i] - 1) / chunkDataSize[i] + 1);
    }
    this.transform = transform;
    this.chunkDataSize = chunkDataSize;
    this.lowerChunkBound = lowerChunkBound;
    this.upperChunkBound = upperChunkBound;
    this.lowerClipBound = lowerClipBound;
    this.upperClipBound = upperClipBound;
    this.lowerVoxelBound = lowerVoxelBound;
    this.upperVoxelBound = upperVoxelBound;
    const inverseTransform = this.inverseTransform = new Float32Array((rank + 1) * (rank + 1));
    this.transformDeterminant =
        matrix.inverse(inverseTransform, rank + 1, transform, rank + 1, rank + 1);
  }

  get rank() {
    return this.chunkDataSize.length;
  }

  toObject(): SliceViewChunkSpecificationOptions {
    return {
      transform: this.transform,
      chunkDataSize: this.chunkDataSize,
      lowerVoxelBound: this.lowerVoxelBound,
      upperVoxelBound: this.upperVoxelBound,
      lowerClipBound: this.lowerClipBound,
      upperClipBound: this.upperClipBound,
    };
  }
}

/**
 * Common parameters for SliceView Chunks.
 */
export interface SliceViewChunkSpecificationBaseOptions {
  /**
   * Homoegeneous transform from n-d chunk grid coordinates (where chunk grid starts at origin) to
   * "model" n-d coordinates.  `(n + 1) * (n + 1)` column-major matrix.
   */
  transform: Float32Array;

  /**
   * Lower clipping bound in voxels within the "chunk" coordinate space.  If not specified, defaults
   * to lowerVoxelBound.  Non-integer values are supported.
   *
   * Both lowerClipBound and upperClipBound are applied during rendering but do not affect which
   * chunks/voxels are actually retrieved.  That is determined by lowerVoxelBound and
   * upperVoxelBound.
   */
  lowerClipBound?: Float32Array;

  /**
   * Upper clipping bound in voxels within the "chunk" coordinate space.  If not specified, defaults
   * to upperVoxelBound.
   */
  upperClipBound?: Float32Array;

  /**
   * If not specified, defaults to an all-zero vector.  This determines lowerChunkBound.  If this is
   * not a multiple of chunkDataSize, then voxels at lower positions may still be requested.
   */
  lowerVoxelBound?: Float32Array;

  /**
   * Exclusive upper bound in "chunk" coordinate space, in voxels.  This determines upperChunkBound.
   */
  upperVoxelBound: Float32Array;
}

export interface SliceViewChunkSpecificationOptions extends SliceViewChunkSpecificationBaseOptions {
  chunkDataSize: Uint32Array;
}


export interface SliceViewChunkSource extends Disposable {
  spec: SliceViewChunkSpecification;
}

export const SLICEVIEW_RPC_ID = 'SliceView';
export const SLICEVIEW_RENDERLAYER_RPC_ID = 'sliceview/RenderLayer';
export const SLICEVIEW_ADD_VISIBLE_LAYER_RPC_ID = 'SliceView.addVisibleLayer';
export const SLICEVIEW_REMOVE_VISIBLE_LAYER_RPC_ID = 'SliceView.removeVisibleLayer';
export const SLICEVIEW_UPDATE_VIEW_RPC_ID = 'SliceView.updateView';
