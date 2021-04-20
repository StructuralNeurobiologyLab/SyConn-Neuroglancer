# @license
# Copyright 2016 Google Inc.
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#      http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

from __future__ import absolute_import, division, print_function

import collections
import math
import struct
import threading

import numpy as np
from scipy import ndimage
import six
import syconn

from . import downsample, downsample_scales
from .chunks import encode_jpeg, encode_npz, encode_raw
from .coordinate_space import CoordinateSpace
from . import trackable_state
from .random_token import make_random_token
from knossos_utils import KnossosDataset


class MeshImplementationNotAvailable(Exception):
    pass


class MeshesNotSupportedForVolume(Exception):
    pass


class InvalidObjectIdForMesh(Exception):
    pass


class LocalVolume(trackable_state.ChangeNotifier):
    def __init__(self,
                 dataset,  # TODO(Andrei): KnossosDataset
                 # data=None,
                 dimensions=None,
                 volume_type=None,
                 voxel_offset=None,
                 encoding='npz',
                 max_voxels_per_chunk_log2=None,
                 precomputedMesh=False,  # added for precomputed meshes
                 task_type='lowest_then_downsample',
                 mesh_options=None,
                 backend=None,
                 object_type='sv',
                 downsampling='3d',
                 chunk_layout=None,
                 max_downsampling=downsample_scales.DEFAULT_MAX_DOWNSAMPLING,
                 max_downsampled_size=downsample_scales.DEFAULT_MAX_DOWNSAMPLED_SIZE,
                 max_downsampling_scales=downsample_scales.DEFAULT_MAX_DOWNSAMPLING_SCALES):
        """Initializes a LocalVolume.
        @param data: Source data.
        @param downsampling: '3d' to use isotropic downsampling, '2d' to downsample separately in
            XY, XZ, and YZ, None to use no downsampling.
        @param max_downsampling: Maximum amount by which on-the-fly downsampling may reduce the
            volume of a chunk.  For example, 4x4x4 downsampling reduces the volume by 64.
        @param volume_type: either 'image' or 'segmentation'.  If not specified, guessed from the
            data type.
        @param voxel_size: Sequence [x, y, z] of floats.  Specifies the voxel size.
        @param mesh_options: A dict with the following keys specifying options for mesh
            simplification for 'segmentation' volumes:
                - max_quadrics_error: float.  Edge collapses with a larger associated quadrics error
                  than this amount are prohibited.  Set this to a negative number to disable mesh
                  simplification, and just use the original mesh produced by the marching cubes
                  algorithm.  Defaults to 1e6.  The effect of this value depends on the voxel_size.
                - max_normal_angle_deviation: float.  Edge collapses that change a triangle normal
                  by more than this angle are prohibited.  The angle is specified in degrees.
                  Defaults to 90.
                - lock_boundary_vertices: bool.  Retain all vertices along mesh surface boundaries,
                  which can only occur at the boundary of the volume.  Defaults to true.
        """
        super(LocalVolume, self).__init__()
        self.token = make_random_token()
        if not isinstance(dataset, KnossosDataset):
            raise ValueError('Dataset parameter is not a KnossosDatset object')
        self.dataset = dataset
        boundaries = dataset.boundary
        self.shape = [boundaries[2], boundaries[1], boundaries[0]]  # data.shape TODO(Andrei)
        
        rank = self.rank = len(self.shape)  # TODO(Andrei)
        print(f'Shape: {self.shape}')
        print(f'Rank: {self.rank}')
        
        if dimensions is None:
            dimensions = CoordinateSpace(
                names=['d%d' % d for d in range(rank)],
                units=[''] * rank,
                scales=[1] * rank,
            )
        
        if rank != dimensions.rank:
            raise ValueError('rank of data (%d) must match rank of coordinate space (%d)' %
                             (rank, dimensions.rank))
        
        if voxel_offset is None:
            voxel_offset = np.zeros(rank, dtype=np.int64)
        
        else:
            voxel_offset = np.array(voxel_offset, dtype=np.int64)
        
        if voxel_offset.shape != (rank,):
            raise ValueError('voxel_offset must have shape of (%d,)' % (rank,))
        
        self.voxel_offset = voxel_offset
        self.dimensions = dimensions
        
        if volume_type == 'image':
            self.data_type = 'uint8'  # TODO(Andrei) np.dtype(data.dtype).name
        
        else:
            self.data_type = 'uint64'
        
        if self.data_type == 'float64':
            self.data_type = 'float32'
        
        self.encoding = encoding
        
        if volume_type is None:
            
            if self.rank == 3 and (self.data_type == 'uint16' or
                                   self.data_type == 'uint32' or
                                   self.data_type == 'uint64'):
                volume_type = 'segmentation'
        
            else:
                volume_type = 'image'

        self.volume_type = volume_type
        self.subvol_task_types = tuple(['highest_then_upsample', 'lowest_then_downsample'])

        if task_type not in self.subvol_task_types:
            raise ValueError('Invalid downsampling task type, should be one of {}'.format(self.subvol_task_types))

        self.task_type = task_type
        self._precomputedMesh = precomputedMesh
        self._mesh_generator = None
        self._mesh_generator_pending = None
        self._mesh_generator_lock = threading.Condition()
        self._mesh_options = mesh_options.copy() if mesh_options is not None else dict()
        self.obj_type = object_type
        
        if backend is None or not isinstance(backend, syconn.analysis.backend.SyConnBackend):
            raise ValueError('backend must be a SyConnBackend object')
        
        else:
            self.backend = backend
        
        self.max_voxels_per_chunk_log2 = max_voxels_per_chunk_log2
        self.downsampling_layout = downsampling
        
        if chunk_layout is None:
            
            if downsampling == '2d':
                chunk_layout = 'flat'
            
            else:
                chunk_layout = 'isotropic'
        
        self.chunk_layout = chunk_layout
        self.max_downsampling = max_downsampling
        self.max_downsampled_size = max_downsampled_size
        self.max_downsampling_scales = max_downsampling_scales
    
    @property
    def precomputedMesh(self):
        
        return self._precomputedMesh
    
    def info(self):
        
        info = dict(dataType=self.data_type,
                    encoding=self.encoding,
                    generation=self.change_count,
                    coordinateSpace=self.dimensions.to_json(),
                    shape=self.shape,
                    volumeType=self.volume_type,
                    voxelOffset=self.voxel_offset,
                    chunkLayout=self.chunk_layout,
                    downsamplingLayout=self.downsampling_layout,
                    maxDownsampling=None if math.isinf(
                        self.max_downsampling) else self.max_downsampling,
                    maxDownsampledSize=None if math.isinf(
                        self.max_downsampled_size) else self.max_downsampled_size,
                    maxDownsamplingScales=None if math.isinf(
                        self.max_downsampling_scales) else self.max_downsampling_scales,
                    )
        
        if self.max_voxels_per_chunk_log2 is not None:
            info['maxVoxelsPerChunkLog2'] = self.max_voxels_per_chunk_log2
        
        return info
    
    def get_encoded_subvolume(self, data_format, start, end, scale_key):

        rank = self.rank
        
        if len(start) != rank or len(end) != rank:
            raise ValueError('Invalid request')
        
        downsample_factor = np.array(scale_key.split(','), dtype=np.int64)
        # print(downsample_factor)
        
        if (len(downsample_factor) != rank or np.any(downsample_factor < 1)
            or np.any(downsample_factor > self.max_downsampling)
            or np.prod(downsample_factor) > self.max_downsampling):
            raise ValueError('Invalid downsampling factor.')
        
        downsampled_shape = np.cast[np.int64](np.ceil(self.shape / downsample_factor))
        
        if np.any(end < start) or np.any(start < 0) or np.any(end > downsampled_shape):
            raise ValueError('Out of bounds data request.')
        
        # if(np.all(downsample_factor)==1):
        #     print("MAG 1")
        # indexing_expr = tuple(
        #     np.s_[start[i] * downsample_factor[i]:end[i] * downsample_factor[i]]  # TODO(Andrei)
        #     for i in range(rank))
        
        offset = tuple(start[i] * downsample_factor[i] for i in reversed(range(rank)))
        # offset = tuple(start[i] for i in reversed(range(rank)))
        
        size = tuple(end[i] * downsample_factor[i] for i in reversed(range(rank)))
        # size = tuple(end[i] for i in reversed(range(rank)))
        size = tuple(np.subtract(size, offset))
        
        # print(f'Start: {offset}')
        # print(f'End: {end}')
        # print(f'Size: {size}')
        # if self.volume_type == 'segmentation':
        #     subvol = self.dataset.load_seg(offset=offset, size=size,
        #                                    mag=1)
        # elif self.volume_type == 'image':
        #     subvol = self.dataset.load_raw(offset=offset, size=size,
        #                                mag=1)
        
        if np.all(downsample_factor == downsample_factor[0]):
            
            if self.volume_type == 'segmentation':
                subvol = self.dataset.load_seg(offset=offset, size=size,
                                        mag=downsample_factor[0], )

            elif self.volume_type == 'image':
                subvol = self.dataset.load_raw(offset=offset, size=size,
                                    mag=downsample_factor[0], )                                  
        
            else:
                raise ValueError('Subvolume is not of any supported volume_type')
        
        else:
            subvol = self.subvol_task(downsample_factor, offset, size, type=self.task_type)
        
        #     lowest_factor = np.min(downsample_factor)
        #     d2 = np.array([int(downsample_factor[i] / lowest_factor) for i in range(len(downsample_factor))])

        #     if self.volume_type == 'image':
        #         subvol = self.dataset.load_raw(offset=offset, size=size,
        #                                 mag=lowest_factor)
                
        #         subvol = downsample.downsample_with_averaging(subvol, d2)
        #     else:
        #         subvol = self.dataset.load_seg(offset=offset, size=size,
        #                                 mag=lowest_factor)

        #         subvol = downsample.downsample_with_striding(subvol, d2)

        # else:
        #     raise ValueError('Anisotropic downsampling factor requested')

        if subvol.dtype == 'float64':
            subvol = np.cast[np.float32](subvol)

        # if np.any(downsample_factor != 1):
        #     if self.volume_type == 'image':
        #         subvol = downsample.downsample_with_averaging(subvol, downsample_factor)
        #     else:
        #         subvol = downsample.downsample_with_striding(subvol, downsample_factor)

        content_type = 'application/octet-stream'
        
        if data_format == 'jpeg':
            data = encode_jpeg(subvol)
            content_type = 'image/jpeg'
        
        elif data_format == 'npz':
            data = encode_npz(subvol)
        
        elif data_format == 'raw':
            data = encode_raw(subvol)
        
        else:
            raise ValueError('Invalid data format requested.')
        
        return data, content_type


    def subvol_task(self, downsample_factor, offset, size, type):

        if type not in self.subvol_task_types:
            raise ValueError("'type' argument must be one of {}. Found '{}'".format(self.subvol_task_types, type))

        def tile_array(a, b0, b1, b2):
            r, c, h = a.shape                                    # number of rows/columns
            rs, cs, hs = a.strides                                # row/column strides 
            x = np.lib.stride_tricks.as_strided(a, (r, b0, c, b1), (rs, 0, cs, 0)) # view a as larger 4D array

            return x.reshape(r*b0, c*b1)

        if type == 'highest_then_upsample':
            highest_factor = np.max(downsample_factor)
            up_levels = np.where(downsample_factor == highest_factor, 1, highest_factor/downsample_factor)
            
            if self.volume_type == 'segmentation':
                subvol_isotropic = self.dataset.load_seg(offset=offset, size=size,
                                        mag=highest_factor,)

                subvol = ndimage.zoom(subvol_isotropic, up_levels, mode='nearest', order=0)
                # print(subvol.shape)


            elif self.volume_type == 'image':
                subvol_isotropic = self.dataset.load_raw(offset=offset, size=size,
                                    mag=highest_factor,)
                
                subvol = ndimage.zoom(subvol_isotropic, up_levels, mode='nearest', order=0)
                # print(subvol.shape)

        else:
            lowest_factor = np.min(downsample_factor)
            down_levels = np.where(downsample_factor == lowest_factor, 1, downsample_factor/lowest_factor)
            down_levels = np.cast[np.int](down_levels)

            if self.volume_type == 'segmentation':
                subvol_isotropic = self.dataset.load_seg(offset=offset, size=size,
                                        mag=lowest_factor)
                subvol = downsample.downsample_with_striding(subvol_isotropic, down_levels)

            elif self.volume_type == 'image':
                subvol_isotropic = self.dataset.load_raw(offset=offset, size=size,
                                    mag=lowest_factor)
                subvol = downsample.downsample_with_averaging(subvol_isotropic, down_levels)

        return subvol

    def buildMeshDict(self, object_id):
        """
        Handle the getter for mesh according to the object type of the LocalVolume

        :return: mesh dict {('num_vertices',) 'vertices', 'indices'}
        """
        mesh = {}

        #obj_type = 'sv'
        if self.obj_type == 'sv':
            try:
                mesh = self.backend.ssv_mesh(object_id)
            except:
                raise InvalidObjectIdForMesh(
                    'Precomputed mesh not available for ssv_id: {}'.format(object_id))
        #obj_type is 'mi'/'syn_ssv'/'sj'/'vc'
        else:
            try:
                obj_vert = self.backend.ssv_obj_vert(object_id, self.obj_type)
                obj_ind = self.backend.ssv_obj_ind(object_id, self.obj_type)
            except:
                raise InvalidObjectIdForMesh(
                    'Precomputed mesh not available for ssv_id: {}'.format(object_id))
            mesh['vertices'] = obj_vert['vert']
            mesh['indices'] = obj_ind['ind']

        return mesh

    def _get_flattened_mesh(self, mesh: dict):
        """
        Gets mesh for an id and encodes it according to single-resolution mesh from
        neuroglancer/src/neuroglancer/datasource/precomputed/meshes.md

        :param mesh: dict of {'num_vert', 'vertices', 'indices'}
                          (int32,optional) (float32)   (int64)

        :return: Python bytes() of [num_vert, vertices, indices]
        """

        vertices = np.array(mesh['vertices'], dtype=np.float32).reshape(-1, 3)[:, [2, 1, 0]] * 1e-9
        indices = np.array(mesh['indices'], dtype=np.uint32).reshape(-1, 3)
        num_vert = len(vertices)

        data = [
            np.uint32(num_vert),
            vertices,
            indices
        ]
        encoded_mesh = b''.join([array.tobytes('C') for array in data])

        return encoded_mesh

    def get_object_mesh(self, object_id):
        """
        Gets encoded mesh from the mesh generator

        :param object_id: int
        :return:
        """
        mesh_generator = self._get_mesh_generator()
        data = mesh_generator.get_mesh(object_id)

        if data is None:
            raise InvalidObjectIdForMesh()

        return data

    def get_object_mesh_precomputed(self, object_id):
        """
        Gets precomputed mesh from the SyConn backend and encodes it in bytes.

        :param object_id: int
        :return: bytes
        """
        mesh = self.buildMeshDict(object_id)
        encoded_mesh = self._get_flattened_mesh(mesh)

        return encoded_mesh

    def get_object_mesh_precomputed_experimental(self, object_id):
        """
        Gets precomputed meshes(cell mesh, mitochondria, synapses, vesticle clouds) for a specific object id from the SyConn backend and encodes it in bytes.
        :param object_id: int
        :return: bytes
        """
        cellMesh = self.buildMeshDict(object_id, 'sv')
        miMesh = self.buildMeshDict(object_id, 'mi')
        synMesh = self.buildMeshDict(object_id, 'syn_ssv')
        vcMesh = self.buildMeshDict(object_id, 'vc')
        encoded_mesh = self._get_flattened_mesh(cellMesh)
        encoded_mesh += self._get_flattened_mesh(miMesh)
        encoded_mesh += self._get_flattened_mesh(synMesh)
        encoded_mesh += self._get_flattened_mesh(vcMesh)
        self.backend.logger.info('Precomputed encoding of meshes done')

        return encoded_mesh

    def _get_mesh_generator(self):
        if self._mesh_generator is not None:
            return self._mesh_generator
        while True:
            with self._mesh_generator_lock:
                if self._mesh_generator is not None:
                    return self._mesh_generator
                if self._mesh_generator_pending is not None:
                    while self._mesh_generator is None:
                        self._mesh_generator_lock.wait()
                    if self._mesh_generator is not None:
                        return self._mesh_generator
                try:
                    from . import _neuroglancer
                except ImportError:
                    raise MeshImplementationNotAvailable()
                if not (self.rank == 3 and
                        (self.data_type == 'uint8' or self.data_type == 'uint16' or
                         self.data_type == 'uint32' or self.data_type == 'uint64')):
                    raise MeshesNotSupportedForVolume()
                pending_obj = object()
                self._mesh_generator_pending = pending_obj
            data = self.data
            new_mesh_generator = _neuroglancer.OnDemandObjectMeshGenerator(
                data.transpose(),
                self.dimensions.scales, np.zeros(3), **self._mesh_options)
            with self._mesh_generator_lock:
                if self._mesh_generator_pending is not pending_obj:
                    continue
                self._mesh_generator = new_mesh_generator
                self._mesh_generator_pending = False
                self._mesh_generator_lock.notify_all()
            return new_mesh_generator

    def __deepcopy__(self, memo):
        """Since this type is immutable, we don't need to deepcopy it.

        Actually deep copying would intefere with the use of deepcopy by JsonObjectWrapper.
        """
        return self

    def invalidate(self):
        """Mark the data invalidated.  Clients will refetch the volume."""
        with self._mesh_generator_lock:
            self._mesh_generator_pending = None
            self._mesh_generator = None
        self._dispatch_changed_callbacks()
