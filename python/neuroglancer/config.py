class NeuroConfig(object):
    """Stores datasets, backends and npy arrays in memory when the
    server is launched. Created once per server execution"""
    
    _counter = 0

    def __init__(self):
        NeuroConfig._counter += 1
        self._id = NeuroConfig._counter

        self.entries = {
            "j0251": {
                "rag_flat_Jan2019_v2": {
                    "backend": None,
                    "segmentation": None,
                    "image": None,
                    "ssvs": None,
                    "celltypes": None,
                    "mis": None,
                    "sizes": None,
                    "neuron_partners": None,
                    "partner_axoness": None,
                    "partner_celltypes": None,
                    "syn_probs": None,
                    "syn_areas": None,
                    "rep_coords": None 
                },
                "rag_flat_Jan2019_v3": {
                    "backend": None,
                    "segmentation": None,
                    "image": None,
                    "ssvs": None,
                    "celltypes": None,
                    "mis": None,
                    "sizes": None,
                    "neuron_partners": None,
                    "partner_axoness": None,
                    "partner_celltypes": None,
                    "syn_probs": None,
                    "syn_areas": None,
                    "rep_coords": None 
                }
            }
        }

    def __getitem__(self, key):
        return self.entries[self.acquisition][self.version][key]

    def __setitem__(self, key, value):
        self.entries[self.acquisition][self.version][key] = value

    @property
    def id(self):
        return self._id

    @property
    def acquisition(self):
        return self._acquisition

    @acquisition.setter
    def acquisition(self, value):
        self._acquisition = value

    @property
    def version(self):
        return self._version

    @version.setter
    def version(self, value):
        self._version = value
        

def initialize_server():
    # server variables
    global global_server
    global_server = None

    # development mode
    global dev_environ
    dev_environ = None

    from syconn.reps import super_segmentation_dataset as ss
    from syconn.reps import segmentation as seg
    from syconn import global_params
    from syconn.analysis.backend import SyConnBackend
    from syconn.handler.logger import log_main as logger
    from knossos_utils import KnossosDataset
    import os

    global params
    root = "/ssdscratch/songbird"
    params = NeuroConfig()

    logger.info("Initializing SyConn backend and Knossos datasets for j0251_rag_flat_Jan2019_v2")

    params.acquisition = "j0251"
    params.version = "rag_flat_Jan2019_v2"

    global_params.wd = os.path.join(root, "j0251", "rag_flat_Jan2019_v2")
    ssd = ss.SuperSegmentationDataset(global_params.config.working_dir, sso_locking=False, sso_caching=True)
    sd = seg.SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["backend"] = SyConnBackend(global_params.config.working_dir, logger)
    params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset("/wholebrain/songbird/j0251/j0251_72_clahe2")

    logger.info("Initializing npy arrays for j0251_rag_flat_Jan2019_v2")
    params["ssvs"] = ssd.ssv_ids
    params["celltypes"] = ssd.load_numpy_data("celltype_cnn_e3")
    params["mis"] = ssd.load_numpy_data("mi")
    params["sizes"] = ssd.load_numpy_data("size")
    params["neuron_partners"] = sd.load_numpy_data("neuron_partners")
    params["partner_axoness"] = sd.load_numpy_data("partner_axoness")
    params["partner_celltypes"] = sd.load_numpy_data("partner_celltypes")
    params["syn_probs"] = sd.load_numpy_data("syn_prob")
    params["syn_areas"] = sd.load_numpy_data("mesh_area")
    params["rep_coords"] = sd.load_numpy_data("rep_coord")

    logger.info("Initializing SyConn backend and Knossos datasets for j0251_rag_flat_Jan2019_v3")

    params.version = "rag_flat_Jan2019_v3"
    global_params.wd = os.path.join(root, "j0251", "rag_flat_Jan2019_v3")
    ssd = ss.SuperSegmentationDataset(global_params.config.working_dir, sso_locking=False, sso_caching=True)
    sd = seg.SegmentationDataset(obj_type='syn_ssv', working_dir=global_params.config.working_dir)
    params["backend"] = SyConnBackend(global_params.config.working_dir, logger)
    params["segmentation"] = KnossosDataset(global_params.config.kd_seg_path)
    params["segmentation_path"] = global_params.config.kd_seg_path
    params["image"] = KnossosDataset("/wholebrain/songbird/j0251/j0251_72_clahe2")

    logger.info("Initializing npy arrays for j0251_rag_flat_Jan2019_v3")
    params["ssvs"] = ssd.ssv_ids
    params["celltypes"] = ssd.load_numpy_data("celltype_cnn_e3")
    params["mis"] = ssd.load_numpy_data("mi")
    params["sizes"] = ssd.load_numpy_data("size")
    params["neuron_partners"] = sd.load_numpy_data("neuron_partners")
    params["partner_axoness"] = sd.load_numpy_data("partner_axoness")
    params["partner_celltypes"] = sd.load_numpy_data("partner_celltypes")
    params["syn_probs"] = sd.load_numpy_data("syn_prob")
    params["syn_areas"] = sd.load_numpy_data("mesh_area")
    params["rep_coords"] = sd.load_numpy_data("rep_coord")

    # info files for precomputed sources
    global volume_info, segment_properties_info
    volume_info = {
        "@type": "neuroglancer_multiscale_volume",
        "type": None,
        "data_type": None,
        "num_channels": 1,
        "scales": [
            {
                "key": "1_1_1",
                "size": [27136, 27392, 15616],
                "resolution": [10, 10, 25],
                "chunk_sizes": [[64, 64, 64]],
                "encoding": "raw",
            },
            {
                "key": "2_2_2",
                "size": [13568, 13696, 7808],
                "resolution": [20, 20, 50],
                "chunk_sizes": [[64, 64, 64]],
                "encoding": "raw",
            },
            {
                "key": "4_4_4",
                "size": [6784, 6912, 3968],
                "resolution": [40, 40, 100],
                "chunk_sizes": [[64, 64, 64]],
                "encoding": "raw",
            },
            {
                "key": "8_8_8",
                "size": [3389, 3418, 1936],
                "resolution": [80, 80, 200],
                "chunk_sizes": [[64, 64, 64]],
                "encoding": "raw",
            },
            {
                "key": "16_16_16",
                "size": [1694, 1709, 968],
                "resolution": [160, 160, 400],
                "chunk_sizes": [[64, 64, 64]],
                "encoding": "raw",
            },
            {
                "key": "32_32_32",
                "size": [847, 854, 484],
                "resolution": [320, 320, 800],
                "chunk_sizes": [[64, 64, 64]],
                "encoding": "raw",
            },
            {
                "key": "64_64_64",
                "size": [423, 427, 242],
                "resolution": [640, 640, 1600],
                "chunk_sizes": [[64, 64, 64]],
                "encoding": "raw",
            }
        ]
    }

    segment_properties_info = {
        "@type": "neuroglancer_segment_properties",
        "inline": {
            "ids": None,
            "properties": [
                {
                    "id": "cell types",
                    "type": "tags",
                    "tags": None,
                    "values": None
                },
            ]
        }
    }