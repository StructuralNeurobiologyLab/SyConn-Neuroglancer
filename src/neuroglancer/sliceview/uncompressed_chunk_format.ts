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

import {SingleTextureChunkFormat, SingleTextureVolumeChunk} from 'neuroglancer/sliceview/single_texture_chunk_format';
import {DataType, VolumeChunkSpecification} from 'neuroglancer/sliceview/volume/base';
import {VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {ChunkFormatHandler, registerChunkFormatHandler} from 'neuroglancer/sliceview/volume/frontend';
import {TypedArray, TypedArrayConstructor} from 'neuroglancer/util/array';
import {RefCounted} from 'neuroglancer/util/disposable';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram, ShaderSamplerPrefix, ShaderSamplerType} from 'neuroglancer/webgl/shader';
import {getShaderType} from 'neuroglancer/webgl/shader_lib';
import {computeTextureFormat, setThreeDimensionalTextureData, TextureFormat, ThreeDimensionalTextureAccessHelper} from 'neuroglancer/webgl/texture_access';

class TextureLayout extends RefCounted {
  strides: Uint32Array;
  textureShape = new Uint32Array(3);
  constructor(
      gl: GL, public chunkDataSize: Uint32Array, public numChannels: number,
      public contiguousChannels: boolean) {
    super();
    const rank = chunkDataSize.length;
    let numRemainingDims = 0;
    if (numChannels !== 1) ++numRemainingDims;
    for (const size of chunkDataSize) {
      if (size !== 1) ++numRemainingDims;
    }
    const strides = this.strides = new Uint32Array((rank + ((numChannels > 1) ? 1 : 0)) * 3);
    const {max3dTextureSize} = gl;
    let textureDim = 0;
    let textureDimSize = 1;
    const {textureShape} = this;
    textureShape.fill(1);
    const addDim = (chunkDim: number, size: number) => {
      if (size === 1) return;
      const newSize = size * textureDimSize;
      let stride: number;
      if (newSize > max3dTextureSize ||
          (textureDimSize !== 1 && textureDim + numRemainingDims < 3)) {
        ++textureDim;
        textureDimSize = size;
        stride = 1;
      } else {
        stride = textureDimSize;
        textureDimSize = newSize;
      }
      strides[3 * chunkDim + textureDim] = stride;
      textureShape[textureDim] = textureDimSize;
    };
    if (contiguousChannels) {
      addDim(rank, numChannels);
    }
    for (let i = 0; i < rank; ++i) {
      addDim(i, chunkDataSize[i]);
    }
    if (!contiguousChannels) {
      addDim(rank, numChannels);
    }
  }

  static get(
      gl: GL, chunkSizeInVoxels: Uint32Array, numChannels: number, contiguousChannels: boolean) {
    return gl.memoize.get(
        `sliceview.UncompressedTextureLayout:${chunkSizeInVoxels.join()}:${numChannels}:${
            contiguousChannels}`,
        () => new TextureLayout(gl, chunkSizeInVoxels, numChannels, contiguousChannels));
  }
}

const tempStridesUniformWithoutChannel = new Uint32Array(3 * 4);
const tempStridesUniformWithChannel = new Uint32Array(3 * 5);

export class ChunkFormat extends SingleTextureChunkFormat<TextureLayout> implements TextureFormat {
  texelsPerElement: number;
  textureInternalFormat: number;
  textureFormat: number;
  texelType: number;
  arrayElementsPerTexel: number;
  arrayConstructor: TypedArrayConstructor;
  samplerPrefix: ShaderSamplerPrefix;
  get shaderSamplerType() {
    return `${this.samplerPrefix}sampler3D` as ShaderSamplerType;
  }
  private textureAccessHelper: ThreeDimensionalTextureAccessHelper;

  static get(gl: GL, dataType: DataType, numChannels: number, channelsContiguous: boolean) {
    const key =
        `sliceview.UncompressedChunkFormat:${dataType}:${numChannels}:${channelsContiguous}`;
    return gl.memoize.get(
        key, () => new ChunkFormat(gl, dataType, numChannels, channelsContiguous, key));
  }

