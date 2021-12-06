// import * as Snappy from 'snappyjs'
// import {snappy} from 'evan-wasm';
import * as Snappy from '@evan/wasm/target/snappy/simd.js'
// import {uncompress} from 'snappyjs'
// import ArrayBufferReader from 'unzipit'
import * as Unzipit from 'unzipit'
import {decodeSnappy} from 'neuroglancer/async_computation/decode_snappy_request';
import {registerAsyncComputation} from 'neuroglancer/async_computation/handler';


registerAsyncComputation(
    decodeSnappy,
    async function(data: ArrayBuffer) {
      // var startTime = performance.now();
      const {entries} = await Unzipit.unzip(data);
      const buffer = new Uint8Array(await entries[Object.keys(entries)[0]].arrayBuffer());
      // var endTime = performance.now();
      // console.log(`Call to unzip took ${endTime - startTime} milliseconds`);
      let startTime = performance.now();
      const result = new Uint8Array(Snappy.decompress_raw(buffer));
      let endTime = performance.now();
      console.log(`Call to snappy took ${endTime - startTime} milliseconds`);
      return { value: result, transfer: [result.buffer] };
    });
