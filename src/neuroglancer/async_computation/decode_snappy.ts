import * as Snappy from 'snappyjs'
// import {uncompress} from 'snappyjs'
// import ArrayBufferReader from 'unzipit'
import * as Unzipit from 'unzipit'
import {decodeSnappy} from 'neuroglancer/async_computation/decode_snappy_request';
import {registerAsyncComputation} from 'neuroglancer/async_computation/handler';


registerAsyncComputation(
    decodeSnappy,
    async function(data: ArrayBuffer) {
      const {entries} = await Unzipit.unzip(data)
      const result = new Uint8Array(Snappy.uncompress(await entries[Object.keys(entries)[0]].arrayBuffer()));
      return { value: result, transfer: [result.buffer] };
    });
