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
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {decodeSnappy} from "neuroglancer/async_computation/decode_snappy_request";
import {decodeRawChunk} from "neuroglancer/sliceview/backend_chunk_decoders/raw";
import {
  cancellableFetchSpecialOk,
  SpecialProtocolCredentials
} from "neuroglancer/util/special_protocol_request";
import {decodeJpeg} from "../../async_computation/decode_jpeg_request";

async function decodeChunk(
    chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer,
    encoding: VolumeChunkEncoding) {
  // chunk.chunkDataSize = shape;
  let buffer = new Uint8Array(response, 0);
  // var startTime = performance.now();
  switch (encoding) {
    case VolumeChunkEncoding.GZIP:
      buffer =
          await requestAsyncComputation(decodeGzip, cancellationToken, [buffer.buffer], buffer);
      break;
    case VolumeChunkEncoding.KNOSSOS:
      buffer =
          await requestAsyncComputation(decodeSnappy, cancellationToken, [buffer.buffer], buffer);
      break;
    case VolumeChunkEncoding.JPEG:
      var startTime = performance.now();
      const chunkDataSize = chunk.chunkDataSize!;
      // chunkDataSize.forEach(elem => {
      //   console.log(elem);
      // });
      buffer = await requestAsyncComputation(decodeJpeg, cancellationToken, [buffer.buffer], buffer, chunkDataSize[0],
      chunkDataSize[1] * chunkDataSize[2], chunkDataSize[3] || 1, false);
      var endTime = performance.now();
      console.log(`Call to decodeJpeg took ${endTime - startTime} milliseconds`);
      break;
  }
  await decodeRawChunk(
      chunk, cancellationToken, buffer.buffer, Endianness.BIG, buffer.byteOffset,
      buffer.byteLength);
  // var endTime = performance.now();
  // console.log(`Call to doSomething took ${endTime - startTime} milliseconds`);
}


@registerSharedObject() export class PrecomputedVolumeChunkSource extends
(WithParameters(WithSharedCredentialsProviderCounterpart<SpecialProtocolCredentials>()(VolumeChunkSource), VolumeChunkSourceParameters)) {
  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    const {chunkGridPosition, source} = chunk;
    let url = parameters.url;
    let chunkPosition = this.computeChunkBounds(chunk);
    let chunkDataSize = chunk.chunkDataSize!;
    let xfolder = String(chunkGridPosition[0]).padStart(4,'0');
    let yfolder = String(chunkGridPosition[1]).padStart(4,'0');
    let zfolder= String(chunkGridPosition[2]).padStart(4,'0');
    // don't forget the mags >10
    let mag_num = parameters.url.substr(parameters.url.length-5).replace(/^\D+/g, '');
    // set type of file
    let type = "";
    if(parameters.encoding == 2){
      type = ".seg.sz.zip";
    }
    else if(parameters.encoding == 1){
      type = ".gzip";
    }
    else if(parameters.encoding == 3){
      type = ".jpg";
    }
    else{
      type = ".raw";
    }
    url = `${parameters.url}/x${xfolder}/y${yfolder}/z${zfolder}/j0251_realigned_mag${mag_num}_x${xfolder}_y${yfolder}_z${zfolder}${type}`;
    const response = await cancellableFetchSpecialOk(
        this.credentialsProvider, url, {}, responseArrayBuffer, cancellationToken);
    console.log(`Full response length ${response.byteLength}`);
    
    await decodeChunk(chunk, cancellationToken, response, parameters.encoding);
  }
}