  constructor(
      _gl: GL, public dataType: DataType, public numChannels: number,
      public channelsContiguous: boolean, key: string) {
    super(key);
    computeTextureFormat(this, dataType);
    this.textureAccessHelper = new ThreeDimensionalTextureAccessHelper('chunkData');
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    let {textureAccessHelper} = this;
    const {numChannels} = this;
    builder.addUniform('highp ivec3', 'uVolumeChunkStrides', 4 + (numChannels === 1 ? 0 : 1));
    builder.addFragmentCode(
        textureAccessHelper.getAccessor('readVolumeData', 'uVolumeChunkSampler', this.dataType));
    const shaderType = getShaderType(this.dataType);
    let code = `
${shaderType} getDataValue (highp int channelIndex) {
  highp ivec3 p = getPositionWithinChunk();
  highp ivec3 offset = uVolumeChunkStrides[0]
                     + p.x * uVolumeChunkStrides[1]
                     + p.y * uVolumeChunkStrides[2]
                     + p.z * uVolumeChunkStrides[3];
`;
    if (numChannels > 1) {
      code += `
  offset += channelIndex * uVolumeChunkStrides[4];
`;
    }
    code += `
  return readVolumeData(offset);
}
`;
    builder.addFragmentCode(code);
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  setupTextureLayout(
      gl: GL, shader: ShaderProgram, textureLayout: TextureLayout, fixedChunkPosition: Uint32Array,
      spatialChunkDimensions: number[]) {
    let stridesUniform: Uint32Array;
    const {strides} = textureLayout;
    const rank = fixedChunkPosition.length;
    if (this.numChannels > 1) {
      stridesUniform = tempStridesUniformWithChannel;
      for (let i = 0; i < 3; ++i) {
        stridesUniform[3 * 4 + i] = strides[rank * 3 + i];
      }
    } else {
      stridesUniform = tempStridesUniformWithoutChannel;
    }
    for (let i = 0; i < 3; ++i) {
      let sum = 0;
      for (let chunkDim = 0; chunkDim < rank; ++chunkDim) {
        sum += fixedChunkPosition[chunkDim] * strides[chunkDim * 3 + i];
      }
      stridesUniform[i] = sum;
    }
    for (let i = 0; i < 3; ++i) {
      const chunkDim = spatialChunkDimensions[i];
      for (let j = 0; j < 3; ++j) {
        stridesUniform[i * 3 + 3 + j] = strides[chunkDim * 3 + j];
      }
    }
    gl.uniform3iv(shader.uniform('uVolumeChunkStrides'), stridesUniform);
  }

  getTextureLayout(gl: GL, chunkDataSize: Uint32Array) {
    return TextureLayout.get(gl, chunkDataSize, this.numChannels, this.channelsContiguous);
  }

  setTextureData(gl: GL, textureLayout: TextureLayout, data: TypedArray) {
    const {textureShape} = textureLayout;
    setThreeDimensionalTextureData(
        gl, this, data, textureShape[0], textureShape[1], textureShape[2]);
  }
}

interface Source extends VolumeChunkSource {
  chunkFormatHandler: UncompressedChunkFormatHandler;
}

export class UncompressedVolumeChunk extends SingleTextureVolumeChunk<Uint8Array, TextureLayout> {
  chunkFormat: ChunkFormat;
  source: Source;

  setTextureData(gl: GL) {
    let {source} = this;
    let {chunkFormatHandler} = source;
    let {chunkFormat} = chunkFormatHandler;

    let textureLayout: TextureLayout;
    if (this.chunkDataSize === source.spec.chunkDataSize) {
      this.textureLayout = textureLayout = chunkFormatHandler.textureLayout.addRef();
    } else {
      this.textureLayout = textureLayout = chunkFormat.getTextureLayout(gl, this.chunkDataSize);
    }

    this.chunkFormat.setTextureData(gl, textureLayout, this.data);
  }

  getChannelValueAt(dataPosition: Uint32Array, channel: number): number|Uint64 {
    let {chunkFormat} = this;
    const {chunkDataSize} = this;
    const {numChannels} = chunkFormat;
    let index = 0;
    let stride = 1;
    if (chunkFormat.channelsContiguous) {
      index += channel;
      stride *= numChannels;
    }
    const rank = dataPosition.length;
    for (let i = 0; i < rank; ++i) {
      index += stride * dataPosition[i];
      stride *= chunkDataSize[i];
    }
    let dataType = chunkFormat.dataType;
    let data = this.data;
    switch (dataType) {
      case DataType.UINT8:
      case DataType.FLOAT32:
      case DataType.UINT16:
      case DataType.UINT32:
        return data[index];
      case DataType.UINT64: {
        let index2 = index * 2;
        return new Uint64(data[index2], data[index2 + 1]);
      }
    }
    throw new Error('Invalid data type: ' + dataType);
  }
}

export class UncompressedChunkFormatHandler extends RefCounted implements ChunkFormatHandler {
  chunkFormat: ChunkFormat;
  textureLayout: TextureLayout;

  constructor(gl: GL, spec: VolumeChunkSpecification) {
    super();
    this.chunkFormat = this.registerDisposer(
        ChunkFormat.get(gl, spec.dataType, spec.numChannels, /*channelsContiguous=*/ false));
    this.textureLayout =
        this.registerDisposer(this.chunkFormat.getTextureLayout(gl, spec.chunkDataSize));
  }

  getChunk(source: VolumeChunkSource, x: any) {
    return new UncompressedVolumeChunk(source, x);
  }
}

registerChunkFormatHandler((gl: GL, spec: VolumeChunkSpecification) => {
  if (spec.compressedSegmentationBlockSize == null) {
    return new UncompressedChunkFormatHandler(gl, spec);
  }
  return null;
});
