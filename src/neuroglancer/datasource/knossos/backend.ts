/**
*  Source code created by Max Planck Institute of Neuobiology
*
* Authors: Andrei Mancu, Hashir Ahmad, Philipp Schubert, Joergen Kornfeld
* */

import {WithParameters} from 'neuroglancer/chunk_manager/backend';
import {ChunkSourceParametersConstructor} from 'neuroglancer/chunk_manager/base';
import {WithSharedCredentialsProviderCounterpart} from 'neuroglancer/credentials_provider/shared_counterpart';
import {KnossosToken, fetchWithKnossosCredentials} from 'neuroglancer/datasource/knossos/api';
import {MeshSourceParameters, VolumeChunkSourceParameters} from 'neuroglancer/datasource/knossos/base';
import {assignMeshFragmentData, decodeJsonManifestChunk, decodeTriangleVertexPositionsAndIndices, FragmentChunk, ManifestChunk, MeshSource} from 'neuroglancer/mesh/backend';
import {ChunkDecoder} from 'neuroglancer/sliceview/backend_chunk_decoders';
import {decodeKnossosSnappyChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/snappy';   //TODO here
import {decodeJpegChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/jpeg';
import {VolumeChunk, VolumeChunkSource} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {Endianness} from 'neuroglancer/util/endian';
import {cancellableFetchOk, responseArrayBuffer} from 'neuroglancer/util/http_request';
import {registerSharedObject, SharedObject} from 'neuroglancer/worker_rpc';

let chunkDecoders = new Map<string, ChunkDecoder>();
chunkDecoders.set('snappy', decodeKnossosSnappyChunk);
chunkDecoders.set('zip', decodeJpegChunk);

let acceptHeaders = new Map<string, string>();
acceptHeaders.set('snappy', 'application/npygz');
acceptHeaders.set('zip', 'image/jpeg');               //TODO what are these headers mapped to?

function KnossosSource<Parameters, TBase extends {new (...args: any[]): SharedObject}>(
    Base: TBase, parametersConstructor: ChunkSourceParametersConstructor<Parameters>) {
  return WithParameters(
      WithSharedCredentialsProviderCounterpart<KnossosToken>()(Base), parametersConstructor);
}

@registerSharedObject()
export class KnossosVolumeChunkSource extends (KnossosSource(VolumeChunkSource, VolumeChunkSourceParameters)) {
  chunkDecoder = chunkDecoders.get(this.parameters.encoding)!;

  async download(chunk: VolumeChunk, cancellationToken: CancellationToken) {
    let {parameters} = this;
    let url = `${parameters.baseUrl}/latest/cutout/${parameters.acquisition}/${parameters.version}/${
        parameters.channel}/${parameters.resolution}`;
    {
      // chunkPosition must not be captured, since it will be invalidated by the next call to
      // computeChunkBounds.
      let chunkPosition = this.computeChunkBounds(chunk);
      let chunkDataSize = chunk.chunkDataSize!;
      for (let i = 0; i < 3; ++i) {
        url += `/${chunkPosition[i]}:${chunkPosition[i] + chunkDataSize[i]}`;
      }
    }
    url += '/';

    if (parameters.window !== undefined) {
      url += `?window=${parameters.window[0]},${parameters.window[1]}`;
    }
    const response = await fetchWithKnossosCredentials(
        this.credentialsProvider, url,
        {headers: {'Accept': acceptHeaders.get(parameters.encoding)!}}, responseArrayBuffer,
        cancellationToken);
    await this.chunkDecoder(chunk, cancellationToken, response);
  }
}

function decodeManifestChunk(chunk: ManifestChunk, response: any) {
  return decodeJsonManifestChunk(chunk, response, 'fragments');
}

function decodeFragmentChunk(chunk: FragmentChunk, response: ArrayBuffer) {
  let dv = new DataView(response);
  let numVertices = dv.getUint32(0, true);
  assignMeshFragmentData(
      chunk,
      decodeTriangleVertexPositionsAndIndices(
          response, Endianness.LITTLE, /*vertexByteOffset=*/ 4, numVertices));
}

@registerSharedObject()
export class KnossosMeshSource extends (KnossosSource(MeshSource, MeshSourceParameters)) {
  download(chunk: ManifestChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    return cancellableFetchOk(
               `${parameters.baseUrl}${chunk.objectId}`, {}, responseArrayBuffer, cancellationToken)
        .then(response => decodeManifestChunk(chunk, response));
  }

  downloadFragment(chunk: FragmentChunk, cancellationToken: CancellationToken) {
    const {parameters} = this;
    return cancellableFetchOk(
               `${parameters.baseUrl}${chunk.fragmentId}`, {}, responseArrayBuffer,
               cancellationToken)
        .then(response => decodeFragmentChunk(chunk, response));
  }
}
