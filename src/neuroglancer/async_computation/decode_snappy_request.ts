


import {asyncComputation} from 'neuroglancer/async_computation';

export const decodeSnappy = asyncComputation<(data: Uint8Array) => Uint8Array>('decodeSnappy');
