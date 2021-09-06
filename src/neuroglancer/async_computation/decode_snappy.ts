
import {uncompress} from 'snappy'
import {decodeSnappy} from 'neuroglancer/async_computation/decode_snappy_request';
import {registerAsyncComputation} from 'neuroglancer/async_computation/handler';

registerAsyncComputation(
    decodeSnappy,
    async function(data: Uint8Array) {
      const result = new Uint8Array(await uncompress(new Buffer(data)));
      return { value: result, transfer: [result.buffer] };
    });
