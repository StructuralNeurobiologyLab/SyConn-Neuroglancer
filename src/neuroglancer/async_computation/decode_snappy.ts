import * as Snappy from 'snappyjs'
// import {uncompress} from 'snappyjs'
import {decodeSnappy} from 'neuroglancer/async_computation/decode_snappy_request';
import {registerAsyncComputation} from 'neuroglancer/async_computation/handler';


registerAsyncComputation(
    decodeSnappy,
    async function(data: Uint8Array) {
      const result = Snappy.uncompress(new Buffer(data))
      return { value: result, transfer: [result.buffer] };
    });
