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

import {ChunkLayoutOptions, getChunkDataSizes, getCombinedTransform, getNearIsotropicBlockSize, SliceViewChunkSource, SliceViewChunkSpecification, SliceViewChunkSpecificationBaseOptions, SliceViewChunkSpecificationOptions, SliceViewSourceOptions} from 'neuroglancer/sliceview/base';
import {DATA_TYPE_BYTES, DataType} from 'neuroglancer/util/data_type';
import {vec3} from 'neuroglancer/util/geom';
import * as vector from 'neuroglancer/util/vector';
export {DATA_TYPE_BYTES, DataType};

export interface RenderLayer {
  sources: VolumeChunkSource[][]|null;
}

/**
 * Specifies the interpretation of volumetric data.
 */
export enum VolumeType {
  UNKNOWN,
  IMAGE,
  SEGMENTATION,
}

/**
 * By default, choose a chunk size with at most 2^18 = 262144 voxels.
 */
export const DEFAULT_MAX_VOXELS_PER_CHUNK_LOG2 = 18;

export interface VolumeSourceOptions extends SliceViewSourceOptions {}

/**
 * Common parameters for the VolumeChunkSpecification constructor and
 * VolumeChunkSpecification.getDefaults.
 */
/**
 * Specifies constructor parameters for VolumeChunkSpecification.
 */
export interface VolumeChunkSpecificationBaseOptions extends
    SliceViewChunkSpecificationBaseOptions {
  /**
   * Specifies offset for use by backend.ts:GenericVolumeChunkSource.computeChunkBounds in
   * calculating chunk voxel coordinates.  The calculated chunk coordinates will be equal to the
   * voxel position (in chunkLayout coordinates) plus this value.
   *
   * Defaults to kZeroVec if not specified.
   */
  baseVoxelOffset?: Float32Array;
  numChannels: number;
  dataType: DataType;

  /**
   * If set, indicates that the chunk is in compressed segmentation format with the specified block
   * size.
   */
  compressedSegmentationBlockSize?: vec3;
}

export interface VolumeChunkSpecificationOptions extends VolumeChunkSpecificationBaseOptions,
                                                         SliceViewChunkSpecificationOptions {}


export interface VolumeChunkSpecificationVolumeSourceOptions {
  volumeSourceOptions: VolumeSourceOptions;
}

/**
 * Specifies additional parameters for VolumeChunkSpecification.withDefaultCompression.
 */
export interface VolumeChunkSpecificationDefaultCompressionOptions {
  /**
   * Volume type.
   */
  volumeType: VolumeType;
  maxCompressedSegmentationBlockSize?: vec3;
  minBlockSize?: Uint32Array;
}

/**
 * Specifies parameters for VolumeChunkSpecification.getDefaults.
 */
export interface VolumeChunkSpecificationGetDefaultsOptions extends
    VolumeChunkSpecificationBaseOptions, VolumeChunkSpecificationDefaultCompressionOptions,
    ChunkLayoutOptions, VolumeChunkSpecificationVolumeSourceOptions {}

/**
 * Specifies a chunk layout and voxel size.
 */
export class VolumeChunkSpecification extends SliceViewChunkSpecification {

  baseVoxelOffset: Float32Array;
  numChannels: number;
  dataType: DataType;

  chunkBytes: number;

  compressedSegmentationBlockSize: vec3|undefined;

  constructor(options: VolumeChunkSpecificationOptions) {
    super(options);
    const {rank} = this;
    const {baseVoxelOffset = new Float32Array(rank)} = options;
    this.baseVoxelOffset = baseVoxelOffset;
    const dataType = this.dataType = options.dataType;
    const numChannels = this.numChannels = options.numChannels;
    this.chunkBytes = vector.prod(this.chunkDataSize) * DATA_TYPE_BYTES[dataType] * numChannels;
    this.compressedSegmentationBlockSize = options.compressedSegmentationBlockSize;
  }

  static make(options: VolumeChunkSpecificationOptions) {
    return new VolumeChunkSpecification(options);
  }

  static fromObject(msg: any) {
    return new VolumeChunkSpecification(msg);
  }

  toObject(): VolumeChunkSpecificationOptions&SliceViewChunkSpecificationOptions {
    return {
      ...super.toObject(),
      numChannels: this.numChannels,
      dataType: this.dataType,
      baseVoxelOffset: this.baseVoxelOffset,
      compressedSegmentationBlockSize: this.compressedSegmentationBlockSize,
    };
  }

  /**
   * Returns a VolumeChunkSpecification with default compression specified if suitable for the
   * volumeType.
   */
  static withDefaultCompression(options: VolumeChunkSpecificationDefaultCompressionOptions&
                                VolumeChunkSpecificationOptions&
                                VolumeChunkSpecificationVolumeSourceOptions) {
    let {
      compressedSegmentationBlockSize,
      dataType,
      transform,
      lowerVoxelBound,
      upperVoxelBound,
    } = options;
    const rank = upperVoxelBound.length;
    const combinedTransform =
        getCombinedTransform(rank, options.volumeSourceOptions.transform, transform);
    if (compressedSegmentationBlockSize === undefined && rank === 3 &&
        options.volumeType === VolumeType.SEGMENTATION &&
        (dataType === DataType.UINT32 || dataType === DataType.UINT64)) {
      const {maxCompressedSegmentationBlockSize, chunkDataSize} = options;
      compressedSegmentationBlockSize = Float32Array.from(getNearIsotropicBlockSize({
        rank,
        numChannels: options.numChannels,
        transform: combinedTransform,
        lowerVoxelBound,
        upperVoxelBound,
        maxVoxelsPerChunkLog2: 9,
        spatialLayerDimensions: [0, 1, 2],
        maxBlockSize: maxCompressedSegmentationBlockSize === undefined ?
            chunkDataSize :
            vector.min(new Uint32Array(rank), chunkDataSize, maxCompressedSegmentationBlockSize),
      })) as vec3;
    }
    return new VolumeChunkSpecification({...options, compressedSegmentationBlockSize});
  }

  static getDefaults(options: VolumeChunkSpecificationGetDefaultsOptions) {
    const rank = options.upperVoxelBound.length;
    const {chunkDataSizes = getChunkDataSizes({
             rank,
             ...options,
             transform: getCombinedTransform(
                 rank, options.volumeSourceOptions.transform, options.transform),
             spatialLayerDimensions: options.volumeSourceOptions.spatialLayerDimensions,
           })} = options;
    return chunkDataSizes.map(
        chunkDataSize => VolumeChunkSpecification.withDefaultCompression(
            {...options, chunkDataSize: chunkDataSize}));
  }
}

export interface VolumeChunkSource extends SliceViewChunkSource {
  spec: VolumeChunkSpecification;
}

export const VOLUME_RPC_ID = 'volume';
