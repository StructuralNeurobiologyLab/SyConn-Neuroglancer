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

import {readSingleChannelValue as readSingleChannelValueUint32} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint32';
import {readSingleChannelValue as readSingleChannelValueUint64} from 'neuroglancer/sliceview/compressed_segmentation/decode_uint64';
import {SingleTextureChunkFormat, SingleTextureVolumeChunk} from 'neuroglancer/sliceview/single_texture_chunk_format';
import {DataType, VolumeChunkSpecification} from 'neuroglancer/sliceview/volume/base';
import {ChunkFormatHandler, registerChunkFormatHandler} from 'neuroglancer/sliceview/volume/frontend';
import {VolumeChunkSource} from 'neuroglancer/sliceview/volume/frontend';
import {RefCounted} from 'neuroglancer/util/disposable';
import {vec3, vec3Key} from 'neuroglancer/util/geom';
import {Uint64} from 'neuroglancer/util/uint64';
import {GL} from 'neuroglancer/webgl/context';
import {ShaderBuilder, ShaderProgram, ShaderSamplerType} from 'neuroglancer/webgl/shader';
import {getShaderType, glsl_getFortranOrderIndex, glsl_uint32, glsl_uint64} from 'neuroglancer/webgl/shader_lib';
import {compute1dTextureLayout, computeTextureFormat, OneDimensionalTextureAccessHelper, setOneDimensionalTextureData, TextureFormat} from 'neuroglancer/webgl/texture_access';

class TextureLayout extends RefCounted {
  textureXBits: number;
  textureWidth: number;
  textureHeight: number;
  subchunkGridSize: vec3;

  constructor(
      gl: GL, public chunkDataSize: Uint32Array, public subchunkSize: vec3, dataLength: number) {
    super();
    compute1dTextureLayout(this, gl, /*texelsPerElement=*/ 1, dataLength);
    let subchunkGridSize = this.subchunkGridSize = vec3.create();
    for (let i = 0; i < 3; ++i) {
      subchunkGridSize[i] = Math.ceil(chunkDataSize[i] / subchunkSize[i]);
    }
  }

  static get(gl: GL, chunkDataSize: Uint32Array, subchunkSize: vec3, dataLength: number) {
    return gl.memoize.get(
        `sliceview.CompressedSegmentationTextureLayout:${vec3Key(chunkDataSize)},` +
            `${vec3Key(subchunkSize)},${dataLength}`,
        () => new TextureLayout(gl, chunkDataSize, subchunkSize, dataLength));
  }
}

const textureFormat = computeTextureFormat(new TextureFormat(), DataType.UINT32);
const tempStridesUniform = new Uint32Array(4 * 5);

export class ChunkFormat extends SingleTextureChunkFormat<TextureLayout> {
  static get(gl: GL, dataType: DataType, subchunkSize: vec3, numChannels: number) {
    let shaderKey = `sliceview.CompressedSegmentationChunkFormat:${dataType}:${numChannels}`;
    let cacheKey = `${shaderKey}:${vec3Key(subchunkSize)}`;
    return gl.memoize.get(
        cacheKey, () => new ChunkFormat(dataType, subchunkSize, numChannels, shaderKey));
  }

  private textureAccessHelper: OneDimensionalTextureAccessHelper;

  get shaderSamplerType(): ShaderSamplerType {
    return 'usampler2D';
  }

  constructor(
      public dataType: DataType, public subchunkSize: vec3, public numChannels: number,
      key: string) {
    super(key);
    this.textureAccessHelper = new OneDimensionalTextureAccessHelper('chunkData');
  }

  defineShader(builder: ShaderBuilder) {
    super.defineShader(builder);
    let {textureAccessHelper} = this;
    textureAccessHelper.defineShader(builder);
    let local = (x: string) => 'compressedSegmentationChunkFormat_' + x;
    builder.addUniform('highp ivec3', 'uSubchunkGridSize');
    builder.addUniform('highp ivec3', 'uSubchunkSize');
    builder.addUniform('highp ivec4', 'uVolumeChunkStrides', 5);
    builder.addFragmentCode(glsl_getFortranOrderIndex);
    const {dataType} = this;
    const glslType = getShaderType(dataType);

    if (dataType === DataType.UINT64) {
      builder.addFragmentCode(glsl_uint64);
    } else {
      builder.addFragmentCode(glsl_uint32);
    }
    builder.addFragmentCode(textureAccessHelper.getAccessor(
        local('readTextureValue'), 'uVolumeChunkSampler', DataType.UINT32, 1));
    let fragmentCode = `
uint ${local('getChannelOffset')}(int channelIndex) {
  if (channelIndex == 0) {
    return ${this.numChannels}u;
  }
  return ${local('readTextureValue')}(uint(channelIndex)).value;
}
${glslType} getDataValue (int channelIndex) {
  highp ivec3 p = getPositionWithinChunk();
  highp ivec4 chunkPositionFull = uVolumeChunkStrides[0] +
                     + p.x * uVolumeChunkStrides[1]
                     + p.y * uVolumeChunkStrides[2]
                     + p.z * uVolumeChunkStrides[3]
                     + channelIndex * uVolumeChunkStrides[4];
  highp ivec3 chunkPosition = chunkPositionFull.xyz;

  // TODO: maybe premultiply this and store as uniform.
  ivec3 subchunkGridPosition = chunkPosition / uSubchunkSize;
  int subchunkGridOffset = getFortranOrderIndex(subchunkGridPosition, uSubchunkGridSize);

  int channelOffset = int(${local('getChannelOffset')}(chunkPositionFull[3]));

  // TODO: Maybe just combine this offset into subchunkGridStrides.
  int subchunkHeaderOffset = subchunkGridOffset * 2 + channelOffset;

  highp uint subchunkHeader0 = ${local('readTextureValue')}(uint(subchunkHeaderOffset)).value;
  highp uint subchunkHeader1 = ${local('readTextureValue')}(uint(subchunkHeaderOffset + 1)).value;
  highp uint outputValueOffset = (subchunkHeader0 & 0xFFFFFFu) + uint(channelOffset);
  highp uint encodingBits = subchunkHeader0 >> 24u;
  if (encodingBits > 0u) {
    ivec3 subchunkPosition = chunkPosition - subchunkGridPosition * uSubchunkSize;
    int subchunkOffset = getFortranOrderIndex(subchunkPosition, uSubchunkSize);
    uint encodedValueBaseOffset = subchunkHeader1 + uint(channelOffset);
    uint encodedValueOffset = encodedValueBaseOffset + uint(subchunkOffset) * encodingBits / 32u;
    uint encodedValue = ${local('readTextureValue')}(encodedValueOffset).value;
    uint wordOffset = uint(subchunkOffset) * encodingBits % 32u;
    uint encodedValueShifted = encodedValue >> wordOffset;
    uint decodedValue = encodedValueShifted - (encodedValueShifted >> encodingBits << encodingBits);
    outputValueOffset += decodedValue * ${this.dataType === DataType.UINT64 ? '2u' : '1u'};
  }
  ${glslType} result;
`;
    if (dataType === DataType.UINT64) {
      fragmentCode += `
  result.value[0] = ${local('readTextureValue')}(outputValueOffset).value;
  result.value[1] = ${local('readTextureValue')}(outputValueOffset+1u).value;
`;
    } else {
      fragmentCode += `
  result.value = ${local('readTextureValue')}(outputValueOffset).value;
`;
    }
    fragmentCode += `
  return result;
}
`;
    builder.addFragmentCode(fragmentCode);
  }

