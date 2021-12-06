/**
*  Source code created by Max Planck Institute of Neuobiology
*
* Authors: Andrei Mancu, Hashir Ahmad, Philipp Schubert, Joergen Kornfeld
* */


export enum VolumeChunkEncoding {
  RAW,
  GZIP,
  KNOSSOS,
  JPEG,
}

export class VolumeChunkSourceParameters {
  url: string;
  encoding: VolumeChunkEncoding;

  static RPC_ID = 'knossos/VolumeChunkSource';
}



//
// import {vec2} from 'neuroglancer/util/geom';
//
// export class KnossosSourceParameters {
//   baseUrl: string;
//   acquisition: string;
//   version: string;
//   channel: string;
//   scale: string;
//
//   resolution: string;
// }
//
// export class VolumeChunkSourceParameters extends KnossosSourceParameters {
//   encoding: string;
//   window: vec2|undefined;
//
//   static RPC_ID = 'knossos/VolumeChunkSource';
//
//   //TODO url here
//   static stringify(parameters: VolumeChunkSourceParameters) {
//     return `knossos:volume:${parameters.baseUrl}/${parameters.acquisition}/${
//         parameters.version}/${parameters.channel}/${parameters.resolution}/${
//         parameters.encoding}`;
//   }
// }
//
// //TODO add skeleton
//
// export class MeshSourceParameters {
//   baseUrl: string;
//
//   static RPC_ID = 'knossos/MeshChunkSource';
//
//   static stringify(parameters: MeshSourceParameters) {
//     return `knossos:mesh:${parameters.baseUrl}`;
//   }
// }
//
// export class SkeletonSourceParameters {
//   baseUrl: string;
//
//   static RPC_ID = 'knossos/SkeletonSource';
//
//   static stringify(parameters: MeshSourceParameters) {
//     return `knossos:skeleton:${parameters.baseUrl}`;
//   }
// }
