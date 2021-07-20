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
                 dataset,
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
        @param dataset: Knossos Dataset object, where all the server requests are handled
        @param downsampling: '3d' to use isotropic downsampling, '2d' to downsample separately in
            XY, XZ, and YZ, None to use no downsampling.
        @param task_type: Specifies whether to downsample or upsample in function 'get_encoded_subvolume'
        @param object_type: Type of data the LocalVolume holds ('sv', 'mi', 'sj', 'vc', ...)
        @param volume_type: either 'image' or 'segmentation'.  If not specified, guessed from the
            data type.
        @param max_downsampling: Maximum amount by which on-the-fly downsampling may reduce the
            volume of a chunk.  For example, 4x4x4 downsampling reduces the volume by 64.
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
        self.shape = [boundaries[2], boundaries[1], boundaries[0]]  # data.shape

        rank = self.rank = len(self.shape)

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
            self.data_type = 'uint8'

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
            raise ValueError('Invalid downsampling task type, should be one of {}'.format(
                self.subvol_task_types))

        self.task_type = task_type
        self._precomputed_mesh = precomputedMesh
        self._mesh_generator = None
        self._mesh_generator_pending = None
        self._mesh_generator_lock = threading.Condition()
        self._mesh_options = mesh_options.copy() if mesh_options is not None else dict()
        self.obj_type = object_type
        
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
    def precomputed_mesh(self):

        return self._precomputed_mesh

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
        '''
        Gets a chunk of the whole volume with desired downsampling

        :param data_format:
        :param start:
        :param end:
        :param scale_key: downsampling sizes
        :return: downsampled subvolume chunk
        '''

        rank = self.rank

        # print(data_format, self.volume_type)

        if len(start) != rank or len(end) != rank:
            raise ValueError('Invalid request')

        downsample_factor = np.array(scale_key.split(','), dtype=np.int64)

        if (len(downsample_factor) != rank or np.any(downsample_factor < 1)
            or np.any(downsample_factor > self.max_downsampling)
            or np.prod(downsample_factor) > self.max_downsampling):
            raise ValueError('Invalid downsampling factor.')

        downsampled_shape = np.cast[np.int64](np.ceil(self.shape / downsample_factor))

        if np.any(end < start) or np.any(start < 0) or np.any(end > downsampled_shape):
            raise ValueError('Out of bounds data request.')

        offset = tuple(start[i] * downsample_factor[i] for i in reversed(range(rank)))

        size = tuple(end[i] * downsample_factor[i] for i in reversed(range(rank)))
        size = tuple(np.subtract(size, offset))
        # print(f'{self.volume_type} mags: {self.dataset.available_mags}')

        #scales = downsample_scales.compute_two_dimensional_near_isotropic_downsampling_scales(size, self.voxel_offset)
        # print(f'Scales {downsample_factor}')

        # isotropic downsampling
        if np.all(downsample_factor == downsample_factor[0]):
            #print('Isotropic downsampling')

            if downsample_factor[0] in self.dataset.available_mags:
                mag = downsample_factor[0]
            else:
                print('Isotropic downsampling: {} not available in available mags. Downsampling using highest mag {}'.format(np.max(self.dataset.available_mags)))
                mag = np.max(self.dataset.available_mags)

            if self.volume_type == 'segmentation':
                subvol = self.dataset.load_seg(offset=offset, size=size,
                                               mag=mag)

            elif self.volume_type == 'image':
                subvol = self.dataset.load_raw(offset=offset, size=size,
                                               mag=mag)
            else:
                raise ValueError('Subvolume is not of any supported volume_type')

        # enforce isotropic downsampling and adjust for non-isotropic dimensions
        else:
            #print('Anisotropic downsampling')
            if self.task_type == 'highest_then_upsample':
                highest_factor = np.max(downsample_factor)

                if highest_factor in self.dataset.available_mags:
                    mag = highest_factor
                    up_levels = np.where(downsample_factor == mag, 1, mag / downsample_factor)

                else:
                    print('Anisotropic downsampling: {} mag not available in available mags. Loading highest mag {}. Upsampling other dimensions!'.format(highest_factor, np.max(self.dataset.available_mags)))
                    mag = np.max(self.dataset.available_mags)
                    up_levels = mag / downsample_factor

                if self.volume_type == 'segmentation':
                    subvol_isotropic = self.dataset.load_seg(offset=offset, size=size,
                                                             mag=mag)

                    subvol = self.upsampling_with_repetition(subvol_isotropic, up_levels)


                elif self.volume_type == 'image':
                    subvol_isotropic = self.dataset.load_raw(offset=offset, size=size,
                                                             mag=mag)

                    subvol = self.upsampling_with_repetition(subvol_isotropic, up_levels)

            else:
                lowest_factor = np.min(downsample_factor)

                if lowest_factor in self.dataset.available_mags:
                    mag = lowest_factor
                    down_levels = np.where(downsample_factor == mag, 1, downsample_factor / mag)

                else:
                    print('Anisotropic downsampling: {} mag not available in available mags. Loading lowest mag {}. Downsampling other dimensions!'.format(lowest_factor, np.min(self.dataset.available_mags)))
                    mag = np.min(self.dataset.available_mags)
                    down_levels = downsample_factor / mag

                down_levels = np.cast[np.int](down_levels)

                if self.volume_type == 'segmentation':
                    subvol_isotropic = self.dataset.load_seg(offset=offset, size=size,
                                                             mag=mag)
                    subvol = downsample.downsample_with_striding(subvol_isotropic, down_levels)
                    
                elif self.volume_type == 'image':
                    subvol_isotropic = self.dataset.load_raw(offset=offset, size=size,
                                                             mag=mag)
                    subvol = downsample.downsample_with_averaging(subvol_isotropic, down_levels)

        if subvol.dtype == 'float64':
            subvol = np.cast[np.float32](subvol)

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

    def upsampling_with_repetition(self, subvol_isotropic, up_levels, mode='nearest', order=0):
        """
        Upsamples non-isotropic dimensions of subvolume. Default mode: nearest neighbor of order 0
        """
        return ndimage.zoom(subvol_isotropic, up_levels, mode=mode, order=order)

    def buildMeshDict(self, object_id):
        """
        Handle the getter for mesh according to the object type of the LocalVolume
        
        :param object_id: int 
        :return: dict ({'vertices': ..., 
                        'indices': ...})
        """
        mesh = {}

        # obj_type = 'sv'
        if self.obj_type == 'sv':
            try:
                mesh = self.backend.ssv_mesh(object_id)
            except:
                raise InvalidObjectIdForMesh(
                    'Precomputed mesh not available for ssv_id: {}'.format(object_id))
        # obj_type is 'mi'/'syn_ssv'/'sj'/'vc'
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

        :param mesh: dict ({'vertices': ..., 
                            'indices': ...})

        :return: bytes array ([num_vert, vertices, indices])
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
