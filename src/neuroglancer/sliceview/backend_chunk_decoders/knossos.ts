// Max Planck property here

/**
 *  Max-Planck Institute of Neurobiology
 *
 *  Fortend handle for snappy compressed data.
 */

import {TypedArray} from 'neuroglancer/util/array';
import {decodeRawChunk} from 'neuroglancer/sliceview/backend_chunk_decoders/raw';
import {VolumeChunk} from 'neuroglancer/sliceview/volume/backend';
import {CancellationToken} from 'neuroglancer/util/cancellation';
import {decodeSnappy} from 'neuroglancer/async_computation/decode_snappy_request';
import {requestAsyncComputation} from 'neuroglancer/async_computation/request';

export async function decodeKnossosChunk(
    chunk: VolumeChunk, cancellationToken: CancellationToken, response: ArrayBuffer) {

  let image : TypedArray = await requestAsyncComputation(
    decodeSnappy, cancellationToken, [response], new Uint8Array(response)
  );

  await decodeRawChunk(chunk, cancellationToken, image.buffer);
}
