/**
*  Source code created by Max Planck Institute of Neuobiology
*
* Authors: Andrei Mancu, Hashir Ahmad, Philipp Schubert, Joergen Kornfeld
* */

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
// import {KnossosToken, fetchWithKnossosCredentials} from 'neuroglancer/datasource/knossos/api';
import {VolumeChunkSourceParameters} from 'neuroglancer/datasource/knossos/base';
// import {assignMeshFragmentData, decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
// import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
// import {decodeKnossosSnappyChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/snappy';   //TODO here
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {responseArrayBuffer} from 'neuroglancer/util/http_request';
import {registerSharedObject} from 'neuroglancer/worker_rpc';
import {VolumeChunkEncoding} from "neuroglancer/datasource/knossos/base";
import {requestAsyncComputation} from "neuroglancer/async_computation/request";
import {decodeGzip} from "neuroglancer/async_computation/decode_gzip_request";
import {decodeSnappy} from "neuroglancer/async_computation/decode_snappy_request";
import {decodeRawChunk} from "neuroglancer/sliceview/backend_chunk_decoders/raw";
import {
  cancellableFetchSpecialOk,
  SpecialProtocolCredentials
} from "neuroglancer/util/special_protocol_request";

async function decodeChunk(
    chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer,
    encoding: VolumeChunkEncoding) {
  const dv = new DataView(response);
  const offset = dv.getBigInt64(0, true);
  const size = dv.getBigUint64(8, true);
  const numCubes = dv.getInt8(16);

  console.log(`size: ${size}`);
  console.log(`numCubes: ${numCubes}`);

  if (numCubes === 0) {
    throw new Error('Retrieved zero cubes. Must be atleast 1 cube');
  }
  console.log(`offset ${offset}`)
  
  

  // const cubeLength = dv.getBigInt64(4, true);
  // // if (l1 === 0) {
  // //   throw new Error(`Found 0 cubes.`);
  // // }
  // console.log(`Length of cube 1: ${cubeLength}`);
  
  let offset_2 = 17;
  
  for (let i = 0; i < numCubes; ++i) {
    const cubeLength = dv.getBigInt64(offset_2, true);
    console.log(`Length of cube ${i}: ${cubeLength}`);
    offset_2 += Number(cubeLength)*8;
  }

  const numDimensions = dv.getUint16(2, /*littleEndian=*/ false);
  if (numDimensions !== chunk.source!.spec.rank) {
    throw new Error(`Number of dimensions must be 3.`);
  }

  let offset_3 = 4;
  const shape = new Uint32Array(numDimensions);
  for (let i = 0; i < numDimensions; ++i) {
    shape[i] = dv.getUint32(offset_3, /*littleEndian=*/ false);
    offset_3 += 4;
  }

  chunk.chunkDataSize = shape;
  let buffer = new Uint8Array(response, offset);
  switch (encoding) {
    case VolumeChunkEncoding.GZIP:
      buffer =
          await requestAsyncComputation(decodeGzip, cancellationToken, [buffer.buffer], buffer);
      break;
    case VolumeChunkEncoding.KNOSSOS:
      buffer =
          await requestAsyncComputation(decodeSnappy, cancellationToken, [buffer.buffer], buffer);
      break;
  }
  await decodeRawChunk(
      chunk, cancellationToken, buffer.buffer, Endianness.BIG, buffer.byteOffset,
      buffer.byteLength);
}


@registerSharedObject() export class PrecomputedVolumeChunkSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {
  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    const {chunkGridPosition} = chunk;
    let url = parameters.url;
    let chunkPosition = this.computeChunkBounds(chunk);
    let chunkDataSize = chunk.chunkDataSize!;
    url = `${parameters.url}/${chunkPosition[0]}-${chunkPosition[0] + chunkDataSize[0]}_` +
          `${chunkPosition[1]}-${chunkPosition[1] + chunkDataSize[1]}_` +
          `${chunkPosition[2]}-${chunkPosition[2] + chunkDataSize[2]}`;
    const response = await cancellableFetchSpecialOk(
        this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);
    console.log(`Full response length ${response.byteLength}`);
    
    await decodeChunk(chunk, cancellationToken, response, parameters.encoding);
  }
}


//
//
// let chunkDecoders = new Map<string, ChunkDecoder>();
// chunkDecoders.set('snappy', decodeKnossosSnappyChunk);
// chunkDecoders.set('zip', decodeJpegChunk);
//
// let acceptHeaders = new Map<string, string>();
// acceptHeaders.set('snappy', 'application/npygz');
// acceptHeaders.set('zip', 'image/jpeg');               //TODO what are these headers mapped to?
//
// function KnossosSource<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
//     Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
//   return WithParameters(
//       WithSharedCredentialsProviderCounterpart<KnossosToken>()(Base), parametersConstructor);
// }
//
// @registerSharedObject()
// export class KnossosVolumeChunkSource extends (KnossosSource(VolumeChunkSource, VolumeChunkSourceParameters)) {
//   chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;
//
//   async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
//     let {parameters} = this;
//     let url = `${parameters.baseUrl}/latest/cutout/${parameters.acquisition}/${parameters.version}/${
//         parameters.channel}/${parameters.resolution}`;
//     {
//       // chunkPosition must not be captured, since it will be invalidated by the next call to
//       // computeChunkBounds.
//       let chunkPosition = this.computeChunkBounds(chunk);
//       let chunkDataSize = chunk.chunkDataSize!;
//       for (let i = 0; i < 3; ++i) {
//         url += `/${chunkPosition[i]}:${chunkPosition[i] + chunkDataSize[i]}`;
//       }
//     }
//     url += '/';
//
//     if (parameters.window !== undefined) {
//       url += `?window=${parameters.window[0]},${parameters.window[1]}`;
//     }
//     const response = await fetchWithKnossosCredentials(
//         this.credentialsProvider, url,
//         {headers: {'Accept': acceptHeaders.get(parameters.encoding)!}}, responseArrayBuffer,
//         cancellationToken);
//     await this.chunkDecoder(chunk, cancellationToken, response);
//   }
// }
//
// function decodeManifestChunk(chunk: ManifestChunk, response: any) {
//   return decodeJsonManifestChunk(chunk, response, 'fragments');
// }
//
// function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
//   let dv = new DataView(response);
//   let numVertices = dv.getUint32(0, true);
//   assignMeshFragmentData(
//       chunk,
//       decodeTriangleVertexPositionsAndIndices(
//           response, Endianness.LITTLE, /*vertexByteOffset=*/ 4, numVertices));
// }
//
// @registerSharedObject()
// export class KnossosMeshSource extends (KnossosSource(MeshSource, MeshSourceParameters)) {
//   download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
//     const {parameters} = this;
//     return cancellableFetchOk(
//                `${parameters.baseUrl}${chunk.objectId}`, {}, responseArrayBuffer, cancellationToken)
//         .then(response => decodeManifestChunk(chunk, response));
//   }
//
//   downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
//     const {parameters} = this;
//     return cancellableFetchOk(
//                `${parameters.baseUrl}${chunk.fragmentId}`, {}, responseArrayBuffer,
//                cancellationToken)
//         .then(response => decodeFragmentChunk(chunk, response));
//   }
// }
