import numpy as np
import collections
import six
from . import random_token
from . import trackable_state

class MeshSource(trackable_state.ChangeNotifier):
    
    def __init__(self, dimensions, voxel_offset=None):
        super(MeshSource, self).__init__()
        self.dimensions = dimensions
        if voxel_offset is None:
            voxel_offset = np.zeros(dimensions.rank, dtype=np.float64)
        self.voxel_offset = voxel_offset
        self.token = random_token.make_random_token()

    def info(self):
        return dict(
            coordinateSpace=self.dimensions.to_json(),
            voxelOffset=self.voxel_offset,
        )

    def get_mesh(self, object_id):
        """Retrieves the encoded mesh corresponding to the specified `object_id`.

        @param object_id: uint64 object id.

        @returns The encoded mesh representing the vertices and triangles, or `None` if there is no
            corresponding mesh.
        """
        raise NotImplementedError

    def invalidate(self):
        """Mark the data invalidated.  Clients will refetch the data."""
        self._dispatch_changed_callbacks()
