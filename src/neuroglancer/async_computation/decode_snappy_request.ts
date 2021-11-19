import {asyncComputation} from 'neuroglancer/async_computation';

export const decodeSnappy = asyncComputation<(data: ArrayBuffer) => Uint8Array>('decodeSnappy');