  /**
   * Called each time textureLayout changes while drawing chunks.
   */
  setupTextureLayout(
      gl: GL, shader: ShaderProgram, textureLayout: TextureLayout, fixedChunkPosition: Uint32Array,
      spatialChunkDimensions: number[]) {
    const {subchunkGridSize} = textureLayout;
    gl.uniform3i(
        shader.uniform('uSubchunkGridSize'), subchunkGridSize[0], subchunkGridSize[1],
        subchunkGridSize[2]);
    const stridesUniform = tempStridesUniform;
    stridesUniform.fill(0);
    // channel is identity mapped at the moment
    stridesUniform[4 * 4 + 3] = 1;
    for (let i = 0; i < 3; ++i) {
      stridesUniform[i] = fixedChunkPosition[i];
      const chunkDim = spatialChunkDimensions[i];
      if (chunkDim === -1) continue;
      stridesUniform[4 * (i + 1) + chunkDim] = 1;
    }
    gl.uniform4iv(shader.uniform('uVolumeChunkStrides'), stridesUniform);
    this.textureAccessHelper.setupTextureLayout(gl, shader, textureLayout);
  }

  setTextureData(gl: GL, textureLayout: TextureLayout, data: Uint32Array) {
    setOneDimensionalTextureData(gl, textureLayout, textureFormat, data);
  }

  getTextureLayout(gl: GL, chunkDataSize: Uint32Array, dataLength: number) {
    return TextureLayout.get(gl, chunkDataSize, this.subchunkSize, dataLength);
  }

  beginSource(gl: GL, shader: ShaderProgram) {
    super.beginSource(gl, shader);
    const {subchunkSize} = this;
    gl.uniform3i(
        shader.uniform('uSubchunkSize'), subchunkSize[0], subchunkSize[1], subchunkSize[2]);
  }
}

export class CompressedSegmentationVolumeChunk extends
    SingleTextureVolumeChunk<Uint32Array, TextureLayout> {
  chunkFormat: ChunkFormat;

  setTextureData(gl: GL) {
    let {data} = this;
    let {chunkFormat} = this;
    let textureLayout = this.textureLayout =
        chunkFormat.getTextureLayout(gl, this.chunkDataSize, data.length);
    chunkFormat.setTextureData(gl, textureLayout, data);
  }

  getChannelValueAt(dataPosition: Uint32Array, channel: number): Uint64|number {
    let {chunkDataSize, chunkFormat} = this;
    let {data} = this;
    let offset = data[channel];
    if (chunkFormat.dataType === DataType.UINT64) {
      let result = new Uint64();
      readSingleChannelValueUint64(
          result, data, /*baseOffset=*/ offset, chunkDataSize, chunkFormat.subchunkSize,
          dataPosition);
      return result;
    } else {
      return readSingleChannelValueUint32(
          data, /*baseOffset=*/ offset, chunkDataSize, chunkFormat.subchunkSize, dataPosition);
    }
  }
}

export class CompressedSegmentationChunkFormatHandler extends RefCounted implements
    ChunkFormatHandler {
  chunkFormat: ChunkFormat;

  constructor(gl: GL, spec: VolumeChunkSpecification) {
    super();
    let {dataType} = spec;
    if (dataType !== DataType.UINT64 && dataType !== DataType.UINT32) {
      throw new Error(`Unsupported compressed segmentation data type: ${DataType[dataType]}`);
    }
    this.chunkFormat = this.registerDisposer(ChunkFormat.get(
        gl, spec.dataType, spec.compressedSegmentationBlockSize!, spec.numChannels));
  }

  getChunk(source: VolumeChunkSource, x: any) {
    return new CompressedSegmentationVolumeChunk(source, x);
  }
}

registerChunkFormatHandler((gl: GL, spec: VolumeChunkSpecification) => {
  if (spec.compressedSegmentationBlockSize != null) {
    return new CompressedSegmentationChunkFormatHandler(gl, spec);
  }
  return null;
});
