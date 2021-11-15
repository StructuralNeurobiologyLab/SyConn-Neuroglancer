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
  // let offset = new BigUInt64Array();
  // for(let i =0; i < 3;++i){
  //     offset[i] = dv.getBigUint64(0+i*8, true);
  // }
  //
  // const size = dv.getBigUint64(8, true);
  // const numCubes = dv.getInt8(16);
  //
  // console.log(`size: ${size}`);
  // console.log(`numCubes: ${numCubes}`);
  //
  // if (numCubes === 0) {
  //   throw new Error('Retrieved zero cubes. Must be atleast 1 cube');
  // }
  // console.log(`offset ${offset}`)
  //
  //
  //
  // // const cubeLength = dv.getBigInt64(4, true);
  // // // if (l1 === 0) {
  // // //   throw new Error(`Found 0 cubes.`);
  // // // }
  // // console.log(`Length of cube 1: ${cubeLength}`);
  //
  // let offset_2 = 17;
  //
  // for (let i = 0; i < numCubes; ++i) {
  //   let coords = new BigUint64Array(3);
  //   for(let i =0; i < 3;++i){
  //     coords[i] = dv.getBigUint64(offset_2+8*i, true);
  //   }
  //   console.log(coords)
  //   let cubeLength = dv.getBigUint64(offset_2+24, true);
  //   console.log(`Length of cube ${i}: ${cubeLength}`);
  //   let snappy_cube = response.slice(offset_2+32, offset_2+32+Number(cubeLength));
  //   offset_2 += 32+Number(cubeLength);
  // }


  chunk.chunkDataSize = shape;
  let buffer = new Uint8Array(response, 0);
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
    let xfolder = String(chunkGridPosition[0]).padStart(4,'0');
    let yfolder = String(chunkGridPosition[1]).padStart(4,'0');
    let zfolder= String(chunkGridPosition[2]).padStart(4,'0');
    url = `${parameters.url}/x${xfolder}/y${yfolder}/z${zfolder}/j0251_realigned_mag${parameters.url.substr(parameters.url.length-1)}_x${xfolder}_y${yfolder}_z${zfolder}`;
    const response = await cancellableFetchSpecialOk(
        this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);
    console.log(`Full response length ${response.byteLength}`);
    
    await decodeChunk(chunk, cancellationToken, response, parameters.encoding);
  }
}
