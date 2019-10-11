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

/**
 * @file
 * Support for Python integration.
 */

import {ChunkManager, ChunkSource, ChunkSourceConstructor, WithParameters} from 'neuroglancer/chunk_manager/frontend';
import {DataSourceProvider} from 'neuroglancer/datasource';
import {MeshSourceParameters, PythonSourceParameters, SkeletonSourceParameters, VolumeChunkEncoding, VolumeChunkSourceParameters} from 'neuroglancer/datasource/python/base';
import {MeshSource} from 'neuroglancer/mesh/frontend';
import {getCoordinateSpaceFromJson} from 'neuroglancer/navigation_state';
import {VertexAttributeInfo} from 'neuroglancer/skeleton/base';
import {SkeletonSource} from 'neuroglancer/skeleton/frontend';
import {DataType, DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2, getNearIsotropicBlockSize} from 'neuroglancer/sliceview/base';
import {VolumeChunkSpecification, VolumeSourceOptions, VolumeType} from 'neuroglancer/sliceview/volume/base';
import {MultiscaleVolumeChunkSource as GenericMultiscaleVolumeChunkSource, VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {Borrowed, Owned} from 'neuroglancer/util/disposable';
import {BoundingBox, CoordinateSpace} from 'neuroglancer/util/geom';
import {fetchOk} from 'neuroglancer/util/http_request';
import {parseArray, parseFixedLengthArray, verifyEnumString, verifyFiniteFloat, verifyFinitePositiveFloat, verifyObject, verifyObjectAsMap, verifyObjectProperty, verifyPositiveInt, verifyString} from 'neuroglancer/util/json';
import * as matrix from 'neuroglancer/util/matrix';
import {getObjectId} from 'neuroglancer/util/object_id';
import * as vector from 'neuroglancer/util/vector';

interface PythonChunkSource extends ChunkSource {
  dataSource: PythonDataSource;
  generation: number;
}

function WithPythonDataSource<BaseOptions extends {parameters: PythonSourceParameters}, TBase extends ChunkSourceConstructor<BaseOptions>>(
    Base: TBase) {
  type Options = BaseOptions&{
    dataSource: Borrowed<PythonDataSource>;
    generation: number;
  };
  class C extends Base {
    dataSource: Owned<PythonDataSource>;
    generation: number;
    parameters: PythonSourceParameters;
    constructor(...args: any[]) {
      super(...args);
      const options: Options = args[1];
      const dataSource = this.dataSource = this.registerDisposer(options.dataSource.addRef());
      this.generation = options.generation;
      const key = options.parameters.key;
      dataSource.registerSource(key, this);
    }
    static encodeOptions(options: Options) {
      const encoding = super.encodeOptions(options);
      // `generation` is not encoded in cache key, since it is not fixed.
      encoding['dataSource'] = getObjectId(options.dataSource);
      return encoding;
    }
  }
  return C;
}

class PythonVolumeChunkSource extends
(WithPythonDataSource(WithParameters(VolumeChunkSource, VolumeChunkSourceParameters))) {
}
class PythonMeshSource extends
(WithPythonDataSource(WithParameters(MeshSource, MeshSourceParameters))) {}

interface ScaleInfo {
  key: string;
  offset: Float32Array;
  sizeInVoxels: Float32Array;
  chunkDataSize?: Uint32Array;
  voxelSize: Float32Array;
}

function parseScaleInfo(obj: any, rank: number): ScaleInfo {
  verifyObject(obj);
  return {
    key: verifyObjectProperty(obj, 'key', verifyString),
    offset: verifyObjectProperty(
        obj, 'offset', x => parseFixedLengthArray(new Float32Array(rank), x, verifyFiniteFloat)),
    sizeInVoxels: verifyObjectProperty(
        obj, 'sizeInVoxels',
        x => parseFixedLengthArray(new Float32Array(rank), x, verifyPositiveInt)),
    voxelSize: verifyObjectProperty(
        obj, 'voxelSize',
        x => parseFixedLengthArray(new Float32Array(rank), x, verifyFinitePositiveFloat)),
    chunkDataSize: verifyObjectProperty(
        obj, 'chunkDataSize',
        x => x === undefined ? undefined :
                               parseFixedLengthArray(new Uint32Array(rank), x, verifyPositiveInt)),
  };
}

export class MultiscaleVolumeChunkSource implements GenericMultiscaleVolumeChunkSource {
  dataType: DataType;
  numChannels: number;
  volumeType: VolumeType;
  encoding: VolumeChunkEncoding;
  scales: ScaleInfo[][];
  generation: number;
  modelSpace: CoordinateSpace;
  chunkToModelTransform: Float32Array;
  boundingBox: BoundingBox;
  skeletonVertexAttributes: Map<string, VertexAttributeInfo>|undefined;

  // TODO(jbms): Properly handle reference counting of `dataSource`.
  constructor(public dataSource: Borrowed<PythonDataSource>, public chunkManager: ChunkManager, public key: string, public response: any) {
    verifyObject(response);
    this.dataType = verifyObjectProperty(response, 'dataType', x => verifyEnumString(x, DataType));
    this.volumeType =
        verifyObjectProperty(response, 'volumeType', x => verifyEnumString(x, VolumeType));
    this.numChannels = verifyObjectProperty(response, 'numChannels', verifyPositiveInt);
    this.encoding =
        verifyObjectProperty(response, 'encoding', x => verifyEnumString(x, VolumeChunkEncoding));
    this.modelSpace = getCoordinateSpaceFromJson(response, /*allowMissing=*/ false);
    const rank = this.modelSpace.dimensions.length;
    this.chunkToModelTransform =
      matrix.identity(new Float32Array((rank + 1) * (rank + 1)), rank + 1, rank + 1);
    this.generation = verifyObjectProperty(response, 'generation', x => x);
    this.skeletonVertexAttributes = verifyObjectProperty(
        response, 'skeletonVertexAttributes',
        x => x === undefined ? undefined : verifyObjectAsMap(x, parseVertexAttributeInfo));
    let maxVoxelsPerChunkLog2 = verifyObjectProperty(
        response, 'maxVoxelsPerChunkLog2',
        x => x === undefined ? DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2 : verifyPositiveInt(x));

    /**
     * Scales used for arbitrary orientation (should be near isotropic).
     *
     * Exactly one of threeDimensionalScales and twoDimensionalScales should be specified.
     */
    let threeDimensionalScales = verifyObjectProperty(
        response, 'threeDimensionalScales',
        x => x === undefined ? undefined : parseArray(x, y => parseScaleInfo(y, rank)));

    // /**
    //  * Separate scales used for XY, XZ, YZ slice views, respectively.  The chunks should be flat or
    //  * nearly flat in Z, Y, X respectively.  The inner arrays must have length 3.
    //  */
    // let twoDimensionalScales = verifyObjectProperty(
    //     response, 'twoDimensionalScales',
    //     x => x === undefined ? undefined :
    //                            parseArray(
    //                                x,
    //                                y => parseFixedLengthArray(
    //                                    new Array<ScaleInfo>(3), y, z => parseScaleInfo(z, rank))));
    // if ((twoDimensionalScales === undefined) === (threeDimensionalScales === undefined)) {
    //   throw new Error(
    //       `Exactly one of "threeDimensionalScales" and "twoDimensionalScales" must be specified.`);
    // }
    // if (twoDimensionalScales !== undefined) {
    //   if (twoDimensionalScales.length === 0) {
    //     throw new Error(`At least one scale must be specified.`);
    //   }
    //   this.scales = twoDimensionalScales.map(levelScales => levelScales.map((scale, index) => {
    //     const {voxelSize, sizeInVoxels} = scale;
    //     let {chunkDataSize = getNearIsotropicBlockSize({
    //            voxelSize,
    //            upperVoxelBound: sizeInVoxels,
    //            spatialLayerDimensions: [0, 1],
    //            maxVoxelsPerChunkLog2,
    //            numChannels: this.numChannels
    //          })} = scale;
    //     return {
    //       key: scale.key,
    //       offset: scale.offset,
    //       sizeInVoxels,
    //       voxelSize,
    //       chunkDataSize,
    //     };
    //   }));
    //   if (!vector.equal(this.scales[0][0].voxelSize, this.scales[0][1].voxelSize) ||
    //       !vector.equal(this.scales[0][0].voxelSize, this.scales[0][2].voxelSize)) {
    //     throw new Error(`Lowest scale must have uniform voxel size.`);
    //   }
    // }
    if (threeDimensionalScales !== undefined) {
      if (threeDimensionalScales.length === 0) {
        throw new Error(`At least one scale must be specified.`);
      }
      this.scales = threeDimensionalScales.map(scale => [scale]);
    }
    const baseScale = this.scales[0][0];
    const lowerBound = baseScale.offset;
    const upperBound = new Float32Array(rank);
    vector.multiply(upperBound, baseScale.voxelSize, baseScale.sizeInVoxels);
    vector.add(upperBound, upperBound, lowerBound);
    this.boundingBox = new BoundingBox(lowerBound, upperBound);
  }

  getSources(volumeSourceOptions: VolumeSourceOptions) {
    let {numChannels, dataType, volumeType, encoding} = this;
    // Clip based on the bounds of the first scale.
    const baseScale = this.scales[0][0];
    const rank = this.modelSpace.dimensions.length;
    let upperClipBound =
        vector.multiply(new Float32Array(rank), baseScale.voxelSize, baseScale.sizeInVoxels);
    return this.scales.map(levelScales => levelScales.map(scaleInfo => {
      const transform =
          matrix.identity(new Float32Array((rank + 1) * (rank + 1)), rank + 1, rank + 1);
      transform.set(scaleInfo.offset, (rank + 1) * rank);
      const {chunkDataSize = getNearIsotropicBlockSize({
               upperVoxelBound: scaleInfo.sizeInVoxels,
               numChannels,
               voxelSize: scaleInfo.voxelSize,
               transform: volumeSourceOptions.transform,
               spatialLayerDimensions: volumeSourceOptions.spatialLayerDimensions,
             })} = scaleInfo;
      const spec = VolumeChunkSpecification.withDefaultCompression({
        voxelSize: scaleInfo.voxelSize,
        dataType,
        volumeType,
        numChannels,
        transform,
        upperVoxelBound: scaleInfo.sizeInVoxels,
        upperClipBound: upperClipBound,
        chunkDataSize,
        volumeSourceOptions,
      });
      return this.chunkManager.getChunkSource(PythonVolumeChunkSource, {
        spec,
        dataSource: this.dataSource,
        generation: this.generation,
        parameters: {key: this.key, scaleKey: scaleInfo.key, encoding: encoding}
      });
    }));
  }

  getMeshSource() {
    const {skeletonVertexAttributes} = this;
    if (skeletonVertexAttributes !== undefined) {
      return this.chunkManager.getChunkSource(PythonSkeletonSource, {
        dataSource: this.dataSource,
        generation: this.generation,
        parameters: {
          key: this.key,
          vertexAttributes: skeletonVertexAttributes,
        }
      });
    }
    return this.chunkManager.getChunkSource(PythonMeshSource, {
      dataSource: this.dataSource,
      generation: this.generation,
      parameters: {
        key: this.key,
      }
    });
  }
}

export class PythonSkeletonSource extends
(WithPythonDataSource(WithParameters(SkeletonSource, SkeletonSourceParameters))) {
  get skeletonVertexCoordinatesInVoxels() {
    return false;
  }
  get vertexAttributes() {
    return this.parameters.vertexAttributes;
  }
}

function parseVertexAttributeInfo(x: any): VertexAttributeInfo {
  verifyObject(x);
  return {
    dataType: verifyObjectProperty(x, 'dataType', y => verifyEnumString(y, DataType)),
    numComponents: verifyObjectProperty(x, 'numComponents', verifyPositiveInt),
  };
}

function parseSkeletonVertexAttributes(spec: string): Map<string, VertexAttributeInfo> {
  return verifyObjectAsMap(JSON.parse(spec), parseVertexAttributeInfo);
}

export class PythonDataSource extends DataSourceProvider {
  private sources = new Map<string, Set<PythonChunkSource>>();
  sourceGenerations = new Map<string, number>();

  registerSource(key: string, source: PythonChunkSource) {
    let existingSet = this.sources.get(key);
    if (existingSet === undefined) {
      existingSet = new Set();
      this.sources.set(key, existingSet);
    }
    const generation = this.sourceGenerations.get(key);
    if (generation !== undefined) {
      source.generation = generation;
    }
    existingSet.add(source);
    source.registerDisposer(() => {
      existingSet!.delete(source);
      if (existingSet!.size === 0) {
        this.sources.delete(key);
      }
    });
  }

  setSourceGeneration(key: string, generation: number) {
    const {sourceGenerations} = this;
    if (sourceGenerations.get(key) === generation) {
      return;
    }
    sourceGenerations.set(key, generation);
    const sources = this.sources.get(key);
    if (sources !== undefined) {
      for (const source of sources) {
        if (source.generation !== generation) {
          source.generation = generation;
          source.invalidateCache();
        }
      }
    }
  }

  deleteSourceGeneration(key: string) {
    this.sourceGenerations.delete(key);
  }

  get description() {
    return 'Python-served volume';
  }
  getVolume(chunkManager: ChunkManager, key: string) {
    return chunkManager.memoize.getUncounted(
        {'type': 'python:MultiscaleVolumeChunkSource', key},
        () => fetchOk(`/neuroglancer/info/${key}`)
                  .then(response => response.json())
                  .then(
                      response =>
                          new MultiscaleVolumeChunkSource(this, chunkManager, key, response)));
  }
  getSkeletonSource(chunkManager: ChunkManager, key: string) {
    const skeletonKeyPattern = /^([^\/?]+)\?(.*)$/;

    let match = key.match(skeletonKeyPattern);
    if (match === null) {
      throw new Error(`Invalid python volume path: ${JSON.stringify(key)}`);
    }
    return chunkManager.getChunkSource(PythonSkeletonSource, {
      dataSource: this,
      generation: -1,
      parameters: {
        key: match[1],
        vertexAttributes: parseSkeletonVertexAttributes(match[2]),
      }
    });
  }
}
